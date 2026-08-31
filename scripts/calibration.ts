import type { ScoringRecord } from "../src/scoring.js";
import type { AppendOnlyStore } from "../src/store.js";
import type { Hex32 } from "../src/types.js";

/** Standard normal 97.5th percentile. The Wilson bounds need it in closed form. */
const Z_95 = 1.959963984540054;

/**
 * Decimal bin edges, compared directly instead of scaling the probability by
 * ten. Neither 0.1 nor 0.7 is representable, so `Math.floor(p * 10)` is a
 * rounding argument about doubles; comparing the sealed four-digit value with
 * the double nearest each edge is not.
 */
const BIN_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;
const BIN_COUNT = BIN_EDGES.length - 1;

export interface CalibrationBin {
  index: number;
  lower: number;
  /** The last bin is closed: exactly 1.0 falls in [0.9, 1.0], not past it. */
  upper: number;
  n: number;
  mean_predicted: number | null;
  /** Share of sealed outcomes equal to 1 (YES). Null only when the bin is empty. */
  observed_frequency: number | null;
  wilson_low: number | null;
  wilson_high: number | null;
}

export interface CalibrationSeries {
  agent: CalibrationBin[];
  market: CalibrationBin[];
}

export interface CalibrationReport {
  all_evaluated_windows: CalibrationSeries;
  current_model: { model_hash: Hex32 | null } & CalibrationSeries;
}

/**
 * Wilson score interval for a binomial proportion, closed form. Chosen over the
 * normal approximation because reliability bins run small and land at 0 and 1,
 * where the normal interval reports zero width.
 */
export function wilsonInterval(successes: number, n: number): { low: number; high: number } {
  if (!Number.isInteger(n) || n <= 0) throw new Error("wilson interval needs a positive integer sample size");
  if (!Number.isInteger(successes) || successes < 0 || successes > n) throw new Error("successes must be an integer in [0, n]");
  const observed = successes / n;
  const zz = Z_95 * Z_95;
  const denominator = 1 + zz / n;
  const center = (observed + zz / (2 * n)) / denominator;
  const margin = (Z_95 / denominator) * Math.sqrt((observed * (1 - observed)) / n + zz / (4 * n * n));
  // The closed form already lies inside [0, 1]; the clamp only removes
  // floating-point dust at the endpoints, where center and margin cancel.
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function binIndex(probability: number): number {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`probability ${probability} is outside [0, 1]`);
  }
  let index = 0;
  while (index < BIN_COUNT - 1 && probability >= BIN_EDGES[index + 1]!) index++;
  return index;
}

function emptyBin(index: number): CalibrationBin {
  return {
    index,
    lower: BIN_EDGES[index]!,
    upper: BIN_EDGES[index + 1]!,
    n: 0,
    mean_predicted: null,
    observed_frequency: null,
    wilson_low: null,
    wilson_high: null,
  };
}

/**
 * Ten equal bins, always all ten. An empty bin is reported with n: 0 rather
 * than dropped, so a reader cannot mistake an unvisited region of the
 * probability scale for one the estimator never entered.
 */
export function binSeries(
  points: readonly { probability: number; outcome: 0 | 1 }[],
): CalibrationBin[] {
  const buckets: { probability: number; outcome: 0 | 1 }[][] = Array.from({ length: BIN_COUNT }, () => []);
  for (const point of points) buckets[binIndex(point.probability)]!.push(point);
  return buckets.map((bucket, index) => {
    if (bucket.length === 0) return emptyBin(index);
    const successes = bucket.reduce((sum, point) => sum + point.outcome, 0);
    const interval = wilsonInterval(successes, bucket.length);
    return {
      ...emptyBin(index),
      n: bucket.length,
      mean_predicted: bucket.reduce((sum, point) => sum + point.probability, 0) / bucket.length,
      observed_frequency: successes / bucket.length,
      wilson_low: interval.low,
      wilson_high: interval.high,
    };
  });
}

/**
 * The same eligibility test `buildResolveScoreReport` applies
 * (`src/scoring.ts:189-193`): anchored before expiry, resolved to a side, and
 * scored. It is duplicated rather than imported because `src/` is frozen; the
 * sum-of-n assertion in `test/calibration.test.ts` fails if the two drift.
 */
function isEvaluated(record: ScoringRecord): boolean {
  return record.anchor_status === "on_time"
    && (record.outcome === "YES" || record.outcome === "NO")
    && record.score !== undefined;
}

function seriesFor(records: readonly ScoringRecord[]): CalibrationSeries {
  const outcomes = records.map((record) => ({ record, outcome: (record.outcome === "YES" ? 1 : 0) as 0 | 1 }));
  return {
    agent: binSeries(outcomes.map(({ record, outcome }) => ({ probability: record.p_agent, outcome }))),
    market: binSeries(outcomes.map(({ record, outcome }) => ({ probability: record.p_market, outcome }))),
  };
}

export function buildCalibrationReport(records: readonly ScoringRecord[]): CalibrationReport {
  const evaluated = records.filter(isEvaluated);
  // Distinct hashes in ledger order, so the last element is the same current
  // version the snapshot's by_model_hash ends with (`src/scoring.ts:198,204`).
  const currentModelHash = [...new Set(records.map((record) => record.model_hash))].at(-1) ?? null;
  return {
    all_evaluated_windows: seriesFor(evaluated),
    current_model: {
      model_hash: currentModelHash,
      ...seriesFor(evaluated.filter((record) => record.model_hash === currentModelHash)),
    },
  };
}

/**
 * Rebuilds the record list `store.resolveScoreReport()` builds internally
 * (`src/store.ts:639-652`) from the store's public accessors. Both samples must
 * stay identical; nothing here selects, reweights or filters by outcome.
 */
export function scoringRecordsFrom(store: AppendOnlyStore): ScoringRecord[] {
  const scores = new Map(store.allScores().map((score) => [score.market_id, score]));
  return store.allForecasts().map((forecast) => ({
    market_id: forecast.market_id,
    model_hash: forecast.preimage.model_hash,
    p_agent: forecast.preimage.p_agent,
    p_market: forecast.preimage.p_market,
    anchor_status: store.forecastAnchorStatus(forecast.market_id),
    outcome: store.revealedOutcome(forecast.market_id),
    score: scores.get(forecast.market_id),
    risk_allowed: store.riskDecisionsFor(forecast.market_id).at(0)?.allowed,
  }));
}
