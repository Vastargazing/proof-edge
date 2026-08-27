import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalHash, ZERO_HASH } from "../src/canonical.js";
import { ForecastRecorder } from "../src/recorder.js";
import { AppendOnlyStore } from "../src/store.js";
import { SpotHistory } from "../vendor/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.js";
import type { ForecastPreimageV1, Hex32, LogEnvelope } from "../src/types.js";

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

const heartbeatEnvelope = (seq: number, parent: Hex32, marker: number): LogEnvelope => {
  const body: Omit<LogEnvelope, "event_hash"> = {
    seq,
    written_at_ns: String(marker),
    prev_event_hash: parent,
    event: {
      type: "recorder_heartbeat",
      value: { at_ns: String(marker), model_hash: hex(10_000 + marker), status: "running" },
    },
  };
  return { ...body, event_hash: canonicalHash(body) };
};

const writeLedger = async (file: string, events: LogEnvelope[]): Promise<void> => {
  await writeFile(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
};

test("hash-linked reading reports a terminal orphan and keeps the continued chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-orphan-"));
  const file = join(dir, "events.jsonl");
  const root = heartbeatEnvelope(0, ZERO_HASH, 1);
  const orphan = heartbeatEnvelope(1, root.event_hash, 2);
  const continued = heartbeatEnvelope(1, root.event_hash, 3);
  const head = heartbeatEnvelope(2, continued.event_hash, 4);
  await writeLedger(file, [root, orphan, continued, head]);
  const warnings: string[] = [];

  const store = await AppendOnlyStore.open(file, { warn: (message) => warnings.push(message) });
  assert.deepEqual(store.readReport(), {
    total_events: 4,
    accepted_events: 3,
    orphan_count: 1,
    orphan_events: [{
      line: 2,
      seq: 1,
      event_hash: orphan.event_hash,
      prev_event_hash: root.event_hash,
      event_type: "recorder_heartbeat",
    }],
    head_event_hash: head.event_hash,
  });
  assert.equal(store.latestHeartbeat()?.at_ns, "4");
  assert.ok(warnings.some((message) => message.includes("orphan_count=1")));
  assert.ok(warnings.some((message) => message.includes("orphan line=2")));
});

test("a bad event hash remains fail-closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-bad-hash-"));
  const file = join(dir, "events.jsonl");
  const root = heartbeatEnvelope(0, ZERO_HASH, 1);
  await writeLedger(file, [{ ...root, event_hash: hex(999) }]);
  await assert.rejects(() => AppendOnlyStore.open(file), /log event hash mismatch at line 1/);
});

test("a fork with descendants on both sides remains fail-closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-branch-"));
  const file = join(dir, "events.jsonl");
  const root = heartbeatEnvelope(0, ZERO_HASH, 1);
  const left = heartbeatEnvelope(1, root.event_hash, 2);
  const leftChild = heartbeatEnvelope(2, left.event_hash, 3);
  const right = heartbeatEnvelope(1, root.event_hash, 4);
  const rightChild = heartbeatEnvelope(2, right.event_hash, 5);
  await writeLedger(file, [root, left, leftChild, right, rightChild]);
  await assert.rejects(() => AppendOnlyStore.open(file), /true branch.*both sides have descendants/);
});

test("the retained incident ledger reads through line 1051 and reports only line 621 as orphaned", async () => {
  const file = resolve("incidents/2026-08-27/forecast-events.jsonl.corrupted");
  const bytes = await readFile(file);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "274642299ee63bf97b4b1bb28b181beba8960961afec0af532a5006a3d894475",
  );
  const physicalEvents = bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as LogEnvelope);
  const warnings: string[] = [];
  const store = await AppendOnlyStore.open(file, { warn: (message) => warnings.push(message) });
  const report = store.readReport();
  assert.equal(report.total_events, 1051);
  assert.equal(report.accepted_events, 1050);
  assert.deepEqual(report.orphan_events.map((event) => event.line), [621]);
  assert.equal(report.head_event_hash, physicalEvents.at(-1)?.event_hash);
  assert.ok(warnings.some((message) => message.includes("orphan line=621")));
});

test("restart is idempotent by market id and preserves prepared batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-"));
  const file = join(dir, "events.jsonl");
  const first = await AppendOnlyStore.open(file, { writable: true });
  const recorder = new ForecastRecorder(first);
  assert.equal((await recorder.record(input(1), evidence(1))).created, true);
  assert.equal((await recorder.record(input(1), evidence(1))).created, false);
  await recorder.record(input(2), evidence(2));
  const batch = await recorder.preparePendingBatch();
  assert.ok(batch);

  await first.close();
  const restarted = await AppendOnlyStore.open(file, { writable: true });
  assert.equal(restarted.allForecasts().length, 2);
  assert.equal(restarted.pendingForecasts().length, 0);
  assert.equal(restarted.unanchoredBatches().length, 1);
  assert.equal((await new ForecastRecorder(restarted).record(input(1), evidence(1))).created, false);

  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
});

