/**
 * Anchor lead time: how long before its market's on-chain expiry a forecast's
 * Merkle root was mined.
 *
 *     lead_sec = expiry_ns / 1e9 - anchor_block_timestamp
 *
 * Step 5 of the frozen verifier answers one binary question — was the anchor
 * strictly before expiry (`src/evidence-verifier.ts:172-193`)? It does not say
 * by how much, so an anchor one block before expiry and one an hour before
 * produce the same `PASS`. This module measures that margin and names a thin
 * one `LOW_LEAD`.
 *
 * `LOW_LEAD` is an ANNOTATION, never a verdict. It is computed outside
 * `src/evidence-verifier.ts` (frozen into the recorder's `model_hash`,
 * `docs/RUNBOOK.md` § "Frozen until 2026-09-08"), it is never consulted by the
 * verifier, and it cannot turn a `PASS` into anything else. Every record that
 * verifies today verifies identically with this module loaded; the threshold is
 * not applied retroactively to any published verdict.
 *
 * Both the CLI (`scripts/verify-evidence.ts`) and the browser panel
 * (`dashboard/app/verify-chain-browser.ts`) render these exact strings, so the
 * two surfaces cannot report different lead times or different thresholds.
 */
import type { Hex32, PublishedForecastEvidence } from "../../src/types.js";

const NANOS_PER_SECOND = 1_000_000_000n;
const DECIMAL = /^\d+$/;

/**
 * Default minimum anchor lead, in seconds. Measured, not chosen for roundness.
 *
 * Over the 2,256 files in `evidence/` on the 2026-08-31 snapshot, every one of
 * which carries an anchor block timestamp and none of which is anchored late,
 * the lead distribution is min 44 s, median 286 s, max 86,382 s. It is strongly
 * multi-modal because a lead is bounded above by the market interval: the
 * 5-minute markets (1,326 records, 58.8%) sit at a median of 280 s, the
 * 15-minute markets (660 records) at 876 s, the hourly ones (206 records) at
 * 3,573 s.
 *
 * The whole low tail, sorted, is 44, 55, 55, 56, 62, 68, 71, then 92. That
 * 21-second hole between 71 and 92 is the widest empty band anywhere below
 * 300 s — nearly twice the next widest (11 s, 44 to 55) and more than twice the
 * widest gap in the 100-300 s region (10 s). Any threshold in [72, 91] therefore
 * partitions the archive identically, at 7 records (0.310%), so 90 is the
 * middle of the only real gap in the data rather than a number that felt right.
 *
 * The alternatives were measured too: < 120 s flags 15 records (0.665%),
 * < 180 s flags 38 (1.684%), < 240 s flags 77 (3.413%), and < 300 s flags 1,330
 * (58.954%) — the entire 5-minute operating mode. A threshold near the bulk
 * would report market cadence, not anchoring discipline. At 90 s every flagged
 * record is a 5-minute market; the 15-minute, hourly, 4-hour and daily classes
 * contribute none, so no cadence is systematically accused.
 *
 * 90 s is also 5x the 99th-percentile observe-to-anchor latency of 17 s (median
 * 3 s). All seven flagged records have an observe-to-anchor latency of 1-11 s:
 * they were observed that close to expiry, not anchored slowly. That is exactly
 * the condition worth warning about — the forecast had little unknown left to
 * predict — and it is a statement about the observation, not about the chain.
 */
export const DEFAULT_MIN_ANCHOR_LEAD_SEC = 90;

/** Why a lead time could not be computed. Never a verdict, never a failure. */
export type AnchorLeadUnavailable =
  | "missing_anchor_block_timestamp"
  | "malformed_anchor_block_timestamp"
  | "missing_expiry_ns"
  | "malformed_expiry_ns"
  | "lead_out_of_safe_range";

export interface AnchorLeadAnnotation {
  /** Seconds between the anchor block timestamp and expiry; null when unknown. */
  lead_sec: number | null;
  threshold_sec: number;
  /** True only when the lead is known, positive and strictly below the threshold. */
  low: boolean;
  reason: AnchorLeadUnavailable | null;
  /** Informational line, always present. Printed beside step 5, never inside it. */
  line: string;
  /** The `LOW_LEAD` warning line, or null. Visibly a warning, never a verdict. */
  warning: string | null;
}

