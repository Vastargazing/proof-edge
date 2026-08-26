export type Hex32 = `0x${string}`;
export type ForecastSide = "YES" | "NO";
export type ResolvedOutcome = ForecastSide | "VOID";
export type ForecastAnchorStatus = "unanchored" | "on_time" | "anchored_late";

/**
 * Frozen v1 public preimage. Probability numbers are serialized by the
 * schema-aware canonicalizer with exactly four fractional digits.
 */
export interface ForecastPreimageV1 {
  v: 1;
  market_id: Hex32;
  venue_id: Hex32;
  symbol: string;
  interval_sec: number;
  /** Unix epoch nanoseconds as a decimal string; a JS number is unsafe here. */
  expiry_ns: string;
  p_agent: number;
  side: ForecastSide;
  p_market: number;
  model_hash: Hex32;
  evidence_digest: Hex32;
  /** Exactly 32 random bytes, 0x-prefixed lowercase hex. */
  nonce: Hex32;
}

export interface ModelManifestV1 {
  v: 1;
  estimator: string;
  code_commit: string;
  package_versions: Record<string, string>;
  runtime_versions?: Record<string, string>;
  config: Record<string, unknown>;
  prompt?: string;
}

export interface ForecastObserved {
  market_id: Hex32;
  observed_at_ns: string;
  preimage: ForecastPreimageV1;
  canonical_preimage: string;
  commitment: Hex32;
  /** Full reveal material. Absent only on the pre-v1 smoke batch. */
  evidence?: unknown;
}

export interface ForecastRiskDecision {
  market_id: Hex32;
  decided_at_ns: string;
  allowed: boolean;
  reason: "edge-band" | "below-edge" | "model-disagreement";
  absolute_edge_e4: number;
  risk_config_hash: Hex32;
}

export interface ForecastReveal {
  market_id: Hex32;
  revealed_at_ns: string;
  outcome: ResolvedOutcome;
}

export interface ForecastScore {
  market_id: Hex32;
  scored_at_ns: string;
  outcome: ForecastSide;
  brier_agent_e8: number;
  brier_market_e8: number;
}

export interface BatchLeaf {
  market_id: Hex32;
  commitment: Hex32;
  index: number;
  proof: Hex32[];
}

export interface BatchPrepared {
  batch_id: Hex32;
  root: Hex32;
  prepared_at_ns: string;
  /** Head of the local event chain immediately before this batch event. Forward-only; absent on legacy batches. */
  ledger_head?: Hex32;
  leaves: BatchLeaf[];
}

export interface BatchAnchored {
  batch_id: Hex32;
  root: Hex32;
  transaction_hash: Hex32;
  block_number: string;
  block_timestamp: string;
  gas_used: string;
  effective_gas_price: string;
  /** Ledger head emitted atomically with the Merkle root. Absent on legacy anchors. */
  ledger_head?: Hex32;
  /** Absent only on legacy events; current writers always persist timing explicitly. */
  status?: Exclude<ForecastAnchorStatus, "unanchored">;
  /** Leaves whose expiry was not strictly after the anchor block timestamp. */
  late_market_ids?: Hex32[];
}

/** Publication boundary sealed into the public copy of the append-only ledger. */
export interface PublicationWatermark {
  block_number: string;
  captured_at_ns: string;
  /** Head of the recorder ledger before this publication-only event. */
  source_ledger_head: Hex32;
  onchain_anchors: number;
  disclosed_roots: number;
  undisclosed_roots: number;
  pending_roots: number;
  failures: string[];
}

/** Self-contained public reveal derived from the recorder's frozen event format. */
export interface PublishedForecastEvidence {
  market_id: Hex32;
  /** Recorder observation timestamp; also used as the filename commit timestamp. */
  observed_at_ns: string;
  preimage: ForecastPreimageV1;
  canonical_preimage: string;
  commitment: Hex32;
  /** Full observation payload. Absent only on the documented pre-v1 smoke batch. */
  evidence?: unknown;
  /** Present on new publications; legacy v1 files are cross-checked against the published ledger. */
  risk_decision?: ForecastRiskDecision;
  /** Present on new publications; legacy v1 files obtain it from the disclosed ledger batch. */
  leaf_count?: number;
  leaf_index: number;
  merkle_proof: Hex32[];
  root: Hex32;
  anchor_tx: Hex32;
  anchor_block_timestamp: string;
  outcome: ResolvedOutcome;
  anchored_late: boolean;
}

export interface EvidenceManifestEntry {
  leaf_index: number;
  file: string;
  root: Hex32;
  anchor_tx: Hex32;
  anchored_late: boolean;
}

export interface EvidenceManifest {
  entries: EvidenceManifestEntry[];
  totals: {
    total: number;
    provable: number;
    anchored_late: number;
  };
}

export type LogEventData =
  | { type: "forecast_observed"; value: ForecastObserved }
  | { type: "forecast_risk_decision"; value: ForecastRiskDecision }
  | { type: "batch_prepared"; value: BatchPrepared }
  | { type: "batch_anchored"; value: BatchAnchored }
  | { type: "publication_watermark"; value: PublicationWatermark }
  | { type: "forecast_revealed"; value: ForecastReveal }
  | { type: "forecast_scored"; value: ForecastScore };

export interface LogEnvelope {
  seq: number;
  written_at_ns: string;
  prev_event_hash: Hex32;
  event: LogEventData;
  event_hash: Hex32;
}
