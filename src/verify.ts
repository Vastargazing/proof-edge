import { commitmentFor } from "./canonical.js";
import { verifyProof } from "./merkle.js";
import type { BatchAnchored, BatchLeaf, ForecastPreimageV1 } from "./types.js";

/** Verifies reveal bytes, Merkle inclusion, and that the anchor block preceded expiry. */
export function verifyReveal(
  preimage: ForecastPreimageV1,
  leaf: BatchLeaf,
  anchor: BatchAnchored,
): boolean {
  const commitment = commitmentFor(preimage);
  if (commitment !== leaf.commitment) return false;
  if (anchor.root !== anchor.batch_id) return false;
  if (!verifyProof(anchor.root, commitment, leaf.proof, leaf.index)) return false;
  return BigInt(anchor.block_timestamp) * 1_000_000_000n < BigInt(preimage.expiry_ns);
}
