import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppendOnlyStore } from "./store.js";
import type { BatchPrepared, Hex32 } from "./types.js";

export const forecastRootEmitterAbi = [
  {
    type: "function",
    name: "anchorRoot",
    stateMutability: "nonpayable",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "leafCount", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "RootAnchored",
    inputs: [
      { name: "root", type: "bytes32", indexed: true },
      { name: "leafCount", type: "uint64", indexed: false },
      { name: "submitter", type: "address", indexed: true },
    ],
  },
] as const;

const shannon = (rpcUrl: string) =>
  defineChain({
    id: 50312,
    name: "Somnia Shannon",
    nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

export class EventOnlyAnchor {
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;
  private readonly chain;

  constructor(
    private readonly address: Address,
    private readonly privateKey: Hex32,
    rpcUrl = "https://api.infra.testnet.somnia.network",
  ) {
    this.chain = shannon(rpcUrl);
    this.account = privateKeyToAccount(privateKey);
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(rpcUrl) });
    this.walletClient = createWalletClient({ account: this.account, chain: this.chain, transport: http(rpcUrl) });
  }

  async anchor(batch: BatchPrepared, store: AppendOnlyStore): Promise<Hex32> {
    const hash = await this.walletClient.writeContract({
      address: this.address,
      abi: forecastRootEmitterAbi,
      functionName: "anchorRoot",
      args: [batch.root, BigInt(batch.leaves.length)],
      account: this.account,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`root anchor reverted: ${hash}`);
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    await store.addAnchoredBatch({
      batch_id: batch.batch_id,
      root: batch.root,
      transaction_hash: hash,
      block_number: receipt.blockNumber.toString(),
      block_timestamp: block.timestamp.toString(),
      gas_used: receipt.gasUsed.toString(),
      effective_gas_price: receipt.effectiveGasPrice.toString(),
    });
    return hash;
  }
}
