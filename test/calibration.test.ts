import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  binIndex,
  binSeries,
  buildCalibrationReport,
  scoringRecordsFrom,
  wilsonInterval,
} from "../scripts/calibration.js";
import { canonicalHash } from "../src/canonical.js";
import { ForecastRecorder } from "../src/recorder.js";
import { buildResolveScoreReport, type ScoringRecord } from "../src/scoring.js";
import { AppendOnlyStore } from "../src/store.js";
import type { ForecastPreimageV1, Hex32 } from "../src/types.js";

const id = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const record = (
  market: number,
  pAgent: number,
  outcome: "YES" | "NO",
  overrides: Partial<ScoringRecord> = {},
): ScoringRecord => ({
  market_id: id(market),
  model_hash: id(900),
  p_agent: pAgent,
  p_market: 0.5,
  anchor_status: "on_time",
  outcome,
  score: {
    market_id: id(market),
    scored_at_ns: String(market),
    outcome,
    brier_agent_e8: 1,
    brier_market_e8: 1,
  },
  risk_allowed: true,
  ...overrides,
});

test("ten bins are always present and land on the documented edges", () => {
  const bins = binSeries([]);
  assert.equal(bins.length, 10);
  assert.deepEqual(bins.map((bin) => bin.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(bins[0], {
    index: 0, lower: 0, upper: 0.1, n: 0,
    mean_predicted: null, observed_frequency: null, wilson_low: null, wilson_high: null,
  });
  assert.equal(bins[9]?.lower, 0.9);
  assert.equal(bins[9]?.upper, 1);
});

test("bin edges are half-open except the last, which closes on 1.0", () => {
  assert.equal(binIndex(0), 0);
  assert.equal(binIndex(0.0999), 0);
  assert.equal(binIndex(0.1), 1);
  assert.equal(binIndex(0.3), 3);
  assert.equal(binIndex(0.7), 7);
  assert.equal(binIndex(0.8999), 8);
  assert.equal(binIndex(0.9), 9);
  assert.equal(binIndex(1), 9, "exactly 1.0 belongs to the last bin, not an eleventh one");
  assert.throws(() => binIndex(1.0001), /outside \[0, 1\]/);
  assert.throws(() => binIndex(-0.0001), /outside \[0, 1\]/);
});

test("boundary probabilities 0.0 and 1.0 are binned and scored, not dropped", () => {
  const bins = binSeries([
    { probability: 0, outcome: 0 },
    { probability: 0, outcome: 1 },
    { probability: 1, outcome: 1 },
  ]);
  assert.equal(bins[0]?.n, 2);
  assert.equal(bins[0]?.mean_predicted, 0);
  assert.equal(bins[0]?.observed_frequency, 0.5);
  assert.equal(bins[9]?.n, 1);
  assert.equal(bins[9]?.mean_predicted, 1);
  assert.equal(bins[9]?.observed_frequency, 1);
  assert.equal(bins.reduce((sum, bin) => sum + bin.n, 0), 3);
});

test("empty bins stay in the series with null frequencies", () => {
  const bins = binSeries([
    { probability: 0.25, outcome: 1 },
    { probability: 0.25, outcome: 0 },
  ]);
  assert.equal(bins.length, 10);
  assert.equal(bins[2]?.n, 2);
  for (const index of [0, 1, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(bins[index]?.n, 0);
    assert.equal(bins[index]?.mean_predicted, null);
    assert.equal(bins[index]?.observed_frequency, null);
    assert.equal(bins[index]?.wilson_low, null);
    assert.equal(bins[index]?.wilson_high, null);
  }
});

test("hand-built records reach the bins they were written for", () => {
  const report = buildCalibrationReport([
    record(1, 0.05, "YES"),
    record(2, 0.05, "NO"),
    record(3, 0.09, "NO"),
    record(4, 0.55, "YES"),
    record(5, 0.95, "YES"),
    // Excluded exactly as buildResolveScoreReport excludes them.
    record(6, 0.55, "YES", { anchor_status: "anchored_late" }),
    record(7, 0.55, "YES", { anchor_status: "unanchored" }),
    record(8, 0.55, "YES", { outcome: undefined }),
    record(9, 0.55, "YES", { outcome: "VOID" }),
    record(10, 0.55, "YES", { score: undefined }),
  ]);
  const agent = report.all_evaluated_windows.agent;
  assert.equal(agent[0]?.n, 3);
  assert.ok(Math.abs(agent[0]!.mean_predicted! - 0.19 / 3) < 1e-12);
  assert.ok(Math.abs(agent[0]!.observed_frequency! - 1 / 3) < 1e-12);
  assert.equal(agent[5]?.n, 1);
  assert.equal(agent[5]?.observed_frequency, 1);
  assert.equal(agent[9]?.n, 1);
  assert.equal(agent.reduce((sum, bin) => sum + bin.n, 0), 5, "only evaluated windows are binned");
  // p_market is 0.5 on every record, so the whole baseline lands in one bin.
  const market = report.all_evaluated_windows.market;
  assert.equal(market[5]?.n, 5);
  assert.ok(Math.abs(market[5]!.observed_frequency! - 3 / 5) < 1e-12);
});

test("the current-model slice is the last sealed model hash, as in by_model_hash", () => {
  const records = [
    record(1, 0.25, "YES", { model_hash: id(101) }),
    record(2, 0.35, "NO", { model_hash: id(202) }),
    record(3, 0.35, "YES", { model_hash: id(202) }),
  ];
  const report = buildCalibrationReport(records);
  const aggregate = buildResolveScoreReport(records);
  assert.equal(report.current_model.model_hash, aggregate.by_model_hash.at(-1)?.model_hash);
  assert.equal(report.current_model.model_hash, id(202));
  assert.equal(report.current_model.agent[3]?.n, 2);
  assert.equal(report.current_model.agent[2]?.n, 0, "the older version's window is not in this slice");
  assert.equal(
    report.current_model.agent.reduce((sum, bin) => sum + bin.n, 0),
    aggregate.by_model_hash.at(-1)?.all_evaluated_windows.n,
  );
});

test("an empty ledger yields ten empty bins and no current model", () => {
  const report = buildCalibrationReport([]);
  assert.equal(report.current_model.model_hash, null);
  assert.equal(report.all_evaluated_windows.agent.length, 10);
  assert.equal(report.all_evaluated_windows.market.length, 10);
  assert.equal(report.current_model.agent.reduce((sum, bin) => sum + bin.n, 0), 0);
});

test("Wilson bounds match two intervals computed by hand", () => {
  // z = 1.959963984540054, z^2 = 3.841458820694124.
  //
  // 7 of 10: denominator = 1 + 3.8414588206941236/10 = 1.3841458820694124
  //   centre = (0.7 + 0.1920729410347062) / 1.3841458820694124 = 0.6444934
  //   margin = (1.959963984540054 / 1.3841458820694124)
  //          * sqrt(0.21/10 + 3.8414588206941236/400)
  //          = 1.4160097 * sqrt(0.0306036470517353) = 0.2477153
  //   interval = [0.3967781, 0.8922087]
  const ten = wilsonInterval(7, 10);
  assert.ok(Math.abs(ten.low - 0.3967781) < 1e-6, `low was ${ten.low}`);
  assert.ok(Math.abs(ten.high - 0.8922087) < 1e-6, `high was ${ten.high}`);
  //
  // 20 of 40: the centre is exactly 0.5, because 0.5 * (1 + z^2/40) equals
  //   0.5 + z^2/80, so the shrinkage term cancels.
  //   margin = (1.959963984540054 / 1.0960364705173531)
  //          * sqrt(0.25/40 + 3.8414588206941236/6400)
  //          = 1.7882288 * sqrt(0.0068502279407335) = 0.1480047
  //   interval = [0.3519953, 0.6480047]
  const forty = wilsonInterval(20, 40);
  assert.ok(Math.abs(forty.low - 0.3519953) < 1e-6, `low was ${forty.low}`);
  assert.ok(Math.abs(forty.high - 0.6480047) < 1e-6, `high was ${forty.high}`);
  assert.ok(Math.abs((forty.low + forty.high) / 2 - 0.5) < 1e-12);
});

test("a degenerate bin keeps a non-zero Wilson width", () => {
  const allYes = wilsonInterval(4, 4);
  assert.equal(allYes.high, 1);
  assert.ok(allYes.low > 0.5 && allYes.low < 1, "an all-YES bin must not report a zero-width interval");
  const allNo = wilsonInterval(0, 4);
  assert.equal(allNo.low, 0);
  assert.ok(allNo.high > 0 && allNo.high < 0.5);
  assert.throws(() => wilsonInterval(0, 0), /positive integer sample size/);
  assert.throws(() => wilsonInterval(5, 4), /integer in \[0, n\]/);
});

test("the binned sample is the sample the published aggregate scores", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forecast-calibration-"));
  const store = await AppendOnlyStore.open(join(directory, "live.jsonl"), { writable: true });
  const recorder = new ForecastRecorder(store);
  const evidence = { production: true };
  const windows = [
    { market: 1, model: 700, pAgent: 0.2213, pMarket: 0.3235, outcome: "YES" as const, late: false },
    { market: 2, model: 700, pAgent: 0.9, pMarket: 0.5, outcome: "NO" as const, late: false },
    { market: 3, model: 800, pAgent: 0.1, pMarket: 0.5, outcome: "YES" as const, late: false },
    { market: 4, model: 800, pAgent: 1, pMarket: 0, outcome: "YES" as const, late: false },
    // Anchored after expiry: present in the ledger, absent from both samples.
    { market: 5, model: 800, pAgent: 0.5, pMarket: 0.5, outcome: "YES" as const, late: true },
  ];

  for (const window of windows) {
    const preimage: ForecastPreimageV1 = {
      v: 1,
      market_id: id(window.market),
      venue_id: id(2),
      symbol: "BTC",
      interval_sec: 3600,
      expiry_ns: "2000000000000000000",
      p_agent: window.pAgent,
      side: window.pAgent >= window.pMarket ? "YES" : "NO",
      p_market: window.pMarket,
      model_hash: id(window.model),
      evidence_digest: canonicalHash(evidence),
      nonce: id(window.market + 40),
    };
    await recorder.record(preimage, evidence);
    await store.addRiskDecision({
      market_id: id(window.market),
      decided_at_ns: String(window.market),
      allowed: window.market % 2 === 1,
      reason: "edge-band",
      absolute_edge_e4: 500,
      risk_config_hash: id(5),
    });
    const batch = await recorder.preparePendingBatch();
    assert.ok(batch);
    await store.addAnchoredBatch({
      batch_id: batch.batch_id,
      root: batch.root,
      transaction_hash: id(window.market + 60),
      block_number: String(window.market),
      // 2000000000 ns of expiry in seconds is 2000000000; a later block is late.
      block_timestamp: window.late ? "2000000001" : "1999999999",
      gas_used: "1",
      effective_gas_price: "1",
      ledger_head: batch.ledger_head,
      status: window.late ? "anchored_late" : "on_time",
      late_market_ids: window.late ? [id(window.market)] : [],
    });
    await store.addReveal({
      market_id: id(window.market),
      revealed_at_ns: String(window.market),
      outcome: window.outcome,
    });
    // A late anchor cannot be scored at all (`src/store.ts:456-459`), which is
    // why the late window is missing from both samples rather than one.
    if (window.late) continue;
    const observed = window.outcome === "YES" ? 1 : 0;
    const brier = (probability: number): number => Math.round((probability - observed) ** 2 * 100_000_000);
    await store.addScore({
      market_id: id(window.market),
      scored_at_ns: String(window.market),
      outcome: window.outcome,
      brier_agent_e8: brier(window.pAgent),
      brier_market_e8: brier(window.pMarket),
    });
  }
  await store.close();

  const reopened = await AppendOnlyStore.open(join(directory, "live.jsonl"));
  const aggregate = reopened.resolveScoreReport();
  const calibration = buildCalibrationReport(scoringRecordsFrom(reopened));

  const sum = (bins: { n: number }[]): number => bins.reduce((total, bin) => total + bin.n, 0);
  assert.equal(aggregate.all_evaluated_windows.n, 4);
  assert.equal(
    sum(calibration.all_evaluated_windows.agent),
    aggregate.all_evaluated_windows.n,
    "the agent bins and the published aggregate must count the same windows",
  );
  assert.equal(
    sum(calibration.all_evaluated_windows.market),
    aggregate.all_evaluated_windows.n,
    "the market baseline is binned over the identical sample",
  );
  assert.equal(calibration.current_model.model_hash, aggregate.by_model_hash.at(-1)?.model_hash);
  assert.equal(
    sum(calibration.current_model.agent),
    aggregate.by_model_hash.at(-1)?.all_evaluated_windows.n,
  );
  assert.equal(sum(calibration.current_model.market), sum(calibration.current_model.agent));

  // The late window is the only excluded one, and it is excluded from both.
  assert.equal(aggregate.exclusions.anchored_late, 1);
  assert.equal(reopened.allForecasts().length, 5);

  // Placement of two known windows, read straight off the sealed probabilities.
  assert.equal(calibration.all_evaluated_windows.agent[2]?.n, 1);
  assert.equal(calibration.all_evaluated_windows.agent[2]?.mean_predicted, 0.2213);
  assert.equal(calibration.all_evaluated_windows.agent[9]?.n, 2);
});
