import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPublishedEvidence, writeEvidenceDirectory } from "../src/evidence.js";
import { AppendOnlyStore } from "../src/store.js";
import { mirrorEvidenceForDashboard, MIRROR_RECENT_COUNT } from "./lib/evidence-mirror.js";

const source = resolve(process.env.RECORDER_STORE ?? "data/forecast-events.jsonl");
const directory = resolve(process.env.EVIDENCE_DIR ?? "evidence");
const store = await AppendOnlyStore.open(source);
const built = buildPublishedEvidence(store);

await mkdir(directory, { recursive: true });
await writeEvidenceDirectory(directory, built);

// The dashboard is a static page, so the browser verifier can only read
// evidence that ships as an asset. Mirror a bounded, deterministic subset.
// EVIDENCE_MIRROR=0 turns it off for the hourly publisher: PUBLICATION_PATHS in
// src/publisher.ts does not list dashboard/public/evidence, and that file is
// sealed into the running recorder's model_hash until 2026-09-08, so writing
// there mid-run would trip the publisher's own non-publication-path guard.
const mirrorEnabled = process.env.EVIDENCE_MIRROR !== "0";
const mirrorCount = Number(process.env.EVIDENCE_MIRROR_COUNT ?? MIRROR_RECENT_COUNT);
// A misspelled value must not turn a bounded mirror into a copy of the archive.
if (!Number.isSafeInteger(mirrorCount) || mirrorCount < 0) {
  throw new Error(`EVIDENCE_MIRROR_COUNT must be a non-negative safe integer, got ${process.env.EVIDENCE_MIRROR_COUNT}`);
}
const mirrored = mirrorEnabled
  ? await mirrorEvidenceForDashboard(
    directory,
    resolve(process.env.EVIDENCE_MIRROR_DIR ?? "dashboard/public/evidence"),
    built.manifest,
    mirrorCount,
  )
  : null;

console.log(JSON.stringify({
  source,
  directory,
  mirror_directory: mirrored?.directory ?? null,
  mirrored_files: mirrored?.files.length ?? 0,
  published: built.manifest.totals.total,
  provable: built.manifest.totals.provable,
  anchored_late: built.manifest.totals.anchored_late,
  unresolved_not_published: built.unresolved,
  resolved_without_anchor_not_published: built.resolvedWithoutAnchor,
  without_full_evidence_not_published: built.withoutFullEvidence,
}, null, 2));
