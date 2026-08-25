import assert from "node:assert/strict";
import test from "node:test";
import { aggregateBrierSkill } from "../src/scoring.js";
import type { ForecastScore, Hex32 } from "../src/types.js";

const id = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const score = (market: number, agent: number, baseline: number): ForecastScore => ({
  market_id: id(market),
  scored_at_ns: "1",
  outcome: "YES",
  brier_agent_e8: agent,
  brier_market_e8: baseline,
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

test("empty and perfect-zero baselines do not manufacture skill", () => {
  assert.deepEqual(aggregateBrierSkill([]), {
    n: 0, brier_agent: null, brier_market: null, skill_score: null,
  });
  assert.equal(aggregateBrierSkill([score(1, 0, 0)]).skill_score, null);
});
