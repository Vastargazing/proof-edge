import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnchorCoordinator } from "../src/anchor-coordinator.js";
import { canonicalHash } from "../src/canonical.js";
import { ForecastRecorder } from "../src/recorder.js";
import { AppendOnlyStore } from "../src/store.js";
import type { BatchPrepared, ForecastPreimageV1, Hex32 } from "../src/types.js";

const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;

const input = (market: number): Omit<ForecastPreimageV1, "nonce"> & { nonce: Hex32 } => ({
  v: 1,
  market_id: hex(market),
  venue_id: hex(500),
  symbol: "BTC",
  interval_sec: 900,
  expiry_ns: "1999999999999999999",
  p_agent: 0.55,
  side: "YES",
  p_market: 0.5,
  model_hash: canonicalHash({ model: 1 }),
  evidence_digest: canonicalHash({ evidence: market }),
  nonce: hex(900 + market),
});

class FakeAnchor {
  calls = 0;

  constructor(
    public failures: number,
    public balanceWei = 1_000n,
    public blockTimestamp = "1",
  ) {}

  async balance(): Promise<bigint> {
    return this.balanceWei;
  }

  async anchor(batch: BatchPrepared, store: AppendOnlyStore): Promise<Hex32> {
    this.calls++;
    if (this.failures-- > 0) throw new Error("rpc unavailable");
    const transactionHash = hex(10_000 + this.calls);
    const anchorNs = BigInt(this.blockTimestamp) * 1_000_000_000n;
    const lateMarketIds = batch.leaves.flatMap((leaf) => {
      const forecast = store.forecast(leaf.market_id);
      if (!forecast) throw new Error(`missing forecast ${leaf.market_id}`);
      return anchorNs >= BigInt(forecast.preimage.expiry_ns) ? [leaf.market_id] : [];
    });
    await store.addAnchoredBatch({
      batch_id: batch.batch_id,
      root: batch.root,
      transaction_hash: transactionHash,
      block_number: String(this.calls),
      block_timestamp: this.blockTimestamp,
      gas_used: "55938",
      effective_gas_price: "6000000000",
      status: lateMarketIds.length > 0 ? "anchored_late" : "on_time",
      late_market_ids: lateMarketIds,
    });
    return transactionHash;
  }
}

async function setup(failures: number, balanceWei = 1_000n) {
  const dir = await mkdtemp(join(tmpdir(), "anchor-coordinator-"));
  const store = await AppendOnlyStore.open(join(dir, "events.jsonl"));
  const recorder = new ForecastRecorder(store);
  const anchor = new FakeAnchor(failures, balanceWei);
  const logs: string[] = [];
  let now = 0;
  const coordinator = new AnchorCoordinator(anchor, store, recorder, {
    retryBaseMs: 100,
    retryMaxMs: 400,
    balanceCheckMs: 1_000,
    lowBalanceWei: 100n,
    now: () => now,
    log: (message) => logs.push(message),
  });
  return { store, recorder, anchor, logs, coordinator, setNow: (value: number) => (now = value) };
}

test("RPC failure leaves the process alive, records new windows, and anchors them on retry", async () => {
  const ctx = await setup(1);
  await ctx.recorder.record(input(1), { evidence: 1 });
  await assert.doesNotReject(async () => assert.equal(await ctx.coordinator.tick(), 0));
  assert.equal(ctx.anchor.calls, 1);
  assert.equal(ctx.store.unanchoredBatches().length, 1);

  await ctx.recorder.record(input(2), { evidence: 2 });
  ctx.setNow(50);
  assert.equal(await ctx.coordinator.tick(), 0);
  assert.equal(ctx.anchor.calls, 1, "submission must wait for backoff");
  assert.equal(ctx.store.pendingForecasts().length, 0, "new forecast must still enter a prepared batch");
  assert.equal(ctx.store.unanchoredBatches().length, 2);

  ctx.setNow(100);
  assert.equal(await ctx.coordinator.tick(), 2);
  assert.equal(ctx.anchor.calls, 3);
  assert.equal(ctx.store.unanchoredBatches().length, 0);
  assert.ok(ctx.logs.some((line) => line.includes("ALERT anchor_failed") && line.includes("retry_in_ms=100")));
});

