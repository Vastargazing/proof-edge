import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AppendOnlyStore } from "../src/store.js";
import { buildCalibrationReport, scoringRecordsFrom } from "./calibration.js";
import {
  anchorLeadsFromLedger,
  resolveMinAnchorLeadSec,
  summarizeAnchorLeads,
} from "./lib/anchor-lead.js";

const source = resolve(process.env.RECORDER_STORE ?? "data/forecast-events.jsonl");
const published = resolve("published/forecast-events.jsonl");
const dashboardData = resolve("dashboard/app/forecast-data.json");

// The live writer prepares a batch a few seconds before its anchor lands. A copy
// taken inside that gap carries an unanchored batch that verify:log rightly
// refuses, so wait for the anchor instead of losing the hour.
const copyAttempts = Number(process.env.PUBLISH_COPY_ATTEMPTS ?? 6);
const copyRetryMs = Number(process.env.PUBLISH_COPY_RETRY_MS ?? 10_000);
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

if (source !== published) {
  await mkdir(dirname(published), { recursive: true });
  const candidate = `${published}.candidate-${process.pid}`;
  try {
    for (let attempt = 1; ; attempt++) {
      await writeFile(candidate, await readFile(source), { mode: 0o600 });
      // Parse and validate the candidate before the atomic rename. Unresolved
      // forecasts are deliberately published after anchoring: keeping them in the
      // public ledger closes the selective-disclosure gap while their outcomes and
      // scores remain pending.
      const copy = await AppendOnlyStore.open(candidate);
      const pending = copy.unanchoredBatches().length;
      if (pending === 0) break;
      if (attempt >= copyAttempts) {
        throw new Error(`live ledger still holds ${pending} prepared batch(es) without an anchor after ${attempt} copies; not publishing`);
      }
      console.error(`publish: ${pending} prepared batch(es) not yet anchored; copying again in ${copyRetryMs} ms (${attempt}/${copyAttempts})`);
      await sleep(copyRetryMs);
    }
    await rename(candidate, published);
  } finally {
    await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const store = await AppendOnlyStore.open(published);
const ledgerIntegrity = store.readReport();
if (store.publicationWatermark() !== undefined) {
  throw new Error("source recorder ledger must not contain a publication watermark");
}
const forecasts = store.allForecasts();
if (forecasts.length === 0) throw new Error("refusing to publish an empty ledger");
const unrevealed = forecasts.filter((item) => !store.isRevealed(item.market_id));
const provable = forecasts.filter((item) => (
  item.evidence !== undefined
  && store.isRevealed(item.market_id)
  && store.forecastAnchorStatus(item.market_id) === "on_time"
));
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
// Same records, same eligibility test, binned instead of aggregated. Published
// beside the aggregate so a reader can check the sample sizes against each other.
const calibration = buildCalibrationReport(scoringRecordsFrom(store));
// How much margin every anchored forecast actually had, not only that it
// cleared zero. Published as its own key: no existing key changes meaning, and
// nothing here selects, filters or re-derives a verdict.
const leadSample = anchorLeadsFromLedger(store);
const anchorLead = summarizeAnchorLeads(
  leadSample.leads,
  resolveMinAnchorLeadSec(process.env.MIN_ANCHOR_LEAD_SEC),
  leadSample.unavailable,
);
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
  ledger_integrity: ledgerIntegrity,
  recorder_health: {
    latest_heartbeat: store.latestHeartbeat() ?? null,
    forecast_skip_events: store.skipCount(),
    spot_observations: store.spotObservations().length,
  },
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
    completeness_failures: 0,
    completeness_pending_roots: 0,
    orphan_events: ledgerIntegrity.orphan_count,
  },
  resolve_score: { ...resolveScore, calibration },
  anchor_lead: anchorLead,
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
  ledger_integrity: ledgerIntegrity,
}, null, 2));
