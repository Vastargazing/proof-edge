import type { ForecastScore } from "./types.js";

export interface BrierSkillSummary {
  n: number;
  brier_agent: number | null;
  brier_market: number | null;
  /** 1 - BS(agent) / BS(market). Positive means the agent beat the market snapshot. */
  skill_score: number | null;
}

export function aggregateBrierSkill(scores: ForecastScore[]): BrierSkillSummary {
  if (scores.length === 0) {
    return { n: 0, brier_agent: null, brier_market: null, skill_score: null };
  }
  const scale = 100_000_000;
  const agent = scores.reduce((sum, item) => sum + item.brier_agent_e8, 0) / scores.length / scale;
  const market = scores.reduce((sum, item) => sum + item.brier_market_e8, 0) / scores.length / scale;
  return {
    n: scores.length,
    brier_agent: agent,
    brier_market: market,
    skill_score: market === 0 ? null : 1 - agent / market,
  };
}
