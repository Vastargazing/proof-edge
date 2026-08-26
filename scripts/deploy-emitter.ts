import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compileEmitter } from "./lib/contract.js";

const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) throw new Error("PRIVATE_KEY is required");
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
const compiled = await compileEmitter();
const hash = await walletClient.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode, account });
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deployment failed: ${hash}`);
const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
console.log(JSON.stringify({
  network: "shannon",
  variant: "event-only-ledger-head-v2",
  chainId: chain.id,
  deployer: account.address,
  address: receipt.contractAddress,
  transactionHash: hash,
  blockNumber: receipt.blockNumber.toString(),
  blockTimestamp: block.timestamp.toString(),
  gasUsed: receipt.gasUsed.toString(),
  effectiveGasPrice: receipt.effectiveGasPrice.toString(),
  feeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
}, null, 2));
