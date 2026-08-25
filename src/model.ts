import { canonicalHash } from "./canonical.js";
import type { Hex32, ModelManifestV1 } from "./types.js";

/** Hashes code identity, prompt, package versions, and every estimator knob. */
export function modelHash(manifest: ModelManifestV1): Hex32 {
  if (manifest.v !== 1) throw new Error("model manifest v must be 1");
  if (!manifest.estimator.trim()) throw new Error("estimator is required");
  if (!manifest.code_commit.trim()) throw new Error("code_commit is required");
  return canonicalHash(manifest);
}

export function evidenceDigest(evidence: unknown): Hex32 {
  return canonicalHash(evidence);
}
