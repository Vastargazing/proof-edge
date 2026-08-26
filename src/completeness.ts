import type { BatchPrepared, Hex32 } from "./types.js";

export interface OnchainRootAnchor {
  root: Hex32;
  leafCount: bigint;
  transactionHash: Hex32;
  blockNumber: bigint;
}

export interface CompletenessReport {
  onchainAnchors: number;
  uniqueOnchainRoots: number;
  disclosedRoots: number;
  undisclosed: OnchainRootAnchor[];
  duplicateRootAnchors: Array<{ root: Hex32; transactions: Hex32[] }>;
  leafCountMismatches: Array<{ root: Hex32; chain: string; ledger: number }>;
  overlappingWindows: Array<{ marketId: Hex32; roots: Hex32[] }>;
  ledgerRootsMissingOnchain: Hex32[];
}

export interface WatermarkedCompletenessReport extends CompletenessReport {
  watermarkBlock: bigint;
  pending: OnchainRootAnchor[];
}

export function analyzeWatermarkedCompleteness(
  anchors: readonly OnchainRootAnchor[],
  batches: readonly BatchPrepared[],
  watermarkBlock: bigint,
): WatermarkedCompletenessReport {
  const pending = anchors.filter((anchor) => anchor.blockNumber > watermarkBlock);
  const scoped = anchors.filter((anchor) => anchor.blockNumber <= watermarkBlock);
  return { ...analyzeCompleteness(scoped, batches), watermarkBlock, pending };
}

export function completenessFailures(report: CompletenessReport): string[] {
  return [
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
}

/** Pure comparison used by the CLI and regression tests. */
export function analyzeCompleteness(
  anchors: readonly OnchainRootAnchor[],
  batches: readonly BatchPrepared[],
): CompletenessReport {
  const batchByRoot = new Map(batches.map((batch) => [batch.root, batch]));
  const anchorsByRoot = new Map<Hex32, OnchainRootAnchor[]>();
  for (const anchor of anchors) {
    const existing = anchorsByRoot.get(anchor.root) ?? [];
    existing.push(anchor);
    anchorsByRoot.set(anchor.root, existing);
  }

  const undisclosed = anchors.filter((anchor) => !batchByRoot.has(anchor.root));
  const leafCountMismatches = [...anchorsByRoot.entries()].flatMap(([root, rootAnchors]) => {
    const batch = batchByRoot.get(root);
    if (!batch) return [];
    const counts = [...new Set(rootAnchors.map((anchor) => anchor.leafCount.toString()))];
    return counts
      .filter((count) => BigInt(count) !== BigInt(batch.leaves.length))
      .map((count) => ({ root, chain: count, ledger: batch.leaves.length }));
  });

  const rootsByMarket = new Map<Hex32, Set<Hex32>>();
  for (const batch of batches) {
    for (const leaf of batch.leaves) {
      const roots = rootsByMarket.get(leaf.market_id) ?? new Set<Hex32>();
      roots.add(batch.root);
      rootsByMarket.set(leaf.market_id, roots);
    }
  }

  return {
    onchainAnchors: anchors.length,
    uniqueOnchainRoots: anchorsByRoot.size,
    disclosedRoots: [...anchorsByRoot.keys()].filter((root) => batchByRoot.has(root)).length,
    undisclosed,
    duplicateRootAnchors: [...anchorsByRoot.entries()]
      .filter(([, entries]) => entries.length > 1)
      .map(([root, entries]) => ({ root, transactions: entries.map((entry) => entry.transactionHash) })),
    leafCountMismatches,
    overlappingWindows: [...rootsByMarket.entries()]
      .filter(([, roots]) => roots.size > 1)
      .map(([marketId, roots]) => ({ marketId, roots: [...roots].sort() })),
    ledgerRootsMissingOnchain: batches
      .filter((batch) => !anchorsByRoot.has(batch.root))
      .map((batch) => batch.root)
      .sort(),
  };
}
