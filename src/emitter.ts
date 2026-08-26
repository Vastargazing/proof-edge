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
  {
    type: "function",
    name: "anchorRootWithLedgerHead",
    stateMutability: "nonpayable",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "leafCount", type: "uint64" },
      { name: "ledgerHead", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "RootAnchoredWithLedgerHead",
    inputs: [
      { name: "root", type: "bytes32", indexed: true },
      { name: "leafCount", type: "uint64", indexed: false },
      { name: "ledgerHead", type: "bytes32", indexed: false },
      { name: "submitter", type: "address", indexed: true },
    ],
  },
] as const;

export const rootAnchoredEvent = forecastRootEmitterAbi[1];
export const rootAnchoredWithLedgerHeadEvent = forecastRootEmitterAbi[3];

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

  async balance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  async anchor(batch: BatchPrepared, store: AppendOnlyStore): Promise<Hex32> {
    const hash = batch.ledger_head === undefined
      ? await this.walletClient.writeContract({
        address: this.address,
        abi: forecastRootEmitterAbi,
        functionName: "anchorRoot",
        args: [batch.root, BigInt(batch.leaves.length)],
        account: this.account,
      })
      : await this.walletClient.writeContract({
        address: this.address,
        abi: forecastRootEmitterAbi,
        functionName: "anchorRootWithLedgerHead",
        args: [batch.root, BigInt(batch.leaves.length), batch.ledger_head],
        account: this.account,
      });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`root anchor reverted: ${hash}`);
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const anchorNs = block.timestamp * 1_000_000_000n;
    const lateMarketIds = batch.leaves.flatMap((leaf) => {
      const forecast = store.forecast(leaf.market_id);
      if (!forecast) throw new Error(`batch references missing forecast ${leaf.market_id}`);
      return anchorNs >= BigInt(forecast.preimage.expiry_ns) ? [leaf.market_id] : [];
    });
    await store.addAnchoredBatch({
      batch_id: batch.batch_id,
      root: batch.root,
      transaction_hash: hash,
      block_number: receipt.blockNumber.toString(),
      block_timestamp: block.timestamp.toString(),
      gas_used: receipt.gasUsed.toString(),
      effective_gas_price: receipt.effectiveGasPrice.toString(),
      ledger_head: batch.ledger_head,
      status: lateMarketIds.length > 0 ? "anchored_late" : "on_time",
      late_market_ids: lateMarketIds,
    });
    return hash;
  }
}
