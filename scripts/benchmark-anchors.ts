import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { forecastRootRegistryAbi } from "../src/registry.js";

const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const address = process.env.REGISTRY_ADDRESS as `0x${string}` | undefined;
if (!privateKey) throw new Error("PRIVATE_KEY is required");
if (!address) throw new Error("REGISTRY_ADDRESS is required");
const rpcUrl = process.env.RPC_URL ?? "https://api.infra.testnet.somnia.network";
const chain = defineChain({
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const startedAt = new Date().toISOString();
const samples: Array<Record<string, string | number>> = [];

for (let index = 0; index < 10; index++) {
  const root = keccak256(toBytes(`somnia-recorder-anchor-benchmark:${startedAt}:${index}`));
  const hash = await walletClient.writeContract({
    address,
    abi: forecastRootRegistryAbi,
    functionName: "anchorRoot",
    args: [root, BigInt(index + 1)],
    account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`anchor ${index} reverted: ${hash}`);
  samples.push({
    index,
    root,
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    feeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
  });
}

const gas = samples.map((sample) => BigInt(sample.gasUsed as string));
const fees = samples.map((sample) => BigInt(sample.feeWei as string));
const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
console.log(JSON.stringify({
  registry: address,
  wallet: account.address,
  startedAt,
  samples,
  summary: {
    count: samples.length,
    minGas: gas.reduce((a, b) => (a < b ? a : b)).toString(),
    maxGas: gas.reduce((a, b) => (a > b ? a : b)).toString(),
    meanGas: (sum(gas) / BigInt(gas.length)).toString(),
    totalFeeWei: sum(fees).toString(),
    meanFeeWei: (sum(fees) / BigInt(fees.length)).toString(),
  },
}, null, 2));
