import { concatHex, keccak256 } from "viem";
import type { BatchLeaf, ForecastObserved, Hex32 } from "./types.js";

const hashPair = (left: Hex32, right: Hex32): Hex32 => keccak256(concatHex([left, right]));

export interface MerkleBatch {
  root: Hex32;
  leaves: BatchLeaf[];
}

/** Ordered Merkle tree. Odd nodes are duplicated; proof direction comes from index bits. */
export function buildForecastBatch(records: ForecastObserved[]): MerkleBatch {
  if (records.length === 0) throw new Error("cannot build an empty batch");
  const sorted = [...records].sort((a, b) =>
    a.market_id === b.market_id
      ? a.commitment.localeCompare(b.commitment)
      : a.market_id.localeCompare(b.market_id),
  );
  const leaves = sorted.map((record) => record.commitment);
  const levels: Hex32[][] = [leaves];
  while (levels[levels.length - 1]!.length > 1) {
    const current = levels[levels.length - 1]!;
    const next: Hex32[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashPair(current[i]!, current[i + 1] ?? current[i]!));
    }
    levels.push(next);
  }

  const batchLeaves = sorted.map((record, originalIndex): BatchLeaf => {
    const proof: Hex32[] = [];
    let index = originalIndex;
    for (let level = 0; level < levels.length - 1; level++) {
      const nodes = levels[level]!;
      proof.push(nodes[index ^ 1] ?? nodes[index]!);
      index = Math.floor(index / 2);
    }
    return { market_id: record.market_id, commitment: record.commitment, index: originalIndex, proof };
  });

  return { root: levels[levels.length - 1]![0]!, leaves: batchLeaves };
}

export function verifyProof(root: Hex32, leaf: Hex32, proof: Hex32[], index: number): boolean {
  if (!Number.isSafeInteger(index) || index < 0) return false;
  let hash = leaf;
  let cursor = index;
  for (const sibling of proof) {
    hash = (cursor & 1) === 0 ? hashPair(hash, sibling) : hashPair(sibling, hash);
    cursor >>= 1;
  }
  return hash === root;
}