/**
 * Reads `MIN_ANCHOR_LEAD_SEC`. A non-negative integer number of seconds; `0`
 * disables the warning without disabling the reported lead time.
 */
export function resolveMinAnchorLeadSec(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_ANCHOR_LEAD_SEC;
  const trimmed = raw.trim();
  if (!DECIMAL.test(trimmed)) {
    throw new Error(`MIN_ANCHOR_LEAD_SEC must be a non-negative integer number of seconds, got ${raw}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) throw new Error(`MIN_ANCHOR_LEAD_SEC ${raw} is out of range`);
  return value;
}

function parseDecimal(value: string | undefined | null): bigint | null {
  if (typeof value !== "string" || !DECIMAL.test(value.trim())) return null;
  return BigInt(value.trim());
}

/**
 * Lead in whole seconds from a block timestamp in seconds and an expiry in
 * nanoseconds, both as decimal strings. Truncates toward negative infinity so a
 * sub-second late anchor reports a negative lead rather than rounding to zero.
 */
export function anchorLeadSeconds(
  anchorBlockTimestampSec: string | undefined | null,
  expiryNs: string | undefined | null,
): { lead: bigint | null; reason: AnchorLeadUnavailable | null } {
  if (anchorBlockTimestampSec === undefined || anchorBlockTimestampSec === null || anchorBlockTimestampSec === "") {
    return { lead: null, reason: "missing_anchor_block_timestamp" };
  }
  const anchorSec = parseDecimal(anchorBlockTimestampSec);
  if (anchorSec === null) return { lead: null, reason: "malformed_anchor_block_timestamp" };
  if (expiryNs === undefined || expiryNs === null || expiryNs === "") {
    return { lead: null, reason: "missing_expiry_ns" };
  }
  const expiry = parseDecimal(expiryNs);
  if (expiry === null) return { lead: null, reason: "malformed_expiry_ns" };

  const anchorNs = anchorSec * NANOS_PER_SECOND;
  const differenceNs = expiry - anchorNs;
  // Floor division, so -0.4 s is -1 s and never 0 s.
  const lead = differenceNs >= 0n
    ? differenceNs / NANOS_PER_SECOND
    : -((-differenceNs + NANOS_PER_SECOND - 1n) / NANOS_PER_SECOND);
  if (lead > BigInt(Number.MAX_SAFE_INTEGER) || lead < BigInt(Number.MIN_SAFE_INTEGER)) {
    return { lead: null, reason: "lead_out_of_safe_range" };
  }
  return { lead, reason: null };
}

/** `3171` -> `52m51s`. No spaces, so the whole line stays key=value parseable. */
export function formatLeadSeconds(seconds: number): string {
  const magnitude = Math.abs(seconds);
  const hours = Math.floor(magnitude / 3600);
  const minutes = Math.floor((magnitude % 3600) / 60);
  const rest = magnitude % 60;
  const parts = hours > 0
    ? [`${hours}h`, `${minutes}m`, `${rest}s`]
    : minutes > 0 ? [`${minutes}m`, `${rest}s`] : [`${rest}s`];
  return `${seconds < 0 ? "-" : ""}${parts.join("")}`;
}

/**
 * Builds the annotation from an already-computed lead.
 *
 * A lead of zero or less is not `LOW_LEAD`: that record is anchored at or after
 * expiry, which step 5 already reports as `NOT PROVABLE`. The warning exists for
 * records that pass step 5 on a thin margin, so it never competes with a verdict.
 */
export function describeAnchorLead(
  lead: bigint | null,
  reason: AnchorLeadUnavailable | null,
  thresholdSec: number,
): AnchorLeadAnnotation {
  if (lead === null) {
    return {
      lead_sec: null,
      threshold_sec: thresholdSec,
      low: false,
      reason: reason ?? "missing_anchor_block_timestamp",
      line: `ANCHOR_LEAD lead_sec=null threshold_sec=${thresholdSec} reason=${reason ?? "missing_anchor_block_timestamp"}`,
      warning: null,
    };
  }
  const leadSec = Number(lead);
  const human = formatLeadSeconds(leadSec);
  const low = leadSec > 0 && leadSec < thresholdSec;
  return {
    lead_sec: leadSec,
    threshold_sec: thresholdSec,
    low,
    reason: null,
    line: `ANCHOR_LEAD lead_sec=${leadSec} lead=${human} threshold_sec=${thresholdSec}`,
    warning: low
      ? `WARNING LOW_LEAD lead_sec=${leadSec} lead=${human} is below threshold_sec=${thresholdSec}; this is an annotation, not a verdict`
      : null,
  };
}

/** The annotation for one public evidence file. */
export function evidenceAnchorLead(
  evidence: Pick<PublishedForecastEvidence, "anchor_block_timestamp" | "preimage">,
  thresholdSec: number = DEFAULT_MIN_ANCHOR_LEAD_SEC,
): AnchorLeadAnnotation {
  const { lead, reason } = anchorLeadSeconds(
    evidence.anchor_block_timestamp,
    evidence.preimage?.expiry_ns,
  );
  return describeAnchorLead(lead, reason, thresholdSec);
}

/** The lines to print beside step 5: the measurement, then the warning if any. */
export function anchorLeadLines(annotation: AnchorLeadAnnotation): string[] {
  return annotation.warning === null ? [annotation.line] : [annotation.line, annotation.warning];
}

export interface AnchorLeadStats {
  threshold_sec: number;
  /** Anchored forecasts whose lead was computable. */
  n: number;
  /** Anchored forecasts whose anchor timestamp or expiry could not be read. */
  n_unavailable: number;
  min_sec: number | null;
  /** Nearest-rank percentiles: index `ceil(p * n) - 1` of the ascending sample. */
  p01_sec: number | null;
  p05_sec: number | null;
  p10_sec: number | null;
  /** Mean of the two middle values when `n` is even. */
  median_sec: number | null;
  max_sec: number | null;
  /** Records with `0 < lead < threshold`, the population `LOW_LEAD` annotates. */
  below_threshold: number;
  /** Records anchored at or after expiry; already `NOT PROVABLE` at step 5. */
  not_before_expiry: number;
}

function nearestRank(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/**
 * Distribution of anchor lead over a sample. Published beside the verdict totals
 * so a reader can see how much margin the archive actually had, instead of only
 * that every record cleared zero.
 */
export function summarizeAnchorLeads(
  leads: readonly number[],
  thresholdSec: number = DEFAULT_MIN_ANCHOR_LEAD_SEC,
  unavailable = 0,
): AnchorLeadStats {
  const sorted = [...leads].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n === 0
    ? null
    : n % 2 === 1
      ? sorted[(n - 1) / 2]!
      : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  return {
    threshold_sec: thresholdSec,
    n,
    n_unavailable: unavailable,
    min_sec: n === 0 ? null : sorted[0]!,
    p01_sec: nearestRank(sorted, 0.01),
    p05_sec: nearestRank(sorted, 0.05),
    p10_sec: nearestRank(sorted, 0.1),
    median_sec: median,
    max_sec: n === 0 ? null : sorted[n - 1]!,
    below_threshold: sorted.filter((lead) => lead > 0 && lead < thresholdSec).length,
    not_before_expiry: sorted.filter((lead) => lead <= 0).length,
  };
}

/**
 * The subset of `AppendOnlyStore` this module reads. Structural rather than the
 * class itself, so the browser bundle never pulls `src/store.ts` and its
 * `node:fs` imports through this shared module.
 */
export interface AnchorLeadLedgerView {
  preparedBatches(): readonly { batch_id: Hex32; leaves: readonly { market_id: Hex32 }[] }[];
  anchoredBatch(batchId: Hex32): { block_timestamp: string } | undefined;
  forecast(marketId: Hex32): { preimage: { expiry_ns: string } } | undefined;
}

/**
 * Every anchored forecast in the ledger, one lead each. Unanchored forecasts are
 * omitted rather than counted as zero: they have no anchor to measure from, and
 * the snapshot already reports them under `totals.unanchored_forecasts`.
 */
export function anchorLeadsFromLedger(
  store: AnchorLeadLedgerView,
): { leads: number[]; unavailable: number } {
  const leads: number[] = [];
  let unavailable = 0;
  for (const batch of store.preparedBatches()) {
    const anchor = store.anchoredBatch(batch.batch_id);
    if (!anchor) continue;
    for (const leaf of batch.leaves) {
      const forecast = store.forecast(leaf.market_id);
      const { lead } = anchorLeadSeconds(anchor.block_timestamp, forecast?.preimage.expiry_ns);
      if (lead === null) unavailable += 1;
      else leads.push(Number(lead));
    }
  }
  return { leads, unavailable };
}
