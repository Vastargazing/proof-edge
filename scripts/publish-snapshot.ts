import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { aggregateBrierSkill } from "../src/scoring.js";
import { AppendOnlyStore } from "../src/store.js";

const source = resolve(process.env.RECORDER_STORE ?? "data/forecast-events.jsonl");
const published = resolve("published/forecast-events.jsonl");
const dashboardData = resolve("dashboard/app/forecast-data.json");

if (source !== published) {
  await mkdir(dirname(published), { recursive: true });
  await copyFile(source, published);
}

const store = await AppendOnlyStore.open(published);
const forecasts = store.allForecasts();
if (forecasts.length === 0) throw new Error("refusing to publish an empty ledger");

const production = forecasts.filter((item) => item.evidence !== undefined);
if (production.length === 0) throw new Error("refusing to publish without production evidence");
const productionIds = new Set(production.map((item) => item.market_id));
const scores = store.allScores();
const scoreByMarket = new Map(scores.map((item) => [item.market_id, item]));
const productionBatch = store.preparedBatches()
  .filter((batch) => batch.leaves.every((leaf) => productionIds.has(leaf.market_id)))
  .sort((a, b) => BigInt(a.prepared_at_ns) < BigInt(b.prepared_at_ns) ? 1 : -1)
  .find((batch) => store.anchoredBatch(batch.batch_id));
if (!productionBatch) throw new Error("no anchored production batch found");
const productionAnchor = store.anchoredBatch(productionBatch.batch_id);
if (!productionAnchor) throw new Error("production batch is not anchored");
const displayForecasts = productionBatch.leaves.map((leaf) => {
  const forecast = store.forecast(leaf.market_id);
  if (!forecast?.evidence) throw new Error(`missing production forecast ${leaf.market_id}`);
  return forecast;
});

const data = {
  generated_from: "published/forecast-events.jsonl",
  totals: {
    forecasts: forecasts.length,
    forecasts_with_evidence: production.length,
    anchors: store.anchoredBatches().length,
  },
  brier_skill: {
    all_resolved: aggregateBrierSkill(scores),
    production_v1: aggregateBrierSkill(scores.filter((item) => productionIds.has(item.market_id))),
  },
  production: {
    root: productionBatch.root,
    transaction_hash: productionAnchor.transaction_hash,
    model_hash: displayForecasts[0]!.preimage.model_hash,
    forecasts: displayForecasts.map((forecast) => {
      const decision = store.riskDecisionsFor(forecast.market_id).at(-1);
      if (!decision) throw new Error(`missing risk decision for ${forecast.market_id}`);
      const score = scoreByMarket.get(forecast.market_id) ?? null;
      return {
        id: forecast.market_id,
        asset: forecast.preimage.symbol,
        interval_sec: forecast.preimage.interval_sec,
        p_agent: forecast.preimage.p_agent,
        p_market: forecast.preimage.p_market,
        edge: Math.abs(forecast.preimage.p_agent - forecast.preimage.p_market),
        allowed: decision.allowed,
        side: forecast.preimage.side,
        risk_reason: decision.reason,
        evidence_digest: forecast.preimage.evidence_digest,
        outcome: store.revealedOutcome(forecast.market_id) ?? null,
        brier_agent: score === null ? null : score.brier_agent_e8 / 100_000_000,
        brier_market: score === null ? null : score.brier_market_e8 / 100_000_000,
      };
    }),
  },
};

await writeFile(dashboardData, `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ published, dashboardData, forecasts: forecasts.length }, null, 2));
