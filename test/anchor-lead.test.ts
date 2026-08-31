import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  anchorLeadLines,
  anchorLeadSeconds,
  anchorLeadsFromLedger,
  DEFAULT_MIN_ANCHOR_LEAD_SEC,
  describeAnchorLead,
  evidenceAnchorLead,
  formatLeadSeconds,
  resolveMinAnchorLeadSec,
  summarizeAnchorLeads,
} from "../scripts/lib/anchor-lead.js";
import { describeVerification, verifyEvidenceInBrowser } from "../dashboard/app/verify-chain-browser.js";
import { FLAGSHIP_FILE } from "../scripts/lib/evidence-mirror.js";
import type { ChainAnchorReader, ChainMarketReader } from "../src/evidence-verifier.js";
import type { Hex32, PublishedForecastEvidence } from "../src/types.js";

const flagship = JSON.parse(
  await readFile(resolve(`evidence/${FLAGSHIP_FILE}`), "utf8"),
) as PublishedForecastEvidence;

/** An evidence-shaped record with an exact lead, built around a fixed expiry. */
const EXPIRY_SEC = 2_000_000_000n;
const at = (leadSec: number): Pick<PublishedForecastEvidence, "anchor_block_timestamp" | "preimage"> => ({
  anchor_block_timestamp: String(EXPIRY_SEC - BigInt(leadSec)),
  preimage: { expiry_ns: String(EXPIRY_SEC * 1_000_000_000n) } as PublishedForecastEvidence["preimage"],
});

test("the default threshold is the one the archive's low tail measured", () => {
  assert.equal(DEFAULT_MIN_ANCHOR_LEAD_SEC, 90);
  assert.equal(resolveMinAnchorLeadSec(undefined), 90);
  assert.equal(resolveMinAnchorLeadSec(""), 90);
  assert.equal(resolveMinAnchorLeadSec("  "), 90);
  assert.equal(resolveMinAnchorLeadSec("240"), 240);
  assert.equal(resolveMinAnchorLeadSec(" 0 "), 0, "0 disables the warning without hiding the measurement");
  assert.throws(() => resolveMinAnchorLeadSec("-1"), /non-negative integer/);
  assert.throws(() => resolveMinAnchorLeadSec("90.5"), /non-negative integer/);
  assert.throws(() => resolveMinAnchorLeadSec("soon"), /non-negative integer/);
});

test("threshold boundary: exactly at, one second under, one second over", () => {
  const threshold = DEFAULT_MIN_ANCHOR_LEAD_SEC;

  const exactly = evidenceAnchorLead(at(threshold), threshold);
  assert.equal(exactly.lead_sec, 90);
  assert.equal(exactly.low, false, "a lead equal to the minimum meets the minimum");
  assert.equal(exactly.warning, null);
  assert.equal(exactly.line, "ANCHOR_LEAD lead_sec=90 lead=1m30s threshold_sec=90");

  const under = evidenceAnchorLead(at(threshold - 1), threshold);
  assert.equal(under.lead_sec, 89);
  assert.equal(under.low, true);
  assert.equal(
    under.warning,
    "WARNING LOW_LEAD lead_sec=89 lead=1m29s is below threshold_sec=90; this is an annotation, not a verdict",
  );

  const over = evidenceAnchorLead(at(threshold + 1), threshold);
  assert.equal(over.lead_sec, 91);
  assert.equal(over.low, false);
  assert.equal(over.warning, null);

  // The warning is a second line, never a mutation of the measurement line.
  assert.deepEqual(anchorLeadLines(exactly), [exactly.line]);
  assert.deepEqual(anchorLeadLines(under), [under.line, under.warning]);
});

test("a custom threshold moves the boundary and only the boundary", () => {
  assert.equal(evidenceAnchorLead(at(240), 240).low, false);
  assert.equal(evidenceAnchorLead(at(239), 240).low, true);
  assert.equal(evidenceAnchorLead(at(239), 90).low, false);
  // Zero disables the warning; the lead is still reported.
  const disabled = evidenceAnchorLead(at(1), 0);
  assert.equal(disabled.low, false);
  assert.equal(disabled.warning, null);
  assert.equal(disabled.lead_sec, 1);
});

