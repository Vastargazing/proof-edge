import { readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalForecastV1, commitmentFor } from "./canonical.js";
import { evidenceDigest } from "./model.js";
import type { AppendOnlyStore } from "./store.js";
import type {
  EvidenceManifest,
  EvidenceManifestEntry,
  Hex32,
  PublishedForecastEvidence,
} from "./types.js";

const HEX32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const EVIDENCE_FILE = /^0x[0-9a-f]{64}-[0-9]+\.json$/;

export function evidenceFileName(marketId: Hex32, observedAtNs: string): string {
  if (!HEX32.test(marketId)) throw new Error("market_id must be lowercase bytes32");
  if (!DECIMAL.test(observedAtNs)) throw new Error("observed_at_ns must be a canonical decimal string");
  return `${marketId}-${observedAtNs}.json`;
}

export function buildPublishedEvidence(store: AppendOnlyStore): {
  records: { file: string; value: PublishedForecastEvidence }[];
  manifest: EvidenceManifest;
  unresolved: number;
  resolvedWithoutAnchor: number;
  withoutFullEvidence: number;
} {
  const locations = new Map<Hex32, {
    leafIndex: number;
    proof: Hex32[];
    root: Hex32;
    anchorTx: Hex32;
    anchorBlockTimestamp: string;
  }>();

  for (const batch of store.preparedBatches()) {
    const anchor = store.anchoredBatch(batch.batch_id);
    if (!anchor) continue;
    for (const leaf of batch.leaves) {
      if (locations.has(leaf.market_id)) throw new Error(`market appears in multiple anchored batches: ${leaf.market_id}`);
      locations.set(leaf.market_id, {
        leafIndex: leaf.index,
        proof: leaf.proof,
        root: batch.root,
        anchorTx: anchor.transaction_hash,
        anchorBlockTimestamp: anchor.block_timestamp,
      });
    }
  }

  let unresolved = 0;
  let resolvedWithoutAnchor = 0;
  let withoutFullEvidence = 0;
  const records: { file: string; value: PublishedForecastEvidence }[] = [];
  for (const forecast of store.allForecasts()) {
    const outcome = store.revealedOutcome(forecast.market_id);
    if (outcome === undefined) {
      unresolved++;
      continue;
    }
    if (forecast.evidence === undefined) {
      withoutFullEvidence++;
      continue;
    }
    const location = locations.get(forecast.market_id);
    if (!location) {
      resolvedWithoutAnchor++;
      continue;
    }
    const value: PublishedForecastEvidence = {
      market_id: forecast.market_id,
      observed_at_ns: forecast.observed_at_ns,
      preimage: forecast.preimage,
      canonical_preimage: forecast.canonical_preimage,
      commitment: forecast.commitment,
      evidence: forecast.evidence,
      leaf_index: location.leafIndex,
      merkle_proof: location.proof,
      root: location.root,
      anchor_tx: location.anchorTx,
      anchor_block_timestamp: location.anchorBlockTimestamp,
      outcome,
      anchored_late: BigInt(location.anchorBlockTimestamp) * 1_000_000_000n >= BigInt(forecast.preimage.expiry_ns),
    };
    records.push({ file: evidenceFileName(forecast.market_id, forecast.observed_at_ns), value });
  }

  records.sort((a, b) => a.file.localeCompare(b.file));
  const entries: EvidenceManifestEntry[] = records.map(({ file, value }) => ({
    leaf_index: value.leaf_index,
    file,
    root: value.root,
    anchor_tx: value.anchor_tx,
    anchored_late: value.anchored_late,
  }));
  const anchoredLate = entries.filter((entry) => entry.anchored_late).length;
  return {
    records,
    manifest: {
      entries,
      totals: {
        total: entries.length,
        provable: entries.length - anchoredLate,
        anchored_late: anchoredLate,
      },
    },
    unresolved,
    resolvedWithoutAnchor,
    withoutFullEvidence,
  };
}

export function validatePublishedEvidence(value: PublishedForecastEvidence): Hex32 {
  if (value.market_id !== value.preimage.market_id) throw new Error("market_id does not match preimage");
  if (!DECIMAL.test(value.observed_at_ns)) throw new Error("observed_at_ns must be a canonical decimal string");
  if (!HEX32.test(value.commitment)) throw new Error("commitment must be lowercase bytes32");
  if (!HEX32.test(value.root)) throw new Error("root must be lowercase bytes32");
  if (!HEX32.test(value.anchor_tx)) throw new Error("anchor_tx must be lowercase bytes32");
  if (!DECIMAL.test(value.anchor_block_timestamp)) {
    throw new Error("anchor_block_timestamp must be a canonical decimal string");
  }
  if (!Number.isSafeInteger(value.leaf_index) || value.leaf_index < 0) {
    throw new Error("leaf_index must be a non-negative safe integer");
  }
  if (!Array.isArray(value.merkle_proof) || value.merkle_proof.some((item) => !HEX32.test(item))) {
    throw new Error("merkle_proof must contain lowercase bytes32 values");
  }
  if (value.outcome !== "YES" && value.outcome !== "NO" && value.outcome !== "VOID") {
    throw new Error("outcome must be YES, NO, or VOID");
  }
  if (typeof value.anchored_late !== "boolean") throw new Error("anchored_late must be boolean");

  const canonical = canonicalForecastV1(value.preimage);
  if (canonical !== value.canonical_preimage) {
    throw new Error("canonical_preimage does not match frozen recorder canonicalization");
  }
  const leaf = commitmentFor(value.preimage);
  if (leaf !== value.commitment) throw new Error("commitment does not match canonical preimage");
  if (value.evidence !== undefined && evidenceDigest(value.evidence) !== value.preimage.evidence_digest) {
    throw new Error("evidence_digest does not match the full evidence payload");
  }
  return leaf;
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, file);
}

export async function writeEvidenceDirectory(
  directory: string,
  built: ReturnType<typeof buildPublishedEvidence>,
): Promise<void> {
  const expected = new Set(built.records.map((record) => record.file));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && EVIDENCE_FILE.test(entry.name) && !expected.has(entry.name)) {
      await unlink(join(directory, entry.name));
    }
  }
  for (const record of built.records) await writeJsonAtomic(join(directory, record.file), record.value);
  await writeJsonAtomic(join(directory, "index.json"), built.manifest);
}
