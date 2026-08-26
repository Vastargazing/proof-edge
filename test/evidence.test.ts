import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalForecastV1, canonicalHash, commitmentFor } from "../src/canonical.js";
import {
  buildPublishedEvidence,
  evidenceFileName,
  validatePublishedEvidence,
  writeEvidenceDirectory,
} from "../src/evidence.js";
import { ForecastRecorder } from "../src/recorder.js";
import { AppendOnlyStore } from "../src/store.js";
import type { ForecastPreimageV1, Hex32, PublishedForecastEvidence } from "../src/types.js";

const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const modelManifest = {
  v: 1 as const,
  estimator: "test",
  code_commit: "test",
  package_versions: {},
  config: { edge: 0.03, max_disagreement: 0.1 },
};
const fullEvidence = (market: number) => ({ evidence: market, model_manifest: modelManifest });
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
  model_hash: canonicalHash(modelManifest),
  evidence_digest: canonicalHash(fullEvidence(market)),
  nonce: hex(900 + market),
});

test("evidence export reveals only resolved anchored records and counts late leaves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forecast-evidence-"));
  const store = await AppendOnlyStore.open(join(directory, "events.jsonl"));
  const recorder = new ForecastRecorder(store);
  await recorder.record(input(1, "2000000000"), fullEvidence(1));
  await recorder.record(input(2, "1000000000"), fullEvidence(2));
  await recorder.record(input(3, "2000000000"), fullEvidence(3));
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
  await recorder.record(input(1, "2000000000"), fullEvidence(1));
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
  await store.addReveal({ market_id: hex(1), revealed_at_ns: "3", outcome: "YES" });
  const record = buildPublishedEvidence(store).records[0]!.value;
  assert.throws(
    () => validatePublishedEvidence({ ...record, canonical_preimage: `${record.canonical_preimage} ` }),
    /canonical_preimage/,
  );
});

test("public evidence excludes pre-v1 smoke forecasts without observation bodies", async () => {
  const store = await AppendOnlyStore.open(resolve("published/forecast-events.jsonl"));
  const built = buildPublishedEvidence(store);
  assert.equal(built.manifest.totals.total, built.records.length);
  assert.equal(built.manifest.totals.provable + built.manifest.totals.anchored_late, built.records.length);
  assert.ok(built.records.length >= 4);
  assert.equal(built.withoutFullEvidence, 6);
  assert.equal(built.records.every((record) => record.value.evidence !== undefined), true);
});

test("exporter preserves verifiable stale files and quarantines rejected bytes with a reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forecast-evidence-prune-"));
  const preimage = input(999, "2000000000");
  const commitment = commitmentFor(preimage);
  const stale: PublishedForecastEvidence = {
    market_id: preimage.market_id,
    observed_at_ns: "1",
    preimage,
    canonical_preimage: canonicalForecastV1(preimage),
    commitment,
    evidence: fullEvidence(999),
    leaf_index: 0,
    merkle_proof: [],
    root: commitment,
    anchor_tx: hex(123),
    anchor_block_timestamp: "1",
    outcome: "YES",
    anchored_late: false,
  };
  const built = {
    records: [],
    manifest: { entries: [], totals: { total: 0, provable: 0, anchored_late: 0 } },
    unresolved: 0,
    resolvedWithoutAnchor: 0,
    withoutFullEvidence: 0,
  };
  const protectedName = `${hex(999)}-1.json`;
  const invalidName = `${hex(998)}-2.json`;
  const rejectedBytes = `${JSON.stringify({
    ...stale,
    canonical_preimage: `${stale.canonical_preimage} `,
  }, null, 2)}\n`;
  await writeFile(join(directory, protectedName), `${JSON.stringify(stale, null, 2)}\n`, "utf8");
  await writeFile(join(directory, invalidName), rejectedBytes, "utf8");
  const logs: string[] = [];

  await writeEvidenceDirectory(directory, built, (message) => logs.push(message));

  await assert.doesNotReject(() => readFile(join(directory, protectedName), "utf8"));
  await assert.rejects(() => readFile(join(directory, invalidName), "utf8"), { code: "ENOENT" });
  assert.equal(
    await readFile(join(directory, "_rejected", invalidName, "evidence.json"), "utf8"),
    rejectedBytes,
  );
  const reason = JSON.parse(
    await readFile(join(directory, "_rejected", invalidName, "reason.json"), "utf8"),
  ) as { original_file: string; reason: string };
  assert.equal(reason.original_file, invalidName);
  assert.match(reason.reason, /^step_1_failed:canonical_preimage/);
  assert.ok(logs.some((line) => line ===
    `KEEP evidence_file=${protectedName} reason=passes_local_verification`));
  assert.ok(logs.some((line) => line.startsWith(
    `QUARANTINE evidence_file=${invalidName} destination=_rejected/${invalidName}/evidence.json reason=step_1_failed:`,
  )));

  await writeFile(join(directory, invalidName), "{\"changed\":true}\n", "utf8");
  await writeEvidenceDirectory(directory, built, (message) => logs.push(message));
  assert.equal(await readFile(join(directory, invalidName), "utf8"), "{\"changed\":true}\n");
  assert.equal(
    await readFile(join(directory, "_rejected", invalidName, "evidence.json"), "utf8"),
    rejectedBytes,
  );
  assert.ok(logs.some((line) => line ===
    `KEEP evidence_file=${invalidName} reason=quarantine_destination_exists`));
});