test("a record with no anchor timestamp reports no lead and raises no warning", () => {
  const missing = { preimage: { expiry_ns: "2000000000000000000" } } as PublishedForecastEvidence;
  const annotation = evidenceAnchorLead(missing, 90);
  assert.equal(annotation.lead_sec, null);
  assert.equal(annotation.low, false, "an unknown lead is never a LOW_LEAD warning");
  assert.equal(annotation.warning, null);
  assert.equal(annotation.reason, "missing_anchor_block_timestamp");
  assert.equal(
    annotation.line,
    "ANCHOR_LEAD lead_sec=null threshold_sec=90 reason=missing_anchor_block_timestamp",
  );

  const empty = evidenceAnchorLead({ ...missing, anchor_block_timestamp: "" }, 90);
  assert.equal(empty.reason, "missing_anchor_block_timestamp");

  const malformed = evidenceAnchorLead({ ...missing, anchor_block_timestamp: "0x6a8dcbbd" }, 90);
  assert.equal(malformed.lead_sec, null);
  assert.equal(malformed.reason, "malformed_anchor_block_timestamp");
  assert.equal(malformed.low, false);

  const noExpiry = evidenceAnchorLead(
    { anchor_block_timestamp: "1787677629", preimage: {} as PublishedForecastEvidence["preimage"] },
    90,
  );
  assert.equal(noExpiry.reason, "missing_expiry_ns");

  const badExpiry = evidenceAnchorLead(
    { anchor_block_timestamp: "1787677629", preimage: { expiry_ns: "later" } as PublishedForecastEvidence["preimage"] },
    90,
  );
  assert.equal(badExpiry.reason, "malformed_expiry_ns");
});

test("an anchor at or after expiry is not LOW_LEAD; step 5 already reports it", () => {
  // Exactly at expiry: step 5 calls this late, so the annotation stays quiet
  // rather than adding a second, weaker word for the same fact.
  const atExpiry = evidenceAnchorLead(at(0), 90);
  assert.equal(atExpiry.lead_sec, 0);
  assert.equal(atExpiry.low, false);
  assert.equal(atExpiry.warning, null);

  const after = evidenceAnchorLead(at(-30), 90);
  assert.equal(after.lead_sec, -30);
  assert.equal(after.low, false);
  assert.equal(after.warning, null);
  assert.equal(after.line, "ANCHOR_LEAD lead_sec=-30 lead=-30s threshold_sec=90");
});

test("sub-second lateness floors to a negative lead instead of rounding to zero", () => {
  // Expiry 400 ms after the anchor second: on time by 0.4 s, reported as 0 s.
  const early = anchorLeadSeconds("1000", "1000400000000");
  assert.equal(early.lead, 0n);
  // Expiry 400 ms before the anchor second: late, and must not read as 0 s.
  const late = anchorLeadSeconds("1000", "999600000000");
  assert.equal(late.lead, -1n);
  assert.equal(describeAnchorLead(late.lead, late.reason, 90).low, false);
});

test("lead seconds render without spaces so the whole line stays parseable", () => {
  assert.equal(formatLeadSeconds(0), "0s");
  assert.equal(formatLeadSeconds(44), "44s");
  assert.equal(formatLeadSeconds(90), "1m30s");
  assert.equal(formatLeadSeconds(3171), "52m51s");
  assert.equal(formatLeadSeconds(86382), "23h59m42s");
  assert.equal(formatLeadSeconds(-30), "-30s");
  for (const seconds of [0, 44, 90, 3171, 86382]) {
    assert.ok(!formatLeadSeconds(seconds).includes(" "), `${seconds} rendered with a space`);
  }
});

test("LOW_LEAD is visibly a warning and never one of the three verdicts", () => {
  const under = evidenceAnchorLead(at(44), 90);
  assert.ok(under.warning?.startsWith("WARNING LOW_LEAD "), under.warning ?? "no warning");
  assert.match(under.warning ?? "", /not a verdict/);
  for (const verdict of ["PASS", "FAIL", "NOT PROVABLE"]) {
    assert.notEqual("LOW_LEAD", verdict);
  }
  // The measurement line must not open with a verdict token either, so no
  // reader can mistake it for a sixth check.
  assert.ok(under.line.startsWith("ANCHOR_LEAD "));
  assert.ok(!/^(PASS|FAIL|NOT PROVABLE)\b/.test(under.line));
});

