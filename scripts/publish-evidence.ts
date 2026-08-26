import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPublishedEvidence, writeEvidenceDirectory } from "../src/evidence.js";
import { AppendOnlyStore } from "../src/store.js";

const source = resolve(process.env.RECORDER_STORE ?? "data/forecast-events.jsonl");
const directory = resolve(process.env.EVIDENCE_DIR ?? "evidence");
const store = await AppendOnlyStore.open(source);
const built = buildPublishedEvidence(store);

await mkdir(directory, { recursive: true });
await writeEvidenceDirectory(directory, built);

console.log(JSON.stringify({
  source,
  directory,
  published: built.manifest.totals.total,
  provable: built.manifest.totals.provable,
  anchored_late: built.manifest.totals.anchored_late,
  unresolved_not_published: built.unresolved,
  resolved_without_anchor_not_published: built.resolvedWithoutAnchor,
}, null, 2));
