import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { canonicalHash } from "../src/canonical.js";
import { ForecastRecorder } from "../src/recorder.js";
import { AppendOnlyStore } from "../src/store.js";
import type { ForecastPreimageV1, Hex32 } from "../src/types.js";

const run = promisify(execFile);
const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;

test("snapshot publishes an anchored unresolved forecast and reports it pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forecast-snapshot-"));
  const source = join(directory, "live.jsonl");
  const store = await AppendOnlyStore.open(source);
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

  await run(process.execPath, [
    "--import",
    resolve("node_modules/tsx/dist/loader.mjs"),
    resolve("scripts/publish-snapshot.ts"),
  ], {
    cwd: directory,
    env: { ...process.env, RECORDER_STORE: source },
  });

  const published = await AppendOnlyStore.open(join(directory, "published/forecast-events.jsonl"));
  assert.equal(published.allForecasts().length, 1);
  assert.equal(published.anchoredBatches().length, 1);
  assert.equal(published.isRevealed(hex(1)), false);
  const dashboard = JSON.parse(await readFile(join(directory, "dashboard/app/forecast-data.json"), "utf8"));
  assert.equal(dashboard.totals.pending_resolution, 1);
  assert.equal(dashboard.totals.forecasts, 1);
  assert.equal(dashboard.totals.anchors, 1);
});