const stubbedReaders = (blockTimestamp: bigint): {
  readAnchor: ChainAnchorReader;
  readMarket: ChainMarketReader;
} => ({
  readAnchor: async () => ({
    events: [{ root: flagship.root, leafCount: 4n, submitter: "0x2624F4553d622f0310c4a47D36aCFC1388dac365" }],
    blockTimestamp,
  }),
  readMarket: async (marketId) => ({
    marketId,
    expiry: BigInt(flagship.preimage.expiry_ns) / 1_000_000_000n,
    winningOutcome: 0,
    isResolved: true,
    isVoided: false,
  }),
});

test("a legacy record far below the threshold verifies exactly as it does today", async () => {
  // The lowest-lead record in the archive: anchored 44 s before expiry, well
  // under the 90 s default, and PASSing today. Adding the annotation must not
  // move it. Built from the flagship so every other field is a real one.
  const expirySec = BigInt(flagship.preimage.expiry_ns) / 1_000_000_000n;
  const anchorSec = expirySec - 44n;
  const lowLead: PublishedForecastEvidence = {
    ...structuredClone(flagship),
    anchor_block_timestamp: String(anchorSec),
  };

  const result = await verifyEvidenceInBrowser(lowLead, stubbedReaders(anchorSec));

  // Every verdict-bearing value is byte-identical to the pre-annotation output.
  assert.equal(result.verdict, "PASS", "a thin lead is still a PASS, not a new verdict");
  assert.deepEqual(result.steps.map((step) => step.status), ["PASS", "PASS", "PASS", "PASS", "PASS"]);
  assert.equal(
    result.steps[4]?.line,
    `PASS 5/5 anchor_ns ${anchorSec * 1_000_000_000n} < on-chain expiry_ns ${flagship.preimage.expiry_ns}`,
    "the step 5 line itself is untouched by the annotation",
  );
  assert.equal(result.inputError, null);

  // The annotation rides alongside, and says so.
  assert.equal(result.anchorLead?.lead_sec, 44);
  assert.equal(result.anchorLead?.low, true);
  assert.equal(result.anchorLead?.threshold_sec, DEFAULT_MIN_ANCHOR_LEAD_SEC);
  assert.match(result.anchorLead?.warning ?? "", /^WARNING LOW_LEAD lead_sec=44 /);
});

test("the flagship forecast is annotated with its real 3,171 second lead", async () => {
  const anchorSec = BigInt(flagship.anchor_block_timestamp);
  const result = await verifyEvidenceInBrowser(flagship, stubbedReaders(anchorSec));
  assert.equal(result.verdict, "PASS");
  assert.equal(result.anchorLead?.lead_sec, 3171);
  assert.equal(result.anchorLead?.low, false);
  assert.equal(result.anchorLead?.warning, null);
  assert.equal(result.anchorLead?.line, "ANCHOR_LEAD lead_sec=3171 lead=52m51s threshold_sec=90");
});

test("the panel annotates only runs that reached step 5", () => {
  const step = (n: 1 | 2 | 3 | 4 | 5, status: "PASS" | "FAIL", message: string) => ({ step: n, status, message });

  // A run that stopped at step 3 has no chain-confirmed anchor time, so the
  // file's own claimed timestamp is never dressed up as a measurement.
  const early = describeVerification(flagship, {
    status: "FAIL",
    steps: [
      step(1, "PASS", "canonical preimage -> x"),
      step(2, "PASS", "Merkle proof -> x"),
      step(3, "FAIL", "on-chain root does not match"),
    ],
  });
  assert.equal(early.verdict, "FAIL");
  assert.equal(early.anchorLead, null);

  // A late anchor reaches step 5, so the margin is reported — as a negative
  // lead, with no LOW_LEAD warning competing with NOT PROVABLE.
  const late = describeVerification(
    { ...flagship, anchor_block_timestamp: String(BigInt(flagship.preimage.expiry_ns) / 1_000_000_000n + 5n) },
    {
      status: "NOT PROVABLE",
      steps: [
        step(1, "PASS", "canonical preimage -> x"),
        step(2, "PASS", "Merkle proof -> x"),
        step(3, "PASS", "agent x emitted root"),
        step(4, "PASS", "on-chain market x"),
        { step: 5, status: "NOT PROVABLE", message: "anchor_ns is not before on-chain expiry_ns" },
      ],
    },
  );
  assert.equal(late.verdict, "NOT PROVABLE");
  assert.equal(late.anchorLead?.lead_sec, -5);
  assert.equal(late.anchorLead?.low, false);
  assert.equal(late.anchorLead?.warning, null);
});

