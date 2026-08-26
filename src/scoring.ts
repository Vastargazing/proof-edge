import type { ForecastAnchorStatus, ForecastScore, Hex32, ResolvedOutcome } from "./types.js";

const BRIER_SCALE = 100_000_000;
const DEFAULT_BOOTSTRAP_SEED = 0x5eedc0de;
const DEFAULT_BOOTSTRAP_RESAMPLES = 1_000;

export interface BrierSkillSummary {
  n: number;
  brier_agent: number | null;
  brier_market: number | null;
  /** 1 - BS(agent) / BS(market). Positive means the agent beat the frozen market snapshot. */
  skill_score: number | null;
}

export interface BootstrapInterval {
  low: number;
  high: number;
  confidence: 0.95;
  resamples: number;
  valid_resamples: number;
  seed: number;
}

export interface BrierSkillEstimate extends BrierSkillSummary {
  skill_score_ci_95: BootstrapInterval | null;
}

export interface ScoringSampleEstimate extends BrierSkillEstimate {
  mean_p_agent: number | null;
  mean_p_market: number | null;
  mean_probability_gap: number | null;
}

export interface ScoringRecord {
  market_id: Hex32;
  /** Read from the immutable forecast preimage; never inferred from current code or config. */
  model_hash: Hex32;
  p_agent: number;
  p_market: number;
  anchor_status: ForecastAnchorStatus;
  outcome?: ResolvedOutcome;
  score?: ForecastScore;
  /** The first immutable risk decision recorded for this forecast. */
  risk_allowed?: boolean;
}

export interface ResolveScoreReport {
  aggregation: "single_model" | "mixed_model_historical_total";
  all_evaluated_windows: ScoringSampleEstimate;
  risk_gate_passed: ScoringSampleEstimate;
  by_model_hash: Array<{
    model_hash: Hex32;
    all_evaluated_windows: ScoringSampleEstimate;
    risk_gate_passed: ScoringSampleEstimate;
  }>;
  exclusions: {
    anchored_late: number;
    unanchored: number;
    unresolved: number;
    voided: number;
    resolved_without_score: number;
    missing_risk_decision: number;
  };
  bootstrap: {
    resamples: number;
    confidence: 0.95;
    seed: number;
  };
}

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
}

export function aggregateBrierSkill(scores: readonly ForecastScore[]): BrierSkillSummary {
  if (scores.length === 0) {
    return { n: 0, brier_agent: null, brier_market: null, skill_score: null };
  }
  const agent = scores.reduce((sum, item) => sum + item.brier_agent_e8, 0) / scores.length / BRIER_SCALE;
  const market = scores.reduce((sum, item) => sum + item.brier_market_e8, 0) / scores.length / BRIER_SCALE;
  return {
    n: scores.length,
    brier_agent: agent,
    brier_market: market,
    skill_score: market === 0 ? null : 1 - agent / market,
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function bootstrapSkillScore(
  scores: readonly ForecastScore[],
  options: BootstrapOptions = {},
): BootstrapInterval | null {
  if (scores.length === 0) return null;
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const seed = (options.seed ?? DEFAULT_BOOTSTRAP_SEED) >>> 0;
  if (!Number.isInteger(resamples) || resamples <= 0) throw new Error("bootstrap resamples must be a positive integer");

  // The seeded resampler must receive a canonical population order. Otherwise
  // the same records in a differently ordered ledger consume the same PRNG
  // indices against different observations and produce a different interval.
  const orderedScores = [...scores].sort((a, b) => (
    a.market_id === b.market_id
      ? a.scored_at_ns.localeCompare(b.scored_at_ns)
      : a.market_id.localeCompare(b.market_id)
  ));
  const random = seededRandom(seed);
  const samples: number[] = [];
  for (let iteration = 0; iteration < resamples; iteration++) {
    let agent = 0;
    let market = 0;
    for (let index = 0; index < orderedScores.length; index++) {
      const item = orderedScores[Math.floor(random() * orderedScores.length)]!;
      agent += item.brier_agent_e8;
      market += item.brier_market_e8;
    }
    // A zero-loss baseline makes the ratio undefined. Keep that draw visible
    // through valid_resamples instead of inventing a finite skill value.
    if (market > 0) samples.push(1 - agent / market);
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  return {
    low: quantile(samples, 0.025),
    high: quantile(samples, 0.975),
    confidence: 0.95,
    resamples,
    valid_resamples: samples.length,
    seed,
  };
}

export function estimateBrierSkill(
  scores: readonly ForecastScore[],
  options: BootstrapOptions = {},
): BrierSkillEstimate {
  return {
    ...aggregateBrierSkill(scores),
    skill_score_ci_95: bootstrapSkillScore(scores, options),
  };
}

function estimateScoringSample(
  records: readonly ScoringRecord[],
  options: BootstrapOptions,
): ScoringSampleEstimate {
  const scores = records.map((record) => record.score!);
  if (records.length === 0) {
    return {
      ...estimateBrierSkill(scores, options),
      mean_p_agent: null,
      mean_p_market: null,
      mean_probability_gap: null,
    };
  }
  const meanAgent = records.reduce((sum, record) => sum + record.p_agent, 0) / records.length;
  const meanMarket = records.reduce((sum, record) => sum + record.p_market, 0) / records.length;
  return {
    ...estimateBrierSkill(scores, options),
    mean_p_agent: meanAgent,
    mean_p_market: meanMarket,
    mean_probability_gap: meanAgent - meanMarket,
  };
}

export function buildResolveScoreReport(
  records: readonly ScoringRecord[],
  options: BootstrapOptions = {},
): ResolveScoreReport {
  const eligible = records.filter((record) => (
    record.anchor_status === "on_time"
    && (record.outcome === "YES" || record.outcome === "NO")
    && record.score !== undefined
  ));
  const passed = eligible.filter((record) => record.risk_allowed === true);
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const seed = (options.seed ?? DEFAULT_BOOTSTRAP_SEED) >>> 0;
  const estimateOptions = { resamples, seed };
  const modelHashes = [...new Set(records.map((record) => record.model_hash))];

  return {
    aggregation: modelHashes.length > 1 ? "mixed_model_historical_total" : "single_model",
    all_evaluated_windows: estimateScoringSample(eligible, estimateOptions),
    risk_gate_passed: estimateScoringSample(passed, estimateOptions),
    by_model_hash: modelHashes.map((modelHash) => {
      const modelEligible = eligible.filter((record) => record.model_hash === modelHash);
      return {
        model_hash: modelHash,
        all_evaluated_windows: estimateScoringSample(modelEligible, estimateOptions),
        risk_gate_passed: estimateScoringSample(
          modelEligible.filter((record) => record.risk_allowed === true),
          estimateOptions,
        ),
      };
    }),
    exclusions: {
      anchored_late: records.filter((record) => record.anchor_status === "anchored_late").length,
      unanchored: records.filter((record) => record.anchor_status === "unanchored").length,
      unresolved: records.filter((record) => record.outcome === undefined).length,
      voided: records.filter((record) => record.outcome === "VOID").length,
      resolved_without_score: records.filter((record) => (
        record.anchor_status === "on_time"
        && (record.outcome === "YES" || record.outcome === "NO")
        && record.score === undefined
      )).length,
      missing_risk_decision: eligible.filter((record) => record.risk_allowed === undefined).length,
    },
    bootstrap: { resamples, confidence: 0.95, seed },
  };
}
