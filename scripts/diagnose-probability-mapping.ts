import { resolve } from "node:path";
import { AppendOnlyStore } from "../src/store.js";
import type { Hex32 } from "../src/types.js";

interface MappingRow {
  pAgent: number;
  pMarket: number;
  observedYes: 0 | 1;
  production: boolean;
  modelHash: Hex32;
}

function summarize(rows: readonly MappingRow[]) {
  if (rows.length === 0) {
    return {
      n: 0,
      mean_p_agent: null,
      mean_p_market: null,
      agent_market_gap: null,
      observed_yes_rate: null,
      calibration_gap: null,
      brier_p_agent: null,
      brier_one_minus_p_agent: null,
      inversion_brier_ratio: null,
      mapping_diagnostic: "insufficient_data",
    };
  }
  const mean = (project: (row: MappingRow) => number): number =>
    rows.reduce((sum, row) => sum + project(row), 0) / rows.length;
  const meanAgent = mean((row) => row.pAgent);
  const meanMarket = mean((row) => row.pMarket);
  const yesRate = mean((row) => row.observedYes);
  const brierAgent = mean((row) => (row.pAgent - row.observedYes) ** 2);
  const brierInverted = mean((row) => ((1 - row.pAgent) - row.observedYes) ** 2);
  return {
    n: rows.length,
    mean_p_agent: meanAgent,
    mean_p_market: meanMarket,
    agent_market_gap: meanAgent - meanMarket,
    observed_yes_rate: yesRate,
    calibration_gap: meanAgent - yesRate,
    brier_p_agent: brierAgent,
    brier_one_minus_p_agent: brierInverted,
    inversion_brier_ratio: brierAgent === 0 ? null : brierInverted / brierAgent,
    mapping_diagnostic: brierAgent <= brierInverted ? "p_agent_is_p_yes" : "possible_inversion",
  };
}

const file = resolve(process.env.RECORDER_STORE ?? "published/forecast-events.jsonl");
const store = await AppendOnlyStore.open(file);
const rows: MappingRow[] = store.allForecasts().flatMap((forecast) => {
  const outcome = store.revealedOutcome(forecast.market_id);
  if ((outcome !== "YES" && outcome !== "NO") || store.forecastAnchorStatus(forecast.market_id) !== "on_time") {
    return [];
  }
  return [{
    pAgent: forecast.preimage.p_agent,
    pMarket: forecast.preimage.p_market,
    observedYes: outcome === "YES" ? 1 : 0,
    production: forecast.evidence !== undefined,
    modelHash: forecast.preimage.model_hash,
  }];
});

const modelHashes = [...new Set(rows.map((row) => row.modelHash))];

console.log(JSON.stringify({
  file,
  definition: "p_agent is interpreted as P(YES)",
  all_resolved: summarize(rows),
  production_v1: summarize(rows.filter((row) => row.production)),
  by_model_hash: Object.fromEntries(modelHashes.map((modelHash) => [
    modelHash,
    summarize(rows.filter((row) => row.modelHash === modelHash)),
  ])),
}, null, 2));
