import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { canonicalHash } from "../src/canonical.js";
import { ForecastRecorder } from "../src/recorder.js";
import { AppendOnlyStore } from "../src/store.js";
import type { ForecastPreimageV1, Hex32, LogEnvelope } from "../src/types.js";

const run = promisify(execFile);
const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;

test("snapshot publishes an anchored unresolved forecast and reports it pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forecast-snapshot-"));
  const source = join(directory, "live.jsonl");
  const store = await AppendOnlyStore.open(source, { writable: true });
  const recorder = new ForecastRecorder(store);
  const evidence = { production: true };
  const preimage: Omit<ForecastPreimageV1, "nonce"> & { nonce: Hex32 } = {
    v: 1,
    market_id: hex(1),
    venue_id: hex(2),
    symbol: "BTC",
    interval_sec: 900,
    expiry_ns: "2000000000000000000",
    p_agent: 0.55,
    side: "YES",
    p_market: 0.5,
    model_hash: hex(3),
    evidence_digest: canonicalHash(evidence),
    nonce: hex(4),
  };
  await recorder.record(preimage, evidence);
  await store.addRiskDecision({
    market_id: hex(1),
    decided_at_ns: "1",
    allowed: true,
    reason: "edge-band",
    absolute_edge_e4: 500,
    risk_config_hash: hex(5),
  });
  const batch = await recorder.preparePendingBatch();
  assert.ok(batch);
  await store.addAnchoredBatch({
    batch_id: batch.batch_id,
    root: batch.root,
    transaction_hash: hex(6),
    block_number: "1",
    block_timestamp: "1",
    gas_used: "1",
    effective_gas_price: "1",
    ledger_head: batch.ledger_head,
    status: "on_time",
    late_market_ids: [],
  });
  const forkParent = store.headHash();
  await store.close();

  const envelope = (seq: number, parent: Hex32, marker: number): LogEnvelope => {
    const body: Omit<LogEnvelope, "event_hash"> = {
      seq,
      written_at_ns: String(marker),
      prev_event_hash: parent,
      event: {
        type: "recorder_heartbeat",
        value: { at_ns: String(marker), model_hash: hex(100 + marker), status: "running" },
      },
    };
    return { ...body, event_hash: canonicalHash(body) };
  };
  const orphan = envelope(4, forkParent, 10);
  const continued = envelope(4, forkParent, 11);
  const continuedHead = envelope(5, continued.event_hash, 12);
  await appendFile(source, `${[orphan, continued, continuedHead].map((event) => JSON.stringify(event)).join("\n")}\n`);

  await run(process.execPath, [
    "--import",
    resolve("node_modules/tsx/dist/loader.mjs"),
    resolve("scripts/publish-snapshot.ts"),
  ], {
    cwd: directory,
    env: { ...process.env, RECORDER_STORE: source },
  });

  const published = await AppendOnlyStore.open(join(directory, "published/forecast-events.jsonl"));
  assert.equal(published.readReport().orphan_count, 1);
  assert.equal(published.allForecasts().length, 1);
  assert.equal(published.anchoredBatches().length, 1);
  assert.equal(published.isRevealed(hex(1)), false);
  const dashboard = JSON.parse(await readFile(join(directory, "dashboard/app/forecast-data.json"), "utf8"));
  assert.equal(dashboard.totals.pending_resolution, 1);
  assert.equal(dashboard.totals.forecasts, 1);
  assert.equal(dashboard.totals.anchors, 1);
  assert.equal(dashboard.totals.completeness_failures, 0);
  assert.equal(dashboard.totals.completeness_pending_roots, 0);
  assert.equal(dashboard.totals.orphan_events, 1);
  assert.deepEqual(dashboard.ledger_integrity.orphan_events.map((event: { line: number }) => event.line), [5]);

  // The reliability diagram ships all ten bins even with nothing to score, and
  // its sample must never drift from the aggregate published beside it.
  const calibration = dashboard.resolve_score.calibration;
  assert.equal(calibration.all_evaluated_windows.agent.length, 10);
  assert.equal(calibration.all_evaluated_windows.market.length, 10);
  assert.deepEqual(
    calibration.all_evaluated_windows.agent.map((bin: { lower: number }) => bin.lower),
    [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  );
  const sum = (bins: { n: number }[]): number => bins.reduce((total, bin) => total + bin.n, 0);
  assert.equal(sum(calibration.all_evaluated_windows.agent), dashboard.resolve_score.all_evaluated_windows.n);
  assert.equal(sum(calibration.current_model.agent), dashboard.resolve_score.by_model_hash.at(-1).all_evaluated_windows.n);
  assert.equal(calibration.current_model.model_hash, dashboard.resolve_score.by_model_hash.at(-1).model_hash);
  assert.equal(calibration.all_evaluated_windows.agent[0].mean_predicted, null);
});
