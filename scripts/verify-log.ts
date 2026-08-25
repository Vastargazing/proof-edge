import { resolve } from "node:path";
import { AppendOnlyStore } from "../src/store.js";
import { verifyReveal } from "../src/verify.js";

const file = process.env.RECORDER_STORE ?? resolve("data/forecast-events.jsonl");
const store = await AppendOnlyStore.open(file);
let verified = 0;
const failures: string[] = [];

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
    if (!verifyReveal(forecast.preimage, leaf, anchor)) {
      failures.push(`invalid reveal ${leaf.market_id}`);
      continue;
    }
    verified++;
  }
}

console.log(JSON.stringify({
  file,
  forecasts: store.allForecasts().length,
  forecasts_with_evidence: store.allForecasts().filter((item) => item.evidence !== undefined).length,
  pre_v1_smoke_forecasts: store.allForecasts().filter((item) => item.evidence === undefined).length,
  risk_decisions: store.riskDecisionCount(),
  reveals: store.revealCount(),
  scores: store.scoreCount(),
  batches: store.preparedBatches().length,
  anchors: store.anchoredBatches().length,
  verified,
  failures,
}, null, 2));
if (failures.length > 0) process.exitCode = 1;
