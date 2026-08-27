import { resolve } from "node:path";
import { AppendOnlyStore } from "../src/store.js";
import { verifyCommitmentInclusion, verifyReveal } from "../src/verify.js";

const file = process.env.RECORDER_STORE ?? resolve("published/forecast-events.jsonl");
const store = await AppendOnlyStore.open(file);
const ledgerIntegrity = store.readReport();
let verified = 0;
let anchoredLate = 0;
const failures: string[] = [];
const forecasts = store.allForecasts();

if (forecasts.length === 0) failures.push("ledger contains no forecasts");

for (const batch of store.preparedBatches()) {
  const anchor = store.anchoredBatch(batch.batch_id);
  if (!anchor) {
    failures.push(`batch ${batch.batch_id} is not anchored`);
    continue;
  }
  for (const leaf of batch.leaves) {
    const forecast = store.forecast(leaf.market_id);
    if (!forecast) {
      failures.push(`missing forecast ${leaf.market_id}`);
      continue;
    }
    if (!verifyCommitmentInclusion(forecast.preimage, leaf, anchor)) {
      failures.push(`invalid reveal ${leaf.market_id}`);
      continue;
    }
    if (store.forecastAnchorStatus(leaf.market_id) === "anchored_late") {
      anchoredLate++;
      continue;
    }
    if (!verifyReveal(forecast.preimage, leaf, anchor)) {
      failures.push(`invalid on-time claim ${leaf.market_id}`);
      continue;
    }
    verified++;
  }
}

const unanchored = forecasts.filter((item) => store.forecastAnchorStatus(item.market_id) === "unanchored").length;
if (unanchored > 0) failures.push(`${unanchored} forecasts are not in a prepared anchored batch`);

console.log(JSON.stringify({
  file,
  ledger_integrity: ledgerIntegrity,
  forecasts: forecasts.length,
  forecasts_with_evidence: forecasts.filter((item) => item.evidence !== undefined).length,
  pre_v1_smoke_forecasts: forecasts.filter((item) => item.evidence === undefined).length,
  risk_decisions: store.riskDecisionCount(),
  reveals: store.revealCount(),
  scores: store.scoreCount(),
  forecast_skip_events: store.skipCount(),
  spot_observations: store.spotObservations().length,
  latest_heartbeat: store.latestHeartbeat() ?? null,
  batches: store.preparedBatches().length,
  anchors: store.anchoredBatches().length,
  verified,
  anchored_late: anchoredLate,
  unanchored,
  resolve_score: store.resolveScoreReport(),
  failures,
}, null, 2));
if (failures.length > 0) process.exitCode = 1;