test("the distribution summary reproduces the archive's published figures", () => {
  // The measured tail below 300 s, plus one record per larger cadence.
  const leads = [44, 55, 55, 56, 62, 68, 71, 92, 99, 103, 876, 3573, 14370, 86382];
  const stats = summarizeAnchorLeads(leads, 90);
  assert.equal(stats.n, 14);
  assert.equal(stats.min_sec, 44);
  assert.equal(stats.max_sec, 86382);
  // Even sample: the mean of the two middle values, 71 and 92.
  assert.equal(stats.median_sec, 81.5);
  assert.equal(stats.below_threshold, 7, "44 through 71 are under 90; 92 is not");
  assert.equal(stats.not_before_expiry, 0);
  assert.equal(stats.threshold_sec, 90);
  assert.equal(stats.n_unavailable, 0);
  // Nearest rank: ceil(0.01 * 14) = 1, ceil(0.05 * 14) = 1, ceil(0.1 * 14) = 2.
  assert.equal(stats.p01_sec, 44);
  assert.equal(stats.p05_sec, 44);
  assert.equal(stats.p10_sec, 55);

  // An odd sample takes the middle value, not a mean.
  assert.equal(summarizeAnchorLeads([1, 2, 3], 90).median_sec, 2);
  // Input order never matters.
  assert.deepEqual(summarizeAnchorLeads([...leads].reverse(), 90), stats);
  // A late anchor is counted separately from a thin one.
  const mixed = summarizeAnchorLeads([-5, 0, 44, 500], 90);
  assert.equal(mixed.not_before_expiry, 2);
  assert.equal(mixed.below_threshold, 1);
});

test("an empty sample publishes nulls rather than a fabricated zero", () => {
  const stats = summarizeAnchorLeads([], 90, 3);
  assert.equal(stats.n, 0);
  assert.equal(stats.min_sec, null);
  assert.equal(stats.median_sec, null);
  assert.equal(stats.max_sec, null);
  assert.equal(stats.p01_sec, null);
  assert.equal(stats.below_threshold, 0);
  assert.equal(stats.n_unavailable, 3);
});

test("the ledger sample covers anchored forecasts and skips unanchored ones", () => {
  const id = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
  const expiry = (sec: number): string => String(BigInt(sec) * 1_000_000_000n);
  const anchors = new Map([[id(10), { block_timestamp: "1000" }], [id(20), { block_timestamp: "2000" }]]);
  const forecasts = new Map([
    [id(1), { preimage: { expiry_ns: expiry(1090) } }],   // lead 90
    [id(2), { preimage: { expiry_ns: expiry(1044) } }],   // lead 44
    [id(3), { preimage: { expiry_ns: expiry(2500) } }],   // lead 500
    [id(4), { preimage: { expiry_ns: expiry(9999) } }],   // batch never anchored
  ]);
  const { leads, unavailable } = anchorLeadsFromLedger({
    preparedBatches: () => [
      { batch_id: id(10), leaves: [{ market_id: id(1) }, { market_id: id(2) }] },
      { batch_id: id(20), leaves: [{ market_id: id(3) }, { market_id: id(5) }] },
      { batch_id: id(30), leaves: [{ market_id: id(4) }] },
    ],
    anchoredBatch: (batchId) => anchors.get(batchId),
    forecast: (marketId) => forecasts.get(marketId),
  });
  assert.deepEqual(leads.sort((a, b) => a - b), [44, 90, 500]);
  assert.equal(unavailable, 1, "a leaf with no readable forecast is counted, never guessed at");

  const stats = summarizeAnchorLeads(leads, 90, unavailable);
  assert.equal(stats.below_threshold, 1);
  assert.equal(stats.min_sec, 44);
  assert.equal(stats.median_sec, 90);
});
