import { validatePublishedEvidence } from "./evidence.js";
import { verifyProof } from "./merkle.js";
import type { Hex32, PublishedForecastEvidence } from "./types.js";

export type EvidenceVerificationStatus = "PASS" | "NOT PROVABLE" | "FAIL";

export interface ChainAnchor {
  roots: Hex32[];
  /** Unix block timestamp in seconds, as returned by the chain RPC. */
  blockTimestamp: bigint;
}

export type ChainAnchorReader = (transactionHash: Hex32) => Promise<ChainAnchor>;

export interface EvidenceVerificationStep {
  step: 1 | 2 | 3 | 4;
  status: EvidenceVerificationStatus;
  message: string;
}

export interface EvidenceVerificationResult {
  status: EvidenceVerificationStatus;
  steps: EvidenceVerificationStep[];
}

const failure = (
  steps: EvidenceVerificationStep[],
  step: EvidenceVerificationStep["step"],
  error: unknown,
): EvidenceVerificationResult => ({
  status: "FAIL",
  steps: [...steps, {
    step,
    status: "FAIL",
    message: error instanceof Error ? error.message : String(error),
  }],
});

/** Runs the four public verification steps without recorder or ledger state. */
export async function verifyPublishedEvidence(
  evidence: PublishedForecastEvidence,
  readAnchor: ChainAnchorReader,
): Promise<EvidenceVerificationResult> {
  const steps: EvidenceVerificationStep[] = [];
  let leaf: Hex32;
  try {
    leaf = validatePublishedEvidence(evidence);
    steps.push({ step: 1, status: "PASS", message: `canonical preimage -> ${leaf}` });
  } catch (error) {
    return failure(steps, 1, error);
  }

  try {
    if (!verifyProof(evidence.root, leaf, evidence.merkle_proof, evidence.leaf_index)) {
      throw new Error("Merkle proof does not produce the published root");
    }
    steps.push({ step: 2, status: "PASS", message: `Merkle proof -> ${evidence.root}` });
  } catch (error) {
    return failure(steps, 2, error);
  }

  let blockTimestamp: bigint;
  try {
    const anchor = await readAnchor(evidence.anchor_tx);
    if (!anchor.roots.includes(evidence.root)) {
      throw new Error(`on-chain root does not match ${evidence.root}`);
    }
    if (anchor.blockTimestamp.toString() !== evidence.anchor_block_timestamp) {
      throw new Error(
        `chain block timestamp ${anchor.blockTimestamp} does not match file ${evidence.anchor_block_timestamp}`,
      );
    }
    blockTimestamp = anchor.blockTimestamp;
    steps.push({
      step: 3,
      status: "PASS",
      message: `anchor tx emitted root at block timestamp ${blockTimestamp}`,
    });
  } catch (error) {
    return failure(steps, 3, error);
  }

  try {
    const anchorTimestampNs = blockTimestamp * 1_000_000_000n;
    const expiryNs = BigInt(evidence.preimage.expiry_ns);
    const late = anchorTimestampNs >= expiryNs;
    if (late !== evidence.anchored_late) {
      throw new Error(`anchored_late marker is ${evidence.anchored_late}, derived value is ${late}`);
    }
    if (late) {
      steps.push({
        step: 4,
        status: "NOT PROVABLE",
        message: `anchor_ns ${anchorTimestampNs} is not before expiry_ns ${expiryNs}`,
      });
      return { status: "NOT PROVABLE", steps };
    }
    steps.push({
      step: 4,
      status: "PASS",
      message: `anchor_ns ${anchorTimestampNs} < expiry_ns ${expiryNs}`,
    });
    return { status: "PASS", steps };
  } catch (error) {
    return failure(steps, 4, error);
  }
}
