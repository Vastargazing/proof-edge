import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AppendOnlyStore } from "../src/store.js";

const source = resolve(process.env.RECORDER_STORE ?? "data/forecast-events.jsonl");
const published = resolve("published/forecast-events.jsonl");
const dashboardData = resolve("dashboard/app/forecast-data.json");

if (source !== published) {
  await mkdir(dirname(published), { recursive: true });
  const snapshot = await readFile(source);
  const candidate = `${published}.candidate-${process.pid}`;
  await writeFile(candidate, snapshot, { mode: 0o600 });
  try {
    // Parse and validate the candidate before the atomic rename. Unresolved
    // forecasts are deliberately published after anchoring: keeping them in the
    // public ledger closes the selective-disclosure gap while their outcomes and
    // scores remain pending.
    await AppendOnlyStore.open(candidate);
    await rename(candidate, published);
  } finally {
    await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const store = await AppendOnlyStore.open(published);
const forecasts = store.allForecasts();
if (forecasts.length === 0) throw new Error("refusing to publish an empty ledger");
const unrevealed = forecasts.filter((item) => !store.isRevealed(item.market_id));
const provable = forecasts.filter((item) => store.forecastAnchorStatus(item.market_id) === "on_time");
const anchoredLate = forecasts.filter((item) => store.forecastAnchorStatus(item.market_id) === "anchored_late");
const unanchored = forecasts.filter((item) => store.forecastAnchorStatus(item.market_id) === "unanchored");
const onTimeAnchors = store.preparedBatches().filter((item) => store.batchAnchorStatus(item.batch_id) === "on_time");
const lateAnchors = store.preparedBatches().filter((item) => store.batchAnchorStatus(item.batch_id) === "anchored_late");

const production = forecasts.filter((item) => item.evidence !== undefined);
if (production.length === 0) throw new Error("refusing to publish without production evidence");
const productionIds = new Set(production.map((item) => item.market_id));
const scores = store.allScores();
const scoreByMarket = new Map(scores.map((item) => [item.market_id, item]));
const resolveScore = store.resolveScoreReport();
const productionBatch = store.preparedBatches()
  .filter((batch) => batch.leaves.every((leaf) => productionIds.has(leaf.market_id)))
  .sort((a, b) => BigInt(a.prepared_at_ns) < BigInt(b.prepared_at_ns) ? 1 : -1)
  .find((batch) => store.batchAnchorStatus(batch.batch_id) === "on_time");
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
    pending_resolution: unrevealed.length,
    provable_forecasts: provable.length,
    anchored_late_forecasts: anchoredLate.length,
    unanchored_forecasts: unanchored.length,
    anchors: store.anchoredBatches().length,
    on_time_anchors: onTimeAnchors.length,
    anchored_late_batches: lateAnchors.length,
  },
  resolve_score: resolveScore,
  production: {
    root: productionBatch.root,
    transaction_hash: productionAnchor.transaction_hash,
    model_hash: displayForecasts[0]!.preimage.model_hash,
    forecasts: displayForecasts.map((forecast) => {
      const decision = store.riskDecisionsFor(forecast.market_id).at(0);
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

await mkdir(dirname(dashboardData), { recursive: true });
await writeFile(dashboardData, `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  published,
  dashboardData,
  forecasts: forecasts.length,
  anchors: store.anchoredBatches().length,
  scores: scores.length,
  pending_resolution: unrevealed.length,
}, null, 2));
