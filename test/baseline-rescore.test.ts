import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MIN_SIZE,
  assertSealedMidpoint,
  depthWeightedBaseline,
  midpointBaseline,
  minSizeBaseline,
  parseSealedRecord,
  rescoreAgainstBaseline,
  type BookLevel,
  type SealedRecord,
} from "../scripts/lib/baseline-rescore.js";
import { probabilityOnGrid } from "../src/canonical.js";
import { buildResolveScoreReport, type ScoringRecord } from "../src/scoring.js";
import type { ForecastScore, Hex32, ResolvedOutcome } from "../src/types.js";

const id = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;

interface Fixture {
  market: number;
  pAgent: number;
  pMarket: number;
  outcome: ResolvedOutcome;
  bids: BookLevel[];
  asks: BookLevel[];
  anchoredLate?: boolean;
  riskAllowed?: boolean;
}

/** The published evidence shape, only as far as a rescore reads it. */
function published(fixture: Fixture): unknown {
  return {
    market_id: id(fixture.market),
    observed_at_ns: String(1_787_677_626_190_000_000n + BigInt(fixture.market)),
    preimage: {
      v: 1,
      market_id: id(fixture.market),
      p_agent: fixture.pAgent,
      p_market: fixture.pMarket,
      model_hash: id(0xd0de1),
    },
    evidence: {
      v: 1,
      yes_book: { bids: fixture.bids, asks: fixture.asks },
      p_market_raw: fixture.pMarket,
    },
    risk_decision: fixture.riskAllowed === undefined
      ? undefined
      : { market_id: id(fixture.market), allowed: fixture.riskAllowed },
    leaf_index: 0,
    merkle_proof: [],
    root: id(0x8007),
    anchor_tx: id(0x7),
    anchor_block_timestamp: "1787677629",
    outcome: fixture.outcome,
    anchored_late: fixture.anchoredLate === true,
  };
}

const sealed = (fixture: Fixture): SealedRecord => parseSealedRecord(
  `${id(fixture.market)}-fixture.json`,
  published(fixture),
);

// A full 200/330/460 ladder: 1,949 of the 1,963 real books disclose three bid
// levels and 1,952 disclose three ask levels.
const fullLadder: Fixture = {
  market: 1,
  pAgent: 0.5,
  pMarket: 0.42,
  outcome: "YES",
  bids: [[0.40, 200], [0.39, 330], [0.38, 460]],
  asks: [[0.44, 200], [0.45, 330], [0.46, 460]],
  riskAllowed: true,
};

// A 5-lot top bid against 400-lot depth: the case the whole exercise is about.
const thinTop: Fixture = {
  market: 2,
  pAgent: 0.3,
  pMarket: 0.65,
  outcome: "NO",
  bids: [[0.60, 5], [0.55, 400]],
  asks: [[0.70, 400], [0.75, 400]],
  riskAllowed: false,
};

// Both quotes carry zero size: a midpoint exists, depth does not.
const zeroSized: Fixture = {
  market: 4,
  pAgent: 0.1,
  pMarket: 0.32,
  outcome: "YES",
  bids: [[0.30, 0]],
  asks: [[0.34, 0]],
  riskAllowed: true,
};

const lateAnchor: Fixture = { ...fullLadder, market: 5, anchoredLate: true };
const voided: Fixture = { ...fullLadder, market: 6, outcome: "VOID" };

test("midpoint reproduces the sealed p_market of every record bit-for-bit", () => {
  const records = [fullLadder, thinTop, zeroSized, lateAnchor, voided].map(sealed);
  assert.equal(assertSealedMidpoint(records), 5);

  // The reproduction is exact only because the raw midpoint is put back on the
  // frozen 1e-4 grid the way the recorder did (src/live-recorder.ts:247).
  assert.equal(midpointBaseline(sealed(thinTop).yes_book), 0.6499999999999999);
  assert.equal(probabilityOnGrid(0.6499999999999999), 0.65);
});

test("a sealed p_market the disclosed book cannot reproduce names the file", () => {
  const tampered = sealed({ ...thinTop, pMarket: 0.6501 });
  assert.throws(
    () => assertSealedMidpoint([tampered]),
    (error: Error) => (
      error.message.includes(tampered.file)
      && error.message.includes("0.65")
      && error.message.includes("0.6501")
    ),
    "the self-test must report which file diverged and both probabilities",
  );
});

test("midpoint rescoring equals what the published pipeline computes on the same records", () => {
  const fixtures = [fullLadder, thinTop, zeroSized, lateAnchor, voided];
  const rescored = rescoreAgainstBaseline(fixtures.map(sealed), { baseline: "midpoint" });

  // The pipeline side is built from the sealed probabilities with the Brier
  // expression written out as it stands in src/live-recorder.ts:328, so the two
  // sides agree only if the script never re-rounded anything of its own.
  const pipelineScore = (fixture: Fixture): ForecastScore => {
    const observed = fixture.outcome === "YES" ? 1 : 0;
    const brier = (p: number): number => Math.round((p - observed) ** 2 * 100_000_000);
    return {
      market_id: id(fixture.market),
      scored_at_ns: String(1_787_677_626_190_000_000n + BigInt(fixture.market)),
      outcome: fixture.outcome === "YES" ? "YES" : "NO",
      brier_agent_e8: brier(fixture.pAgent),
      brier_market_e8: brier(fixture.pMarket),
    };
  };
  const scoringRecords: ScoringRecord[] = fixtures.map((fixture) => ({
    market_id: id(fixture.market),
    model_hash: id(0xd0de1),
    p_agent: fixture.pAgent,
    p_market: fixture.pMarket,
    anchor_status: fixture.anchoredLate === true ? "anchored_late" : "on_time",
    outcome: fixture.outcome,
    score: fixture.outcome === "VOID" ? undefined : pipelineScore(fixture),
    risk_allowed: fixture.riskAllowed,
  }));
  const pipeline = buildResolveScoreReport(scoringRecords).all_evaluated_windows;

  assert.equal(rescored.estimate.n, pipeline.n);
  assert.equal(rescored.estimate.brier_agent, pipeline.brier_agent);
  assert.equal(rescored.estimate.brier_market, pipeline.brier_market);
  assert.equal(rescored.estimate.skill_score, pipeline.skill_score);
  assert.deepEqual(rescored.estimate.skill_score_ci_95, pipeline.skill_score_ci_95);

  // The same window selection, stated as numbers rather than trusted.
  assert.equal(rescored.estimate.n, 3);
  assert.equal(rescored.eligible, 3);
  assert.deepEqual(rescored.exclusions, { anchored_late: 1, voided: 1 });
  assert.equal(rescored.skipped_by_baseline.length, 0);
});

