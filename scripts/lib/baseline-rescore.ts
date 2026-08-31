import { marketImpliedUp } from "../../vendor/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.js";
import { probabilityOnGrid } from "../../src/canonical.js";
import { estimateBrierSkill, type BootstrapOptions, type BrierSkillEstimate } from "../../src/scoring.js";
import type { ForecastScore, Hex32, PublishedForecastEvidence, ResolvedOutcome } from "../../src/types.js";

/** One disclosed order-book level, exactly as sealed: `[price, size]`. */
export type BookLevel = [price: number, size: number];

/** The three sealed YES levels per side from `evidence.yes_book`, best price first. */
export interface YesBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface SealedRecord {
  /** Evidence file name, used to name the record in every failure message. */
  file: string;
  market_id: Hex32;
  observed_at_ns: string;
  model_hash: Hex32;
  p_agent: number;
  /** The baseline inside the keccak commitment. Never recomputed, only compared against. */
  p_market: number;
  outcome: ResolvedOutcome;
  anchored_late: boolean;
  risk_allowed?: boolean;
  yes_book: YesBook;
}

export const BASELINE_NAMES = ["midpoint", "depth_weighted", "min_size"] as const;
export type BaselineName = (typeof BASELINE_NAMES)[number];

/**
 * Every disclosed best-level quote in `evidence/` is at or below 200, and 3,828
 * of 3,926 sit exactly on 200: the venue quotes a 200/330/460 ladder and the
 * remaining 98 top-level quotes are partial remnants of the 200 rung (1-6, or
 * 100-199.999). So 200 is the largest threshold that still admits a fully
 * quoted top of book: it demotes only the remnants. One tick higher, 201,
 * evicts the top rung of all 1,957 books that still have both sides and drops
 * the other 6 records entirely, which measures the ladder rather than the
 * market.
 */
export const DEFAULT_MIN_SIZE = 200;

const BRIER_SCALE = 100_000_000;

export interface BaselineOptions {
  /** Only read by `min_size`. */
  minSize: number;
}

/**
 * The recorder's own baseline, imported rather than restated: `marketImpliedUp`
 * is the function that produced every sealed `p_market_raw`
 * (`src/live-recorder.ts:226,247,262-263`,
 * `vendor/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.ts:311-317`).
 * Reimplementing it here would let this script and the recorder drift apart
 * while the self-test below still reported agreement.
 */
export function midpointBaseline(book: YesBook): number | null {
  return marketImpliedUp(book);
}

/**
 * Size-weighted price per side, then the plain midpoint of the two sides:
 *
 *   bid_vwap = sum(price_i * size_i) / sum(size_i)   over every disclosed bid level
 *   ask_vwap = sum(price_i * size_i) / sum(size_i)   over every disclosed ask level
 *   p        = (bid_vwap + ask_vwap) / 2
 *
 * Weighting stays inside each side. The sealed baseline averages the two sides
 * evenly, so weighting bids against asks would move the depth question and the
 * side-balance question at the same time and leave neither answered.
 */
export function depthWeightedBaseline(book: YesBook): number | null {
  const bid = sizeWeightedPrice(book.bids);
  const ask = sizeWeightedPrice(book.asks);
  if (bid === null || ask === null) return null;
  const mid = (bid + ask) / 2;
  return mid > 0 && mid < 1 ? mid : null;
}

function sizeWeightedPrice(levels: readonly BookLevel[]): number | null {
  let weighted = 0;
  let size = 0;
  for (const level of levels) {
    weighted += level[0] * level[1];
    size += level[1];
  }
  return size > 0 ? weighted / size : null;
}

/**
 * Midpoint over the best level on each side whose size is at least `minSize`.
 *
 *   p = (best_bid_with_size_ge_N + best_ask_with_size_ge_N) / 2
 *
 * Sealed levels arrive best-first and every book in `evidence/` holds that
 * order (1,963 files: no bid list out of descending order, no ask list out of
 * ascending order, no crossed top of book), so the first qualifying entry is
 * also the best qualifying price. A side with no qualifying level yields null
 * and the record leaves the sample; falling back to the top level would quietly
 * restore the very quote the threshold was meant to exclude.
 */
