import { useMemoize } from "@vueuse/core";
import { Wallet } from "zksync-ethers";
import IL1AssetRouter from "zksync-ethers/abi/IL1AssetRouter.json";
// import IL1SharedBridge from "zksync-ethers/abi/IL1SharedBridge.json";
import IL1Nullifier from "zksync-ethers/abi/IL1Nullifier.json";

import { useSentryLogger } from "../useSentryLogger";

import type { Hash } from "@/types";
import type { PublicClient } from "viem";

export default (transactionInfo: ComputedRef<TransactionInfo>) => {
  const status = ref<"not-started" | "processing" | "waiting-for-signature" | "sending" | "done">("not-started");
  const error = ref<Error | undefined>();
  const transactionHash = ref<Hash | undefined>();
  const onboardStore = useOnboardStore();
  const providerStore = useZkSyncProviderStore();
  const tokensStore = useZkSyncTokensStore();
  const { isCorrectNetworkSet } = storeToRefs(onboardStore);
  const { ethToken } = storeToRefs(tokensStore);
  const { captureException } = useSentryLogger();

  const retrieveBridgeAddresses = useMemoize(() => providerStore.requestProvider().getDefaultBridgeAddresses());

  const retrieveChainId = useMemoize(() =>
    providerStore
      .requestProvider()
      .getNetwork()
      .then((network) => network.chainId)
  );

  const gasLimit = ref<bigint | undefined>();
  const gasPrice = ref<bigint | undefined>();
  const finalizeWithdrawalParams = ref<
    | {
        l1BatchNumber: unknown;
        l2MessageIndex: unknown;
        l2TxNumberInBlock: unknown;
        message: unknown;
        proof: unknown;
      }
    | undefined
  >();

  const totalFee = computed(() => {
    if (!gasLimit.value || !gasPrice.value) return undefined;
    return calculateFee(gasLimit.value, gasPrice.value).toString();
  });
  const feeToken = computed(() => {
    return ethToken;
  });

  const getFinalizationParams = async () => {
    const provider = providerStore.requestProvider();
    const wallet = new Wallet(
      // random private key cause we don't care about actual signer
      // finalizeWithdrawalParams method only exists on Wallet class
      "0x7726827caac94a7f9e1b160f7ea819f172f7b6f9d2a97f992c38edeab82d4110",
      provider
    );
    const { l1BatchNumber, l2MessageIndex, l2TxNumberInBlock, message, proof ,sender} = await wallet.finalizeWithdrawalParams(
      transactionInfo.value.transactionHash
    );
    const chainId = await retrieveChainId();

    const actualParams = {
      chainId,
      l2BatchNumber: l1BatchNumber,
      l2MessageIndex,
      l2Sender: sender,
      l2TxNumberInBatch: l2TxNumberInBlock,
      message,
      merkleProof:proof,
    };

    return {
      actualParams,
      chainId,
      l1BatchNumber,
      l2MessageIndex,
      l2TxNumberInBlock,
      message,
      proof,
      sender,
    };
  };



  const getNullifierAddress = async (publicClient: PublicClient):Promise<string>=> {
   
    const nullifierAddress = await publicClient.readContract({
      abi: IL1AssetRouter,
      functionName: "L1_NULLIFIER",
      address: (await retrieveBridgeAddresses()).sharedL1 as Hash,
    });


    return nullifierAddress as string;
  };

  const getTransactionParams = async (nullifierAddress:string) => {
    const params = await getFinalizationParams();
    finalizeWithdrawalParams.value = params;
    return {
      address:nullifierAddress as Hash,
      abi: IL1Nullifier,
      account: onboardStore.account.address!,
      functionName: "finalizeDeposit",
      args: [params.actualParams!],
    };
  };

  const {
    inProgress: estimationInProgress,
    error: estimationError,
    execute: estimateFee,
  } = usePromise(
    async () => {
      tokensStore.requestTokens();
      const publicClient = onboardStore.getPublicClient();

     const nullifierAddress =  await getNullifierAddress(publicClient);
      const transactionParams = await getTransactionParams(nullifierAddress);
      const [price, limit] = await Promise.all([
        retry(async () => BigInt((await publicClient.getGasPrice()).toString())),
        retry(async () => {
          return BigInt(
            (
              await publicClient.estimateContractGas({
                ...transactionParams,
              })
            ).toString()
          );
        }),
      ]);

      gasPrice.value = price;
      gasLimit.value = limit;

      return {
        transactionParams,
        gasPrice: gasPrice.value,
        gasLimit: gasLimit.value,
      };
    },
    { cache: 1000 * 8 }
  );

  const commitTransaction = async () => {
    try {
      error.value = undefined;

      status.value = "processing";
      if (!isCorrectNetworkSet.value) {
        await onboardStore.setCorrectNetwork();
      }
      const wallet = await onboardStore.getWallet();
      const { transactionParams, gasLimit, gasPrice } = (await estimateFee())!;
      status.value = "waiting-for-signature";
      transactionHash.value = await wallet.writeContract({
        ...transactionParams,
        gasPrice: BigInt(gasPrice.toString()),
        gas: BigInt(gasLimit.toString()),
      });

      status.value = "sending";
      const receipt = await retry(() =>
        onboardStore.getPublicClient().waitForTransactionReceipt({
          hash: transactionHash.value!,
          onReplaced: (replacement) => {
            transactionHash.value = replacement.transaction.hash;
          },
        })
      );

     
      status.value = "done";
      return receipt;
    } catch (err) {
      error.value = formatError(err as Error);
      status.value = "not-started";
      captureException({
        error: err as Error,
        parentFunctionName: "commitTransaction",
        parentFunctionParams: [],
        filePath: "composables/zksync/useWithdrawalFinalization.ts",
      });
    }
  };

  return {
    estimationError,
    estimationInProgress,
    totalFee,
    feeToken,
    estimateFee,

    status,
    error,
    transactionHash,
    commitTransaction,
  };
};
