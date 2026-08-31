import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../../src/evidence.js";
import type {
  MirroredEvidenceEntry,
  MirroredEvidenceIndex,
} from "../../dashboard/app/verify-chain-browser.js";
import type { EvidenceManifest, PublishedForecastEvidence } from "../../src/types.js";

/**
 * The forecast README walks through and the browser panel opens first. Kept
 * whatever its age, so the documented example never falls out of the mirror.
 */
export const FLAGSHIP_FILE =
  "0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json";

/**
 * How many recent forecasts join the flagship in `dashboard/public/evidence/`.
 *
 * Twelve, because the mirror is a demo surface and not a second archive. On the
 * current snapshot that is 13 files, ~128 KB of static assets, seven distinct
 * anchor roots and one screen of picker options — enough that the panel is
 * plainly not replaying one memorised transaction, while a page load still
 * fetches only the index and one ~10 KB file. The count is fixed rather than a
 * fraction of the 1,963-file archive so the mirror cannot grow with it.
 */
export const MIRROR_RECENT_COUNT = 12;

const OBSERVED_AT_NS = /-(\d+)\.json$/;

/** `observed_at_ns` from the `<market_id>-<observed_at_ns>.json` filename. */
function observedAtNs(file: string): bigint {
  const match = OBSERVED_AT_NS.exec(file);
  if (!match?.[1]) throw new Error(`evidence file name carries no observed_at_ns: ${file}`);
  return BigInt(match[1]);
}

/**
 * The flagship plus the `count` newest entries, newest first.
 *
 * The manifest is ordered by filename (market id, then observation time), so
 * recency is taken from the filename timestamp and ties break on the filename.
 * Deterministic for a given manifest: the same input always mirrors the same
 * files in the same order.
 */
export function selectMirroredFiles(
  manifest: EvidenceManifest,
  count = MIRROR_RECENT_COUNT,
  flagship = FLAGSHIP_FILE,
): string[] {
  const byRecency = manifest.entries
    .map((entry) => entry.file)
    .sort((a, b) => {
      const left = observedAtNs(a);
      const right = observedAtNs(b);
      if (left !== right) return left > right ? -1 : 1;
      return a.localeCompare(b);
    });
  const hasFlagship = manifest.entries.some((entry) => entry.file === flagship);
  const limit = count + (hasFlagship ? 1 : 0);
  const selected: string[] = hasFlagship ? [flagship] : [];
  for (const file of byRecency) {
    if (selected.length >= limit) break;
    if (file === flagship) continue;
    selected.push(file);
  }
  return selected;
}

function entryFor(file: string, value: PublishedForecastEvidence, flagship: string): MirroredEvidenceEntry {
  return {
    file,
    market_id: value.market_id,
    symbol: value.preimage.symbol,
    interval_sec: value.preimage.interval_sec,
    observed_at_ns: value.observed_at_ns,
    expiry_ns: value.preimage.expiry_ns,
    outcome: value.outcome,
    anchored_late: value.anchored_late,
    anchor_tx: value.anchor_tx,
    root: value.root,
    leaf_index: value.leaf_index,
    leaf_count: value.leaf_count ?? null,
    flagship: file === flagship,
  };
}

/**
 * Mirrors the selected evidence bodies into the dashboard's static assets so a
 * judge can verify one forecast in the browser with no clone and no install.
 * The directory is rewritten from scratch each run: it is a derived view of
 * `evidence/`, never a second archive.
 */
export async function mirrorEvidenceForDashboard(
  evidenceDirectory: string,
  mirrorDirectory: string,
  manifest: EvidenceManifest,
  count = MIRROR_RECENT_COUNT,
  flagship = FLAGSHIP_FILE,
): Promise<{ directory: string; files: string[] }> {
  const files = selectMirroredFiles(manifest, count, flagship);
  await mkdir(mirrorDirectory, { recursive: true });
  const keep = new Set([...files, "index.json"]);
  for (const stale of await readdir(mirrorDirectory)) {
    if (!keep.has(stale)) await rm(join(mirrorDirectory, stale), { recursive: true });
  }

  const entries: MirroredEvidenceEntry[] = [];
  for (const file of files) {
    const value = JSON.parse(await readFile(join(evidenceDirectory, file), "utf8")) as PublishedForecastEvidence;
    await writeJsonAtomic(join(mirrorDirectory, file), value);
    entries.push(entryFor(file, value, flagship));
  }
  const index: MirroredEvidenceIndex = {
    generated_from: "evidence/index.json",
    flagship,
    entries,
  };
  await writeJsonAtomic(join(mirrorDirectory, "index.json"), index);
  return { directory: mirrorDirectory, files };
}
