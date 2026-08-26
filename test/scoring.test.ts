import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateBrierSkill,
  bootstrapSkillScore,
  buildResolveScoreReport,
} from "../src/scoring.js";
import type { ScoringRecord } from "../src/scoring.js";
import type { ForecastScore, Hex32 } from "../src/types.js";

const id = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const score = (market: number, agent: number, baseline: number): ForecastScore => ({
  market_id: id(market),
  scored_at_ns: "1",
  outcome: "YES",
  brier_agent_e8: agent,
  brier_market_e8: baseline,
});
const record = (
  market: number,
  model: number,
  pAgent: number,
  pMarket: number,
  item?: ForecastScore,
  overrides: Partial<ScoringRecord> = {},
): ScoringRecord => ({
  market_id: id(market),
  model_hash: id(model),
  p_agent: pAgent,
  p_market: pMarket,
  anchor_status: "on_time",
  outcome: "YES",
  score: item,
  risk_allowed: true,
  ...overrides,
});

test("Brier skill is positive when the agent beats the market baseline", () => {
  const result = aggregateBrierSkill([
    score(1, 4_000_000, 16_000_000),
    score(2, 9_000_000, 16_000_000),
  ]);
  assert.equal(result.n, 2);
  assert.equal(result.brier_agent, 0.065);
  assert.equal(result.brier_market, 0.16);
  assert.equal(result.skill_score, 0.59375);
});

test("Brier skill is negative when the agent is worse than the market baseline", () => {
  const result = aggregateBrierSkill([
    score(1, 36_000_000, 9_000_000),
    score(2, 25_000_000, 16_000_000),
  ]);
  assert.ok(result.skill_score! < 0);
});

test("Brier skill is zero when agent and market losses are identical", () => {
  const result = aggregateBrierSkill([
    score(1, 9_000_000, 9_000_000),
    score(2, 25_000_000, 25_000_000),
  ]);
  assert.ok(Math.abs(result.skill_score!) < 1e-12);
});

test("anchored-late records never enter either scoring sample", () => {
  const included = score(1, 4_000_000, 16_000_000);
  const late = score(2, 1_000_000, 49_000_000);
  const report = buildResolveScoreReport([
    record(1, 101, 0.8, 0.6, included),
    record(2, 101, 0.9, 0.3, late, { anchor_status: "anchored_late" }),
    record(3, 101, 0.5, 0.5, undefined, { outcome: "VOID", risk_allowed: false }),
    record(4, 101, 0.5, 0.5, undefined, { outcome: undefined, risk_allowed: false }),
  ]);
  assert.equal(report.all_evaluated_windows.n, 1);
  assert.equal(report.risk_gate_passed.n, 1);
  assert.equal(report.exclusions.anchored_late, 1);
  assert.equal(report.exclusions.voided, 1);
  assert.equal(report.exclusions.unresolved, 1);
});

test("sealed model hashes split both samples without changing the mixed historical total", () => {
  const first = score(1, 4_000_000, 16_000_000);
  const second = score(2, 36_000_000, 9_000_000);
  const report = buildResolveScoreReport([
    record(1, 101, 0.2, 0.3, first, { risk_allowed: true }),
    record(2, 202, 0.6, 0.4, second, { risk_allowed: false }),
  ]);

  assert.equal(report.aggregation, "mixed_model_historical_total");
  assert.equal(report.all_evaluated_windows.n, 2);
  assert.equal(report.all_evaluated_windows.mean_p_agent, 0.4);
  assert.equal(report.all_evaluated_windows.mean_p_market, 0.35);
  assert.ok(Math.abs(report.all_evaluated_windows.mean_probability_gap! - 0.05) < 1e-12);
  assert.equal(report.risk_gate_passed.n, 1);
  assert.equal(report.by_model_hash.length, 2);
  assert.equal(report.by_model_hash[0]?.model_hash, id(101));
  assert.equal(report.by_model_hash[0]?.all_evaluated_windows.n, 1);
  assert.equal(report.by_model_hash[0]?.risk_gate_passed.n, 1);
  assert.equal(report.by_model_hash[1]?.model_hash, id(202));
  assert.equal(report.by_model_hash[1]?.all_evaluated_windows.n, 1);
  assert.equal(report.by_model_hash[1]?.risk_gate_passed.n, 0);
});

test("bootstrap skill interval is deterministic for a fixed seed", () => {
  const scores = [
    score(1, 4_000_000, 16_000_000),
    score(2, 9_000_000, 25_000_000),
    score(3, 36_000_000, 16_000_000),
  ];
  const first = bootstrapSkillScore(scores, { seed: 42, resamples: 1_000 });
  const second = bootstrapSkillScore(scores, { seed: 42, resamples: 1_000 });
  assert.deepEqual(first, second);
  assert.equal(first?.resamples, 1_000);
  assert.equal(first?.valid_resamples, 1_000);
});

test("empty and perfect-zero baselines do not manufacture skill", () => {
  assert.deepEqual(aggregateBrierSkill([]), {
    n: 0, brier_agent: null, brier_market: null, skill_score: null,
  });
  assert.equal(aggregateBrierSkill([score(1, 0, 0)]).skill_score, null);
});
