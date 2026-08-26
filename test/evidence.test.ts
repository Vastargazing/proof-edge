import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalHash } from "../src/canonical.js";
import { buildPublishedEvidence, evidenceFileName, validatePublishedEvidence } from "../src/evidence.js";
import { ForecastRecorder } from "../src/recorder.js";
import { AppendOnlyStore } from "../src/store.js";
import type { ForecastPreimageV1, Hex32 } from "../src/types.js";

const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const input = (market: number, expiryNs: string): Omit<ForecastPreimageV1, "nonce"> & { nonce: Hex32 } => ({
  v: 1,
  market_id: hex(market),
  venue_id: hex(500),
  symbol: "BTC",
  interval_sec: 900,
  expiry_ns: expiryNs,
  p_agent: 0.55,
  side: "YES",
  p_market: 0.5,
  model_hash: canonicalHash({ model: 1 }),
  evidence_digest: canonicalHash({ evidence: market }),
  nonce: hex(900 + market),
});

test("evidence export reveals only resolved anchored records and counts late leaves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forecast-evidence-"));
  const store = await AppendOnlyStore.open(join(directory, "events.jsonl"));
  const recorder = new ForecastRecorder(store);
  await recorder.record(input(1, "2000000000"), { evidence: 1 });
  await recorder.record(input(2, "1000000000"), { evidence: 2 });
  await recorder.record(input(3, "2000000000"), { evidence: 3 });
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
    status: "anchored_late",
    late_market_ids: [hex(2)],
  });
  await store.addReveal({ market_id: hex(1), revealed_at_ns: "3", outcome: "YES" });
  await store.addReveal({ market_id: hex(2), revealed_at_ns: "3", outcome: "NO" });

  const built = buildPublishedEvidence(store);
  assert.equal(built.unresolved, 1);
  assert.equal(built.resolvedWithoutAnchor, 0);
  assert.deepEqual(built.manifest.totals, { total: 2, provable: 1, anchored_late: 1 });
  assert.equal(built.records.some((record) => record.value.market_id === hex(3)), false);
  for (const record of built.records) assert.equal(validatePublishedEvidence(record.value), record.value.commitment);

  const late = built.records.find((record) => record.value.market_id === hex(2));
  assert.equal(late?.value.anchored_late, true);
  assert.equal(late?.file, evidenceFileName(hex(2), late.value.observed_at_ns));
});

test("evidence validation rejects serialization drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forecast-evidence-"));
  const store = await AppendOnlyStore.open(join(directory, "events.jsonl"));
  const recorder = new ForecastRecorder(store);
  await recorder.record(input(1, "2000000000"), { evidence: 1 });
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
  await store.addReveal({ market_id: hex(1), revealed_at_ns: "3", outcome: "YES" });
  const record = buildPublishedEvidence(store).records[0]!.value;
  assert.throws(
    () => validatePublishedEvidence({ ...record, canonical_preimage: `${record.canonical_preimage} ` }),
    /canonical_preimage/,
  );
});
