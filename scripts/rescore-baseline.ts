import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BASELINE_NAMES,
  DEFAULT_MIN_SIZE,
  assertSealedMidpoint,
  parseSealedRecord,
  rescoreAgainstBaseline,
  selectEligible,
  type BaselineName,
  type RescoreResult,
  type SealedRecord,
} from "./lib/baseline-rescore.js";

const USAGE = `Rescore the sealed record against a different market baseline.

  npx tsx scripts/rescore-baseline.ts [--baseline=<name>] [--min-size=N] [--dir=evidence] [--json]

  --baseline   midpoint (default) | depth_weighted | min_size | all
  --min-size   size threshold for min_size, default ${DEFAULT_MIN_SIZE}
  --dir        evidence directory to read, default evidence
  --published  published snapshot to reconcile N against,
               default dashboard/app/forecast-data.json
  --json       emit the result objects instead of the table

Read-only. No key, no RPC, no transaction.`;

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  return found?.slice(prefix.length);
}

if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
  console.log(USAGE);
  process.exit(0);
}

// A mistyped flag must not read the default evidence directory and print a
// table that looks like an answer to the question the operator asked.
const KNOWN_FLAGS = ["baseline", "min-size", "dir", "published"];
const unknown = process.argv.slice(2).filter((argument) => (
  argument !== "--json" && !KNOWN_FLAGS.some((name) => argument.startsWith(`--${name}=`))
));
if (unknown.length > 0) {
  console.error(`unrecognised argument(s): ${unknown.join(" ")}\n\n${USAGE}`);
  process.exit(2);
}

const requested = flag("baseline") ?? "midpoint";
if (requested !== "all" && !BASELINE_NAMES.includes(requested as BaselineName)) {
  console.error(`unknown baseline ${requested}; expected one of ${BASELINE_NAMES.join(", ")} or all`);
  process.exit(2);
}
const baselines: BaselineName[] = requested === "all" ? [...BASELINE_NAMES] : [requested as BaselineName];

const minSizeArgument = flag("min-size");
const minSize = minSizeArgument === undefined ? DEFAULT_MIN_SIZE : Number(minSizeArgument);
if (!Number.isFinite(minSize) || minSize <= 0) {
  console.error(`--min-size must be a positive number, received ${minSizeArgument}`);
  process.exit(2);
}

const evidenceDir = resolve(flag("dir") ?? "evidence");
const publishedSnapshot = resolve(flag("published") ?? "dashboard/app/forecast-data.json");
const asJson = process.argv.slice(2).includes("--json");

const fileNames = (await readdir(evidenceDir))
  .filter((name) => name.endsWith(".json") && name !== "index.json")
  .sort();
if (fileNames.length === 0) throw new Error(`${evidenceDir} holds no evidence files`);

const records: SealedRecord[] = [];
for (const name of fileNames) {
  records.push(parseSealedRecord(name, JSON.parse(await readFile(resolve(evidenceDir, name), "utf8"))));
}

// Always, whichever baseline was asked for. The other two baselines are only
// meaningful if the book we parsed is the book that was sealed, and the sealed
// p_market is the one value that can prove it.
const selfTested = assertSealedMidpoint(records);
const eligible = selectEligible(records).length;
const results = baselines.map((baseline) => rescoreAgainstBaseline(records, { baseline, minSize }));

/** Read-only reconciliation against the hourly publisher's own N. */
async function publishedWindowCount(): Promise<number | null> {
  try {
    const snapshot = JSON.parse(await readFile(publishedSnapshot, "utf8")) as {
      resolve_score?: { all_evaluated_windows?: { n?: unknown } };
    };
    const n = snapshot.resolve_score?.all_evaluated_windows?.n;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

const decimals = (value: number | null, digits: number): string => (
  value === null ? "-" : value.toFixed(digits)
);

function renderTable(rows: readonly RescoreResult[]): string {
  const header = ["baseline", "min_size", "N", "brier_agent", "brier_baseline", "skill", "95% CI"];
  const body = rows.map((row) => [
    row.baseline,
    row.min_size === null ? "-" : String(row.min_size),
    String(row.estimate.n),
    decimals(row.estimate.brier_agent, 6),
    decimals(row.estimate.brier_market, 6),
    decimals(row.estimate.skill_score, 4),
    row.estimate.skill_score_ci_95 === null
      ? "-"
      : `[${row.estimate.skill_score_ci_95.low.toFixed(4)}, ${row.estimate.skill_score_ci_95.high.toFixed(4)}]`,
  ]);
  const widths = header.map((cell, column) => Math.max(
    cell.length,
    ...body.map((row) => row[column]!.length),
  ));
  const line = (cells: readonly string[]): string => cells
    .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)))
    .join("  ")
    .trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

if (asJson) {
  console.log(JSON.stringify({
    evidence_dir: evidenceDir,
    scanned: records.length,
    eligible,
    midpoint_self_test: { checked: selfTested, divergences: 0 },
    published_all_evaluated_windows: await publishedWindowCount(),
    results,
  }, null, 2));
} else {
  console.log(`evidence            ${evidenceDir}`);
  console.log(`scanned             ${records.length} files, ${eligible} on-time resolved windows`);
  console.log(`midpoint self-test  ${selfTested}/${records.length} records reproduce the sealed p_market bit-for-bit`);

  const publishedN = await publishedWindowCount();
  if (publishedN !== null && publishedN !== eligible) {
    console.log(`reconciliation      published resolve_score N=${publishedN}, rescorable N=${eligible}, gap ${publishedN - eligible}.`);
    console.log("                    A window with no retained evidence body discloses no order book and");
    console.log("                    cannot be rescored; the documented case is the six-leaf smoke batch");
    console.log("                    (deployments/shannon.json:39-43, docs/RECORD_FORMAT.md section 6).");
  }
  console.log("");
  console.log(renderTable(results));

  for (const result of results) {
    if (result.skipped_by_baseline.length === 0) continue;
    console.log("");
    console.log(`${result.baseline}: ${result.skipped_by_baseline.length} of ${eligible} eligible windows left the sample`);
    for (const skipped of result.skipped_by_baseline.slice(0, 5)) {
      console.log(`  ${skipped.file} ${skipped.reason}`);
    }
    if (result.skipped_by_baseline.length > 5) {
      console.log(`  ... ${result.skipped_by_baseline.length - 5} more`);
    }
  }
}
