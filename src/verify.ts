import { commitmentFor } from "./canonical.js";
import { verifyProof } from "./merkle.js";
import type { BatchAnchored, BatchLeaf, ForecastPreimage } from "./types.js";

/** Verifies reveal bytes and Merkle inclusion without making a timing claim. */
export function verifyCommitmentInclusion(
  preimage: ForecastPreimage,
  leaf: BatchLeaf,
  anchor: BatchAnchored,
): boolean {
  const commitment = commitmentFor(preimage);
  if (commitment !== leaf.commitment) return false;
  if (anchor.root !== anchor.batch_id) return false;
  if (!verifyProof(anchor.root, commitment, leaf.proof, leaf.index, leaf.merkle_version ?? 1)) return false;
  return true;
}

export function anchorPrecedesExpiry(preimage: ForecastPreimage, anchor: BatchAnchored): boolean {
  return BigInt(anchor.block_timestamp) * 1_000_000_000n < BigInt(preimage.expiry_ns);
}

/** Verifies reveal bytes, Merkle inclusion, and that the anchor block preceded expiry. */
export function verifyReveal(
  preimage: ForecastPreimage,
  leaf: BatchLeaf,
  anchor: BatchAnchored,
): boolean {
  return verifyCommitmentInclusion(preimage, leaf, anchor) && anchorPrecedesExpiry(preimage, anchor);
}
