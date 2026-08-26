import { resolve } from "node:path";
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  type Address,
} from "viem";
import { analyzeCompleteness, type OnchainRootAnchor } from "../src/completeness.js";
import {
  LEDGER_HEAD_EMITTER_ADDRESS,
  LEGACY_EMITTER_ADDRESS,
  rootAnchoredEvent,
  rootAnchoredWithLedgerHeadEvent,
} from "../src/emitter.js";
import { AppendOnlyStore } from "../src/store.js";
import type { Hex32 } from "../src/types.js";

const DEFAULT_RPC = "https://api.infra.testnet.somnia.network";
const DEFAULT_SUBMITTER = "0x2624F4553d622f0310c4a47D36aCFC1388dac365";
// Blocks 471035563..471035785 contain the documented emitter gas benchmark:
// ten synthetic roots with leafCount 1..10 from the same deployment wallet.
// Production anchoring starts after that closed interval.
const DEFAULT_FROM_BLOCK = 471_035_786n;
const LEDGER_HEAD_EMITTER_FROM_BLOCK = 471_812_148n;
const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC;
const submitter = getAddress(process.env.SUBMITTER_ADDRESS ?? DEFAULT_SUBMITTER);
const fromBlock = BigInt(process.env.COMPLETENESS_FROM_BLOCK ?? DEFAULT_FROM_BLOCK);
const configuredEmitters = process.env.EMITTER_ADDRESSES ?? process.env.EMITTER_ADDRESS;
const emitterPeriods: Array<{ address: Address; fromBlock: bigint }> = configuredEmitters
  ? configuredEmitters.split(",").map((address) => ({ address: getAddress(address.trim()), fromBlock }))
  : [
    { address: getAddress(LEGACY_EMITTER_ADDRESS), fromBlock },
    { address: getAddress(LEDGER_HEAD_EMITTER_ADDRESS), fromBlock: LEDGER_HEAD_EMITTER_FROM_BLOCK },
  ];
const configuredToBlock = process.env.COMPLETENESS_TO_BLOCK;
const chunkSize = BigInt(process.env.COMPLETENESS_BLOCK_CHUNK ?? 1_000);
const concurrency = Number(process.env.COMPLETENESS_RPC_CONCURRENCY ?? 10);
if (fromBlock < 0n) throw new Error("COMPLETENESS_FROM_BLOCK must be non-negative");
if (chunkSize <= 0n || chunkSize > 1_000n) {
  throw new Error("COMPLETENESS_BLOCK_CHUNK must be between 1 and the public RPC limit of 1000");
}
if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > 50) {
  throw new Error("COMPLETENESS_RPC_CONCURRENCY must be an integer between 1 and 50");
}

const chain = defineChain({
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const toBlock = configuredToBlock === undefined ? await client.getBlockNumber() : BigInt(configuredToBlock);
if (toBlock < fromBlock) throw new Error("COMPLETENESS_TO_BLOCK must be at least COMPLETENESS_FROM_BLOCK");

async function readAnchors(address: Address): Promise<OnchainRootAnchor[]> {
  const anchors: OnchainRootAnchor[] = [];
  const ranges: Array<{ emitter: Address; start: bigint; end: bigint }> = [];
  for (const period of emitterPeriods) {
    for (let start = period.fromBlock; start <= toBlock; start += chunkSize) {
      const end = start + chunkSize - 1n < toBlock ? start + chunkSize - 1n : toBlock;
      ranges.push({ emitter: period.address, start, end });
    }
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, async () => {
    while (cursor < ranges.length) {
      const range = ranges[cursor++]!;
      const [legacyLogs, ledgerHeadLogs] = await Promise.all([
        client.getLogs({
          address: range.emitter,
          event: rootAnchoredEvent,
          args: { submitter: address },
          fromBlock: range.start,
          toBlock: range.end,
          strict: true,
        }),
        client.getLogs({
          address: range.emitter,
          event: rootAnchoredWithLedgerHeadEvent,
          args: { submitter: address },
          fromBlock: range.start,
          toBlock: range.end,
          strict: true,
        }),
      ]);
      for (const log of [...legacyLogs, ...ledgerHeadLogs]) {
        if (!log.transactionHash || log.blockNumber === null) {
          throw new Error(`incomplete RootAnchored log for root ${log.args.root}`);
        }
        anchors.push({
          root: log.args.root,
          leafCount: log.args.leafCount,
          transactionHash: log.transactionHash as Hex32,
          blockNumber: log.blockNumber,
        });
      }
    }
  }));
  return anchors.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0);
}

const file = resolve(process.env.RECORDER_STORE ?? "published/forecast-events.jsonl");
const store = await AppendOnlyStore.open(file);
const report = analyzeCompleteness(await readAnchors(submitter), store.preparedBatches());
const failures = [
  ...report.undisclosed.map((anchor) =>
    `undisclosed root ${anchor.root} leaf_count=${anchor.leafCount} tx=${anchor.transactionHash}`),
  ...report.duplicateRootAnchors.map((item) =>
    `root anchored multiple times ${item.root} txs=${item.transactions.join(",")}`),
  ...report.leafCountMismatches.map((item) =>
    `leaf count mismatch ${item.root} chain=${item.chain} ledger=${item.ledger}`),
  ...report.overlappingWindows.map((item) =>
    `window appears in multiple disclosed roots ${item.marketId} roots=${item.roots.join(",")}`),
  ...report.ledgerRootsMissingOnchain.map((root) => `ledger root missing on-chain ${root}`),
];

console.log(JSON.stringify({
  file,
  emitter_periods: emitterPeriods.map((period) => ({
    address: period.address,
    from_block: period.fromBlock.toString(),
  })),
  submitter,
  from_block: fromBlock.toString(),
  to_block: toBlock.toString(),
  excluded_benchmark_period: fromBlock === DEFAULT_FROM_BLOCK ? {
    from_block: "471035563",
    to_block: "471035785",
    roots: 10,
    reason: "synthetic emitter gas benchmark with leafCount 1..10",
  } : null,
  onchain_anchors: report.onchainAnchors,
  unique_onchain_roots: report.uniqueOnchainRoots,
  disclosed_roots: report.disclosedRoots,
  undisclosed_roots: report.undisclosed.length,
  undisclosed: report.undisclosed.map((anchor) => ({
    root: anchor.root,
    leaf_count: anchor.leafCount.toString(),
    transaction_hash: anchor.transactionHash,
    block_number: anchor.blockNumber.toString(),
  })),
  duplicate_root_anchors: report.duplicateRootAnchors,
  leaf_count_mismatches: report.leafCountMismatches,
  overlapping_disclosed_windows: report.overlappingWindows,
  ledger_roots_missing_onchain: report.ledgerRootsMissingOnchain,
  limitation: "an undisclosed root exposes only root and leafCount; its window membership cannot be derived from the v1 event",
  failures,
}, null, 2));
if (failures.length > 0) process.exitCode = 1;