test("depth_weighted averages price by size inside each side", () => {
  // bids (0.60*5 + 0.55*400) / 405 = 0.5506172839506173
  // asks (0.70*400 + 0.75*400) / 800 = 0.725
  // midpoint of the two sides = 0.6378086419753086
  const raw = depthWeightedBaseline(sealed(thinTop).yes_book);
  assert.equal(raw, 0.6378086419753086);
  assert.equal(probabilityOnGrid(raw!), 0.6378);

  const rescored = rescoreAgainstBaseline([thinTop, fullLadder].map(sealed), { baseline: "depth_weighted" });
  assert.equal(rescored.estimate.n, 2);
  assert.equal(rescored.skipped_by_baseline.length, 0);
});

test("min_size demotes an undersized top of book to the next qualifying level", () => {
  const book = sealed(thinTop).yes_book;
  // The 5-lot 0.60 bid drops out; 0.55 against 0.70 is the first pair that clears 200.
  assert.equal(minSizeBaseline(book, DEFAULT_MIN_SIZE), 0.625);
  assert.equal(probabilityOnGrid(0.625), 0.625);
  // A threshold no level meets removes the record rather than falling back.
  assert.equal(minSizeBaseline(book, 500), null);
});

test("min_size drops a record with no qualifying level instead of reusing the top quote", () => {
  const rescored = rescoreAgainstBaseline([fullLadder, thinTop].map(sealed), {
    baseline: "min_size",
    minSize: 500,
  });
  assert.equal(rescored.eligible, 2);
  assert.equal(rescored.estimate.n, 0);
  assert.equal(rescored.min_size, 500);
  assert.equal(rescored.skipped_by_baseline.length, 2);
  assert.match(rescored.skipped_by_baseline[0]!.reason, /no level of size >= 500 on both sides/);
  assert.equal(rescored.skipped_by_baseline[0]!.file, sealed(fullLadder).file);
});

test("an empty book level yields no depth instead of a NaN baseline", () => {
  const book = sealed(zeroSized).yes_book;
  // The midpoint ignores size, so the sealed p_market still reproduces.
  assert.equal(probabilityOnGrid(midpointBaseline(book)!), 0.32);
  assert.equal(assertSealedMidpoint([sealed(zeroSized)]), 1);
  // Zero total size makes the weighted mean undefined; it must not become NaN.
  assert.equal(depthWeightedBaseline(book), null);
  assert.equal(minSizeBaseline(book, DEFAULT_MIN_SIZE), null);

  const rescored = rescoreAgainstBaseline([fullLadder, zeroSized].map(sealed), { baseline: "depth_weighted" });
  assert.equal(rescored.eligible, 2);
  assert.equal(rescored.estimate.n, 1);
  assert.equal(rescored.skipped_by_baseline.length, 1);
  assert.equal(rescored.skipped_by_baseline[0]!.market_id, id(4));
});

test("a one-sided book prices no baseline and is reported, never guessed", () => {
  const oneSided: Fixture = { ...fullLadder, market: 8, asks: [] };
  const record = sealed(oneSided);
  assert.equal(midpointBaseline(record.yes_book), null);
  assert.equal(depthWeightedBaseline(record.yes_book), null);
  assert.equal(minSizeBaseline(record.yes_book, DEFAULT_MIN_SIZE), null);

  // The recorder refuses such a market (missing_market_midpoint), so a sealed
  // p_market beside a one-sided book is a contradiction the self-test must raise.
  assert.throws(
    () => assertSealedMidpoint([record]),
    (error: Error) => error.message.includes(record.file) && error.message.includes("two-sided"),
  );

  const rescored = rescoreAgainstBaseline([fullLadder, oneSided].map(sealed), { baseline: "midpoint" });
  assert.equal(rescored.estimate.n, 1);
  assert.equal(rescored.skipped_by_baseline.length, 1);
  assert.equal(rescored.skipped_by_baseline[0]!.market_id, id(8));
});

test("a file with no retained evidence body is refused rather than skipped", () => {
  const body = published(fullLadder) as Record<string, unknown>;
  delete body["evidence"];
  assert.throws(
    () => parseSealedRecord("smoke-batch.json", body),
    /smoke-batch\.json: no retained evidence body/,
  );
  assert.throws(
    () => parseSealedRecord("broken.json", { ...published(fullLadder) as object, evidence: { v: 1 } }),
    /broken\.json: evidence\.yes_book is missing/,
  );
});