export function minSizeBaseline(book: YesBook, minSize: number): number | null {
  const bid = book.bids.find((level) => level[1] >= minSize);
  const ask = book.asks.find((level) => level[1] >= minSize);
  if (bid === undefined || ask === undefined) return null;
  const mid = (bid[0] + ask[0]) / 2;
  return mid > 0 && mid < 1 ? mid : null;
}

/** Raw baseline probability, before the 1e-4 grid. Null means "this book cannot price it". */
export function baselineProbability(
  name: BaselineName,
  book: YesBook,
  options: BaselineOptions,
): number | null {
  if (name === "midpoint") return midpointBaseline(book);
  if (name === "depth_weighted") return depthWeightedBaseline(book);
  return minSizeBaseline(book, options.minSize);
}

/**
 * The recorder's quantization, not a new one: the e8 integer Brier of
 * `src/live-recorder.ts:328`, re-derived and re-checked on every ledger load at
 * `src/store.ts:465-470`. A different rounding here would make the `midpoint`
 * row disagree with the sealed `forecast_scored` events for a reason that has
 * nothing to do with the baseline under test.
 */
export function brierE8(probability: number, observed: 0 | 1): number {
  return Math.round((probability - observed) ** 2 * BRIER_SCALE);
}

function requireNumber(value: unknown, file: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${file}: ${field} must be a finite number`);
  }
  return value;
}

function parseLevels(value: unknown, file: string, side: "bids" | "asks"): BookLevel[] {
  if (!Array.isArray(value)) throw new Error(`${file}: evidence.yes_book.${side} must be an array`);
  return value.map((level: unknown, index): BookLevel => {
    if (!Array.isArray(level) || level.length !== 2) {
      throw new Error(`${file}: evidence.yes_book.${side}[${index}] must be a [price, size] pair`);
    }
    const price = requireNumber(level[0], file, `evidence.yes_book.${side}[${index}][0]`);
    const size = requireNumber(level[1], file, `evidence.yes_book.${side}[${index}][1]`);
    return [price, size];
  });
}

/**
 * Reads only what a rescore needs, and refuses anything it does not recognise.
 * A malformed or bodyless file must stop the run: silently skipping it would
 * shrink N without saying so, which is the exact failure this script exists to
 * make impossible.
 */
export function parseSealedRecord(file: string, raw: unknown): SealedRecord {
  if (typeof raw !== "object" || raw === null) throw new Error(`${file}: not a JSON object`);
  const published = raw as PublishedForecastEvidence;
  const body = published.evidence;
  if (typeof body !== "object" || body === null) {
    throw new Error(`${file}: no retained evidence body, so its order book was never disclosed`);
  }
  const observation = body as { yes_book?: unknown };
  if (typeof observation.yes_book !== "object" || observation.yes_book === null) {
    throw new Error(`${file}: evidence.yes_book is missing`);
  }
  const book = observation.yes_book as { bids?: unknown; asks?: unknown };
  return {
    file,
    market_id: published.market_id,
    observed_at_ns: published.observed_at_ns,
    model_hash: published.preimage.model_hash,
    p_agent: requireNumber(published.preimage.p_agent, file, "preimage.p_agent"),
    p_market: requireNumber(published.preimage.p_market, file, "preimage.p_market"),
    outcome: published.outcome,
    anchored_late: published.anchored_late === true,
    risk_allowed: published.risk_decision?.allowed,
    yes_book: {
      bids: parseLevels(book.bids, file, "bids"),
      asks: parseLevels(book.asks, file, "asks"),
    },
  };
}

/**
 * The honesty self-test of the whole exercise. `midpoint` is not a new baseline,
 * it is the sealed one: recomputing it from `evidence.yes_book` has to land on
 * the `p_market` that is already inside the keccak commitment, for every record.
 * A divergence means the disclosed book and the disclosed probability no longer
 * describe the same observation, so it is raised, never rounded away.
 */
export function assertSealedMidpoint(records: readonly SealedRecord[]): number {
  for (const record of records) {
    const recomputed = midpointBaseline(record.yes_book);
    if (recomputed === null) {
      throw new Error(
        `${record.file}: midpoint self-test failed - the sealed book has no two-sided top of book, `
        + `yet the commitment seals p_market ${record.p_market}`,
      );
    }
    const onGrid = probabilityOnGrid(recomputed);
    if (!Object.is(onGrid, record.p_market)) {
      throw new Error(
        `${record.file}: midpoint self-test failed - the sealed book gives ${onGrid} `
        + `(raw ${recomputed}), the commitment seals p_market ${record.p_market}`,
      );
    }
  }
  return records.length;
}

export interface SkippedRecord {
  file: string;
  market_id: Hex32;
  reason: string;
}

export interface RescoreResult {
  baseline: BaselineName;
  /** Reported only for `min_size`; null keeps the table honest for the other two. */
  min_size: number | null;
  estimate: BrierSkillEstimate;
  scanned: number;
  eligible: number;
  exclusions: {
    anchored_late: number;
    voided: number;
  };
  skipped_by_baseline: SkippedRecord[];
}

/**
 * Same window selection as the published pipeline: an on-time anchor and a
 * YES/NO outcome (`src/scoring.ts:189-193`). An evidence file exists only for a
 * revealed forecast that carries a full body, so `anchored_late === false`
 * stands for `anchor_status === "on_time"` and the ledger's `unanchored` and
 * `resolved_without_score` classes cannot appear here at all.
 */
export function selectEligible(records: readonly SealedRecord[]): SealedRecord[] {
  return records.filter((record) => (
    !record.anchored_late && (record.outcome === "YES" || record.outcome === "NO")
  ));
}

export function rescoreAgainstBaseline(
  records: readonly SealedRecord[],
  options: { baseline: BaselineName; minSize?: number; bootstrap?: BootstrapOptions },
): RescoreResult {
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
  const eligible = selectEligible(records);
  const scores: ForecastScore[] = [];
  const skipped: SkippedRecord[] = [];

  for (const record of eligible) {
    const raw = baselineProbability(options.baseline, record.yes_book, { minSize });
    if (raw === null) {
      skipped.push({
        file: record.file,
        market_id: record.market_id,
        reason: options.baseline === "min_size"
          ? `no level of size >= ${minSize} on both sides`
          : "the sealed book cannot price this baseline",
      });
      continue;
    }
    const observed = record.outcome === "YES" ? 1 : 0;
    scores.push({
      market_id: record.market_id,
      // The ledger's own scoring timestamp is not disclosed in an evidence file.
      // The bootstrap orders by market_id first and forecasts are idempotent by
      // market_id (`src/store.ts:655-665`), so this tie-break is never consulted
      // and the interval is the same one the pipeline would produce.
      scored_at_ns: record.observed_at_ns,
      outcome: record.outcome === "YES" ? "YES" : "NO",
      brier_agent_e8: brierE8(record.p_agent, observed),
      brier_market_e8: brierE8(probabilityOnGrid(raw), observed),
    });
  }

  return {
    baseline: options.baseline,
    min_size: options.baseline === "min_size" ? minSize : null,
    estimate: estimateBrierSkill(scores, options.bootstrap ?? {}),
    scanned: records.length,
    eligible: eligible.length,
    exclusions: {
      anchored_late: records.filter((record) => record.anchored_late).length,
      voided: records.filter((record) => record.outcome === "VOID").length,
    },
    skipped_by_baseline: skipped,
  };
}
