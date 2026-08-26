import { concatHex, keccak256 } from "viem";
import type { BatchLeaf, ForecastObserved, Hex32 } from "./types.js";

const LEAF_DOMAIN = "0x00" as const;
const NODE_DOMAIN = "0x01" as const;
const hashLeaf = (leaf: Hex32, version: 1 | 2): Hex32 =>
  version === 1 ? leaf : keccak256(concatHex([LEAF_DOMAIN, leaf]));
const hashPair = (left: Hex32, right: Hex32, version: 1 | 2): Hex32 =>
  keccak256(version === 1 ? concatHex([left, right]) : concatHex([NODE_DOMAIN, left, right]));

export interface MerkleBatch {
  root: Hex32;
  leaves: BatchLeaf[];
  merkleVersion: 1 | 2;
}

/** Ordered Merkle tree. Odd nodes are duplicated; proof direction comes from index bits. */
export function buildForecastBatch(records: ForecastObserved[]): MerkleBatch {
  if (records.length === 0) throw new Error("cannot build an empty batch");
  const sorted = [...records].sort((a, b) =>
    a.market_id === b.market_id
      ? a.commitment.localeCompare(b.commitment)
      : a.market_id.localeCompare(b.market_id),
  );
  const versions = new Set(sorted.map((record) => record.preimage.v));
  if (versions.size !== 1) throw new Error("cannot mix v1 and v2 forecasts in one Merkle batch");
  const merkleVersion = sorted[0]!.preimage.v;
  const leaves = sorted.map((record) => hashLeaf(record.commitment, merkleVersion));
  const levels: Hex32[][] = [leaves];
  while (levels[levels.length - 1]!.length > 1) {
    const current = levels[levels.length - 1]!;
    const next: Hex32[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashPair(current[i]!, current[i + 1] ?? current[i]!, merkleVersion));
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
    return {
      market_id: record.market_id,
      commitment: record.commitment,
      index: originalIndex,
      proof,
      ...(merkleVersion === 2 ? { merkle_version: 2 as const } : {}),
    };
  });

  return { root: levels[levels.length - 1]![0]!, leaves: batchLeaves, merkleVersion };
}

export function verifyProof(
  root: Hex32,
  leaf: Hex32,
  proof: Hex32[],
  index: number,
  version: 1 | 2 = 1,
): boolean {
  if (!Number.isSafeInteger(index) || index < 0) return false;
  let hash = hashLeaf(leaf, version);
  let cursor = index;
  for (const sibling of proof) {
    hash = (cursor & 1) === 0 ? hashPair(hash, sibling, version) : hashPair(sibling, hash, version);
    cursor >>= 1;
  }
  return hash === root;
}
