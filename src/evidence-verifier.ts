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

export interface ChainMarket {
  marketId: Hex32;
  /** Authoritative market expiry in Unix seconds. */
  expiry: bigint;
  winningOutcome: number;
  isResolved: boolean;
  isVoided: boolean;
}

export type ChainMarketReader = (marketId: Hex32) => Promise<ChainMarket>;

export interface EvidenceVerificationStep {
  step: 1 | 2 | 3 | 4 | 5;
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

/** Runs the five public verification steps without recorder or ledger state. */
export async function verifyPublishedEvidence(
  evidence: PublishedForecastEvidence,
  readAnchor: ChainAnchorReader,
  readMarket: ChainMarketReader,
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

  let onchainExpiryNs: bigint;
  try {
    const market = await readMarket(evidence.market_id);
    if (market.marketId !== evidence.market_id) {
      throw new Error(`market_id mismatch: chain ${market.marketId}, file ${evidence.market_id}`);
    }
    onchainExpiryNs = market.expiry * 1_000_000_000n;
    const fileExpiryNs = BigInt(evidence.preimage.expiry_ns);
    if (onchainExpiryNs !== fileExpiryNs) {
      throw new Error(`expiry_ns mismatch: chain ${onchainExpiryNs}, file ${fileExpiryNs}`);
    }
    const chainOutcome = market.isVoided
      ? "VOID"
      : market.isResolved
        ? market.winningOutcome === 0 ? "YES" : market.winningOutcome === 1 ? "NO" : null
        : null;
    if (chainOutcome === null) {
      throw new Error(`outcome mismatch: market ${evidence.market_id} is not resolved to YES, NO, or VOID on-chain`);
    }
    if (chainOutcome !== evidence.outcome) {
      throw new Error(`outcome mismatch: chain ${chainOutcome}, file ${evidence.outcome}`);
    }
    steps.push({
      step: 4,
      status: "PASS",
      message: `on-chain market ${market.marketId} expiry_ns ${onchainExpiryNs} outcome ${chainOutcome}`,
    });
  } catch (error) {
    return failure(steps, 4, error instanceof Error
      ? new Error(`on-chain market check failed for ${evidence.market_id}: ${error.message}`)
      : error);
  }

  try {
    const anchorTimestampNs = blockTimestamp * 1_000_000_000n;
    const late = anchorTimestampNs >= onchainExpiryNs;
    if (late !== evidence.anchored_late) {
      throw new Error(`anchored_late marker is ${evidence.anchored_late}, derived value is ${late}`);
    }
    if (late) {
      steps.push({
        step: 5,
        status: "NOT PROVABLE",
        message: `anchor_ns ${anchorTimestampNs} is not before on-chain expiry_ns ${onchainExpiryNs}`,
      });
      return { status: "NOT PROVABLE", steps };
    }
    steps.push({
      step: 5,
      status: "PASS",
      message: `anchor_ns ${anchorTimestampNs} < on-chain expiry_ns ${onchainExpiryNs}`,
    });
    return { status: "PASS", steps };
  } catch (error) {
    return failure(steps, 5, error);
  }
}
