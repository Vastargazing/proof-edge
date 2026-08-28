// Rewrites the marked statistics blocks in README.md from the published
// dashboard snapshot, so the prose can never disagree with the file it cites.
// Invoked by scripts/publish-and-push.ts on every publisher run; run manually
// with: npx tsx scripts/render-readme-stats.ts
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface SkillSample {
  n: number;
  brier_agent: number;
  brier_market: number;
  skill_score: number;
  skill_score_ci_95: { low: number; high: number; resamples: number };
}

interface ForecastData {
  totals: {
    forecasts: number;
    pending_resolution: number;
    provable_forecasts: number;
    anchored_late_forecasts: number;
    unanchored_forecasts: number;
    anchors: number;
  };
  resolve_score: {
    all_evaluated_windows: SkillSample;
    risk_gate_passed: SkillSample;
    by_model_hash: { model_hash: string; all_evaluated_windows: SkillSample; risk_gate_passed?: SkillSample }[];
  };
  completeness: {
    watermark_block: string;
    onchain_anchors: number;
    disclosed_roots: number;
    undisclosed_roots: number;
    scope: {
      selected_by: string;
      submitter: string;
      emitter_periods: { address: string; from_block: string }[];
      through_block: string;
      environment_overrides: string[];
    };
  };
}

const dataPath = resolve("dashboard/app/forecast-data.json");
const readmePath = resolve("README.md");
const data = JSON.parse(await readFile(dataPath, "utf8")) as ForecastData;

// Typographic minus, matching the hand-written prose this replaces.
const num = (value: number, digits = 4): string => value.toFixed(digits).replace("-", "−");

const ORDINALS = [
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth", "eleventh", "twelfth",
];

const { totals, resolve_score: scores, completeness } = data;
const all = scores.all_evaluated_windows;
const gate = scores.risk_gate_passed;
const models = scores.by_model_hash;
const current = models[models.length - 1];
if (current === undefined) throw new Error("forecast-data.json has no by_model_hash entries");
const ordinal = ORDINALS[models.length - 1] ?? `${models.length}th`;

const lossPercent = ((all.brier_agent / all.brier_market - 1) * 100).toFixed(1);
const hook = all.skill_score < 0
  ? `Our estimator's Brier loss was ${lossPercent}% worse than the market's. We know\n`
    + "because every probability in that result was committed before the answer\n"
    + "existed; once anchored, those bytes cannot be edited after the fact."
  : `Our estimator's Brier loss was ${num(Number(lossPercent), 1)}% of the market's. We know because\n`
    + "every probability in that result was committed before the answer existed;\n"
    + "once anchored, those bytes cannot be edited after the fact.";

const pendingSentence = totals.pending_resolution === 0
  ? "Every forecast in the published snapshot was resolved."
  : totals.pending_resolution === 1
    ? "1 newer forecast was still waiting for resolution in the published snapshot."
    : `${totals.pending_resolution} newer forecasts were still waiting for resolution in the published snapshot.`;
const anchorSentence = totals.unanchored_forecasts === 0 && totals.anchored_late_forecasts === 0
  ? "None was unanchored or anchored late"
  : `${totals.unanchored_forecasts} were unanchored and ${totals.anchored_late_forecasts} anchored late`;

const headline =
  `**${totals.forecasts} forecasts · ${totals.anchors} on-chain anchors · ${totals.provable_forecasts} public proofs · `
  + `${completeness.undisclosed_roots} undisclosed\nproduction roots · Brier skill ${num(all.skill_score, 3)} across `
  + `${models.length} model versions at N=${all.n}.** The\n`
  + "skill figure is the mixed historical total, not the result of the current model\n"
  + `version; its two samples are reported separately below. ${pendingSentence}\n`
  + `${anchorSentence}\n`
  + "(`dashboard/app/forecast-data.json`, keys `totals` and `resolve_score`).";