test("anchor retry delay grows exponentially and is capped", async () => {
  const ctx = await setup(3);
  await ctx.recorder.record(input(1), { evidence: 1 });
  await ctx.coordinator.tick();
  ctx.setNow(99);
  await ctx.coordinator.tick();
  assert.equal(ctx.anchor.calls, 1);
  ctx.setNow(100);
  await ctx.coordinator.tick();
  ctx.setNow(299);
  await ctx.coordinator.tick();
  assert.equal(ctx.anchor.calls, 2);
  ctx.setNow(300);
  await ctx.coordinator.tick();
  ctx.setNow(699);
  await ctx.coordinator.tick();
  assert.equal(ctx.anchor.calls, 3);
  ctx.setNow(700);
  assert.equal(await ctx.coordinator.tick(), 1);
  assert.deepEqual(
    ctx.logs.filter((line) => line.includes("ALERT anchor_failed")).map((line) => line.match(/retry_in_ms=(\d+)/)?.[1]),
    ["100", "200", "400"],
  );
});

test("low balance emits an alert without blocking anchoring", async () => {
  const ctx = await setup(0, 99n);
  await ctx.recorder.record(input(1), { evidence: 1 });
  assert.equal(await ctx.coordinator.tick(), 1);
  assert.ok(ctx.logs.some((line) => line === "ALERT low_balance balance_wei=99 threshold_wei=100"));
});

test("restart recovers and anchors a fsynced prepared batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anchor-recovery-"));
  const file = join(dir, "events.jsonl");
  const first = await AppendOnlyStore.open(file);
  const firstRecorder = new ForecastRecorder(first);
  await firstRecorder.record(input(1), { evidence: 1 });
  const prepared = await firstRecorder.preparePendingBatch();
  assert.ok(prepared);

  const restarted = await AppendOnlyStore.open(file);
  const logs: string[] = [];
  const coordinator = new AnchorCoordinator(new FakeAnchor(0), restarted, new ForecastRecorder(restarted), {
    retryBaseMs: 100,
    retryMaxMs: 400,
    balanceCheckMs: 1_000,
    lowBalanceWei: 100n,
    now: () => 0,
    log: (message) => logs.push(message),
  });
  assert.equal(await coordinator.tick(), 1);
  assert.equal(restarted.unanchoredBatches().length, 0);
  assert.equal(restarted.batchAnchorStatus(prepared.batch_id), "on_time");
  assert.ok(logs.some((line) => line.includes("anchored recovered batch")));
});

test("late anchor is explicit, auditable, and cannot be scored", async () => {
  const ctx = await setup(0);
  ctx.anchor.blockTimestamp = "2000000000";
  await ctx.recorder.record(input(1), { evidence: 1 });
  assert.equal(await ctx.coordinator.tick(), 1);
  assert.equal(ctx.store.forecastAnchorStatus(hex(1)), "anchored_late");
  const anchor = ctx.store.anchoredBatches()[0];
  assert.equal(anchor?.status, "anchored_late");
  assert.deepEqual(anchor?.late_market_ids, [hex(1)]);
  assert.ok(ctx.logs.some((line) => line.includes("ALERT anchored_late")));

  await ctx.store.addReveal({ market_id: hex(1), revealed_at_ns: "2000000001000000000", outcome: "YES" });
  await assert.rejects(() => ctx.store.addScore({
    market_id: hex(1),
    scored_at_ns: "2000000001000000001",
    outcome: "YES",
    brier_agent_e8: 20250000,
    brier_market_e8: 25000000,
  }), /on-time anchor/);
});