test("conflicting second forecast for one market is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-"));
  const store = await AppendOnlyStore.open(join(dir, "events.jsonl"), { writable: true });
  const recorder = new ForecastRecorder(store);
  await recorder.record(input(1), evidence(1));
  await assert.rejects(() => recorder.record({ ...input(1), p_agent: 0.56 }, evidence(1)), /another commitment/);
});

test("recorder preserves committed v2 observation time and batches versions separately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-"));
  const store = await AppendOnlyStore.open(join(dir, "events.jsonl"), { writable: true });
  const recorder = new ForecastRecorder(store);
  await recorder.record(input(1), evidence(1));
  await recorder.record({ ...input(2), v: 2, observed_at_ns: "1787676200123000000" }, evidence(2));

  const first = await recorder.preparePendingBatch();
  const second = await recorder.preparePendingBatch();
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.merkle_version, undefined);
  assert.equal(first.leaves[0]?.merkle_version, undefined);
  assert.equal(second.merkle_version, 2);
  assert.equal(second.leaves[0]?.merkle_version, 2);
  const recordedV2 = store.forecast(hex(2));
  assert.equal(recordedV2?.observed_at_ns, "1787676200123000000");
  assert.equal(recordedV2?.preimage.v, 2);
  assert.equal(recordedV2?.preimage.v === 2 ? recordedV2.preimage.observed_at_ns : null, "1787676200123000000");
});

test("publication watermark is hash-chained and survives a clean reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-"));
  const file = join(dir, "events.jsonl");
  const store = await AppendOnlyStore.open(file, { writable: true });
  const sourceHead = store.headHash();
  await store.addPublicationWatermark({
    block_number: "100",
    captured_at_ns: "1",
    source_ledger_head: sourceHead,
    onchain_anchors: 2,
    disclosed_roots: 2,
    undisclosed_roots: 0,
    pending_roots: 1,
    failures: [],
  });
  await store.close();
  const reopened = await AppendOnlyStore.open(file, { writable: true });
  assert.equal(reopened.publicationWatermark()?.block_number, "100");
  assert.equal(reopened.publicationWatermark()?.pending_roots, 1);
  await assert.rejects(() => reopened.addPublicationWatermark({
    ...reopened.publicationWatermark()!,
    source_ledger_head: reopened.headHash(),
  }), /already contains/);
});

test("skip, heartbeat, and spot history events survive restart without duplicate samples", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-"));
  const file = join(dir, "events.jsonl");
  const store = await AppendOnlyStore.open(file, { writable: true });
  assert.equal(await store.addForecastSkip({
    attempted_at_ns: "1",
    market_key: "window-1",
    market_id: hex(1),
    reason: "volatility_warmup",
  }), true);
  assert.equal(await store.addForecastSkip({
    attempted_at_ns: "2",
    market_key: "window-1",
    market_id: hex(1),
    reason: "volatility_warmup",
  }), false);
  await store.addHeartbeat({ at_ns: "3", model_hash: hex(90), status: "running" });
  for (let index = 0; index <= 12; index++) {
    assert.equal(await store.addSpotObservation({
      asset: "BTC",
      price: 100 + index,
      oracle_observed_at_ms: 1_000 + index * 5_000,
      recorded_at_ns: String(4 + index),
    }), true);
  }
  assert.equal(await store.addSpotObservation({
    asset: "BTC",
    price: 999,
    oracle_observed_at_ms: 61_000,
    recorded_at_ns: "99",
  }), false);

  await store.close();
  const restarted = await AppendOnlyStore.open(file, { writable: true });
  assert.equal(restarted.skipCount(), 1);
  assert.equal(restarted.latestHeartbeat()?.model_hash, hex(90));
  assert.equal(restarted.spotObservations().length, 13);
  const restored = new SpotHistory(60_000, 15_000, 600_000);
  for (const spot of restarted.spotObservations()) {
    restored.record(spot.asset, { price: spot.price, at: spot.oracle_observed_at_ms });
  }
  assert.notEqual(restored.momentum("BTC", 61_000), null);
  assert.notEqual(restored.volatility("BTC"), null);
});

test("evidence digest is enforced and recovery stages are idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-"));
  const file = join(dir, "events.jsonl");
  const store = await AppendOnlyStore.open(file, { writable: true });
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
    ledger_head: batch.ledger_head,
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
  await store.close();
  const restarted = await AppendOnlyStore.open(file, { writable: true });
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