const skillMixed =
  "Across the mixed historical record, the estimator's mean Brier score is\n"
  + `\`${num(all.brier_agent)}\`; the market's is \`${num(all.brier_market)}\`. Skill is \`${num(all.skill_score)}\`, with a deterministic\n`
  + `${all.skill_score_ci_95.resamples.toLocaleString("en-US")}-resample 95% interval from \`${num(all.skill_score_ci_95.low)}\` to \`${num(all.skill_score_ci_95.high)}\` at \`N=${all.n}\`\n`
  + "(`dashboard/app/forecast-data.json`, key `resolve_score.all_evaluated_windows`).\n"
  + (all.skill_score < 0 ? "That is a loss. We display it." : "We display it either way.");

const gateCross = gate.skill_score_ci_95.low < 0 && gate.skill_score_ci_95.high > 0
  ? "The interval crosses zero, and"
  : "The interval does not cross zero, but";
const skillGate =
  `The mixed-history risk-gate subset is \`${num(gate.skill_score)}\` at \`N=${gate.n}\`, with an interval from\n`
  + `\`${num(gate.skill_score_ci_95.low)}\` to \`${num(gate.skill_score_ci_95.high)}\`\n`
  + "(`dashboard/app/forecast-data.json`, key `resolve_score.risk_gate_passed`). We\n"
  + `do not call that an edge. ${gateCross} the aggregate mixes\n`
  + `${models.length} sealed \`model_hash\` values.`;

const currentAll = current.all_evaluated_windows;
const currentGate = current.risk_gate_passed;
const currentGateSentence = currentGate === undefined
  ? "It has no risk-gate PASS windows yet"
  : `Its risk-gate subset is \`${num(currentGate.skill_score)}\` at \`N=${currentGate.n}\`, with an interval from\n`
    + `\`${num(currentGate.skill_score_ci_95.low)}\` to \`${num(currentGate.skill_score_ci_95.high)}\``;
const smallSample = Math.min(currentAll.n, currentGate?.n ?? currentAll.n) < 30
  ? " Those sample\nsizes are too small for a performance claim; the figures are diagnostic."
  : "";
const skillCurrent =
  `The current ${ordinal} version is reported on its own. Across all evaluated\n`
  + `windows, skill is \`${num(currentAll.skill_score)}\` at \`N=${currentAll.n}\`, with a 95% interval from \`${num(currentAll.skill_score_ci_95.low)}\` to\n`
  + `\`${num(currentAll.skill_score_ci_95.high)}\`. ${currentGateSentence}\n`
  + `(\`dashboard/app/forecast-data.json\`, key \`resolve_score.by_model_hash[${models.length - 1}]\`).`
  + smallSample;

const hiddenRoots = completeness.undisclosed_roots === 0 ? "zero" : `${completeness.undisclosed_roots}`;
const emitterScope = completeness.scope.emitter_periods
  .map((period) => `\`${period.address}\` from block \`${period.from_block}\``)
  .join(",\n");
const completenessBlock =
  `At watermark block \`${completeness.watermark_block}\`, the audit sees ${completeness.onchain_anchors} on-chain\n`
  + `roots, ${completeness.disclosed_roots} disclosed roots and ${hiddenRoots} hidden roots\n`
  + `inside the scope selected by ${completeness.scope.selected_by}: submitter\n`
  + `\`${completeness.scope.submitter}\`; ${emitterScope}. The exact values used for\n`
  + "this snapshot are stored at `dashboard/app/forecast-data.json`, key\n"
  + "`completeness.scope`; a different invocation can select a different scope.";

const sections: Record<string, string> = {
  hook,
  headline,
  "skill-mixed": skillMixed,
  "skill-gate": skillGate,
  "skill-current": skillCurrent,
  completeness: completenessBlock,
};

let readme = await readFile(readmePath, "utf8");
for (const [name, body] of Object.entries(sections)) {
  const begin = `<!-- generated:${name} -->`;
  const end = `<!-- /generated:${name} -->`;
  const beginAt = readme.indexOf(begin);
  const endAt = readme.indexOf(end);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    throw new Error(`README.md is missing the generated:${name} marker pair`);
  }
  readme = `${readme.slice(0, beginAt + begin.length)}\n${body}\n${readme.slice(endAt)}`;
}
await writeFile(readmePath, readme);
console.log(`readme: statistics blocks synchronized from ${dataPath}`);
