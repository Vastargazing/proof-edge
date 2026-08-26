import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalHash } from "../src/canonical.js";
import { ForecastRecorder } from "../src/recorder.js";
import { AppendOnlyStore } from "../src/store.js";
import type { ForecastPreimageV1, Hex32 } from "../src/types.js";

const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const input = (market: number): Omit<ForecastPreimageV1, "nonce"> & { nonce: Hex32 } => ({
  v: 1,
  market_id: hex(market),
  venue_id: hex(500),
  symbol: "BTC",
  interval_sec: 900,
  expiry_ns: "1787676300000000000",
  p_agent: 0.55,
  side: "YES",
  p_market: 0.5,
  model_hash: canonicalHash({ model: 1 }),
  evidence_digest: canonicalHash({ evidence: market }),
  nonce: hex(900 + market),
});
const evidence = (market: number) => ({ evidence: market });

test("restart is idempotent by market id and preserves prepared batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-"));
  const file = join(dir, "events.jsonl");
  const first = await AppendOnlyStore.open(file);
  const recorder = new ForecastRecorder(first);
  assert.equal((await recorder.record(input(1), evidence(1))).created, true);
  assert.equal((await recorder.record(input(1), evidence(1))).created, false);
  await recorder.record(input(2), evidence(2));
  const batch = await recorder.preparePendingBatch();
  assert.ok(batch);

  const restarted = await AppendOnlyStore.open(file);
  assert.equal(restarted.allForecasts().length, 2);
  assert.equal(restarted.pendingForecasts().length, 0);
  assert.equal(restarted.unanchoredBatches().length, 1);
  assert.equal((await new ForecastRecorder(restarted).record(input(1), evidence(1))).created, false);

  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
});

test("conflicting second forecast for one market is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-"));
  const store = await AppendOnlyStore.open(join(dir, "events.jsonl"));
  const recorder = new ForecastRecorder(store);
  await recorder.record(input(1), evidence(1));
  await assert.rejects(() => recorder.record({ ...input(1), p_agent: 0.56 }, evidence(1)), /another commitment/);
});

test("evidence digest is enforced and recovery stages are idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-"));
  const file = join(dir, "events.jsonl");
  const store = await AppendOnlyStore.open(file);
  const recorder = new ForecastRecorder(store);
  await assert.rejects(() => recorder.record(input(1), { wrong: true }), /evidence digest mismatch/);
  await recorder.record(input(1), evidence(1));
  const risk = {
    market_id: hex(1), decided_at_ns: "1", allowed: true, reason: "edge-band" as const,
    absolute_edge_e4: 500, risk_config_hash: hex(88),
  };
  await store.addRiskDecision(risk);
  await store.addRiskDecision(risk);
  await store.addRiskDecision({ ...risk, decided_at_ns: "2", risk_config_hash: hex(89), allowed: false });
  const batch = await recorder.preparePendingBatch();
  assert.ok(batch);
  await store.addAnchoredBatch({
    batch_id: batch.batch_id,
    root: batch.root,
    transaction_hash: hex(999),
    block_number: "1",
    block_timestamp: "1",
    gas_used: "55938",
    effective_gas_price: "6000000000",
    status: "on_time",
    late_market_ids: [],
  });
  await store.addReveal({ market_id: hex(1), revealed_at_ns: "2", outcome: "YES" });
  await store.addReveal({ market_id: hex(1), revealed_at_ns: "3", outcome: "YES" });
  const score = {
    market_id: hex(1), scored_at_ns: "3", outcome: "YES" as const,
    brier_agent_e8: 20250000, brier_market_e8: 25000000,
  };
  await store.addScore(score);
  await store.addScore(score);
  const restarted = await AppendOnlyStore.open(file);
  assert.equal(restarted.hasRiskDecision(hex(1)), true);
  assert.equal(restarted.hasRiskDecision(hex(1), hex(89)), true);
  assert.equal(restarted.riskDecisionCount(), 2);
  assert.equal(restarted.revealedOutcome(hex(1)), "YES");
  assert.equal(restarted.isScored(hex(1)), true);
  assert.equal(restarted.resolveScoreReport().all_evaluated_windows.n, 1);
  assert.equal(restarted.resolveScoreReport().risk_gate_passed.n, 1);
  assert.equal(restarted.resolveScoreReport().by_model_hash[0]?.model_hash, input(1).model_hash);
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 7);
});
