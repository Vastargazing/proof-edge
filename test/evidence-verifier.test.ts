import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { canonicalForecast, canonicalHash, commitmentFor } from "../src/canonical.js";
import {
  verifyPublishedEvidence as verifyEvidence,
  type ChainAnchorReader,
  type ChainMarketReader,
} from "../src/evidence-verifier.js";
import { AppendOnlyStore } from "../src/store.js";
import type { ForecastPreimageV1, Hex32, PublishedForecastEvidence } from "../src/types.js";

const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const fixtureFile = resolve(
  "evidence/0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json",
);
const fixture = JSON.parse(await readFile(fixtureFile, "utf8")) as PublishedForecastEvidence;
const fixtureLedger = await AppendOnlyStore.open(resolve("published/forecast-events.jsonl"));
const fixtureBatch = fixtureLedger.preparedBatches().find((batch) =>
  batch.leaves.some((leaf) => leaf.market_id === fixture.market_id && leaf.commitment === fixture.commitment));
const fixtureContext = {
  expectedSubmitter: "0x2624F4553d622f0310c4a47D36aCFC1388dac365",
  riskDecision: fixtureLedger.riskDecisionsFor(fixture.market_id).at(0),
  expectedLeafCount: fixtureBatch?.leaves.length,
};
const verifyPublishedEvidence = (
  evidence: PublishedForecastEvidence,
  readAnchor: ChainAnchorReader,
  readMarket: ChainMarketReader,
  context = fixtureContext,
) => verifyEvidence(evidence, readAnchor, readMarket, context);
const readFixtureAnchor: ChainAnchorReader = async (transactionHash) => {
  if (transactionHash !== fixture.anchor_tx) throw new Error(`unknown anchor transaction ${transactionHash}`);
  return {
    events: [{ root: fixture.root, leafCount: BigInt(fixtureBatch!.leaves.length), submitter: fixtureContext.expectedSubmitter }],
    blockTimestamp: BigInt(fixture.anchor_block_timestamp),
  };
};
const readFixtureMarket: ChainMarketReader = async (marketId) => {
  if (marketId !== fixture.market_id) throw new Error(`unknown marketId ${marketId} on the module`);
  return {
    marketId,
    expiry: BigInt(fixture.preimage.expiry_ns) / 1_000_000_000n,
    winningOutcome: fixture.outcome === "YES" ? 0 : 1,
    isResolved: fixture.outcome !== "VOID",
    isVoided: fixture.outcome === "VOID",
  };
};
const printResult = (result: Awaited<ReturnType<typeof verifyPublishedEvidence>>): void => {
  for (const step of result.steps) console.log(`${step.status} ${step.step}/5 ${step.message}`);
};
const resealAsSingleLeaf = (value: PublishedForecastEvidence): void => {
  value.canonical_preimage = canonicalForecast(value.preimage);
  value.commitment = commitmentFor(value.preimage);
  value.root = value.commitment;
  value.leaf_index = 0;
  value.merkle_proof = [];
  value.leaf_count = 1;
};

test("negative step 1: one-digit p_agent mutation returns FAIL at canonical preimage", async () => {
  const tampered = structuredClone(fixture);
  tampered.preimage.p_agent = 0.2214;
  const result = await verifyPublishedEvidence(tampered, readFixtureAnchor, readFixtureMarket);
  printResult(result);
  assert.equal(result.status, "FAIL");
  assert.equal(result.steps.at(-1)?.step, 1);
  assert.equal(result.steps.at(-1)?.status, "FAIL");
  assert.match(result.steps.at(-1)?.message ?? "", /canonical_preimage/);
});

test("negative step 2: one Merkle sibling mutation returns FAIL at proof", async () => {
  const tampered = structuredClone(fixture);
  tampered.merkle_proof[0] = hex(0);
  const result = await verifyPublishedEvidence(tampered, readFixtureAnchor, readFixtureMarket);
  printResult(result);
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.steps.map((step) => step.status), ["PASS", "FAIL"]);
  assert.equal(result.steps.at(-1)?.step, 2);
});

test("negative step 1: tampered recorded risk decision returns FAIL with window id", async () => {
  const tampered = structuredClone(fixture);
  const decision = structuredClone(tampered.risk_decision ?? fixtureContext.riskDecision!);
  decision.allowed = !decision.allowed;
  tampered.risk_decision = decision;
  const result = await verifyPublishedEvidence(tampered, readFixtureAnchor, readFixtureMarket, {
    ...fixtureContext,
    riskDecision: decision,
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.steps.at(-1)?.step, 1);
  assert.match(result.steps.at(-1)?.message ?? "", /risk decision allowed/);
});

test("negative step 1: tampered model_hash returns FAIL against sealed manifest", async () => {
  const tampered = structuredClone(fixture);
  tampered.preimage.model_hash = hex(999);
  resealAsSingleLeaf(tampered);
  const result = await verifyPublishedEvidence(tampered, async () => ({
    events: [{ root: tampered.root, leafCount: 1n, submitter: fixtureContext.expectedSubmitter }],
    blockTimestamp: BigInt(tampered.anchor_block_timestamp),
  }), readFixtureMarket);
  assert.equal(result.status, "FAIL");
  assert.equal(result.steps.at(-1)?.step, 1);
  assert.match(result.steps.at(-1)?.message ?? "", /model_hash/);
});

test("negative step 3: foreign anchor_tx returns FAIL at on-chain root", async () => {
  const foreignTransaction = "0xaf9a9b6e7faa6283e8e6a1dcf195b6e21885c2747181206ed76d83f355111f1e" as Hex32;
  const foreignRoot = "0x5e759f913317c47f705c2df93b88c317872422d633471dcb7a1d642a512ef094" as Hex32;
  const tampered = structuredClone(fixture);
  tampered.anchor_tx = foreignTransaction;
  const result = await verifyPublishedEvidence(tampered, async (transactionHash) => {
    assert.equal(transactionHash, foreignTransaction);
    return {
      events: [{ root: foreignRoot, leafCount: 1n, submitter: fixtureContext.expectedSubmitter }],
      blockTimestamp: 1_787_676_797n,
    };
  }, readFixtureMarket);
  printResult(result);
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.steps.map((step) => step.status), ["PASS", "PASS", "FAIL"]);
  assert.equal(result.steps.at(-1)?.step, 3);
  assert.match(result.steps.at(-1)?.message ?? "", /on-chain root/);
});

test("negative step 3: foreign submitter returns FAIL", async () => {
  const result = await verifyPublishedEvidence(fixture, async () => ({
    events: [{ root: fixture.root, leafCount: BigInt(fixtureBatch!.leaves.length), submitter: "0x0000000000000000000000000000000000000001" }],
    blockTimestamp: BigInt(fixture.anchor_block_timestamp),
  }), readFixtureMarket);
  assert.equal(result.status, "FAIL");
  assert.equal(result.steps.at(-1)?.step, 3);
  assert.match(result.steps.at(-1)?.message ?? "", /submitter/);
});

test("negative step 3: mismatched event leafCount returns FAIL", async () => {
  const result = await verifyPublishedEvidence(fixture, async () => ({
    events: [{ root: fixture.root, leafCount: 3n, submitter: fixtureContext.expectedSubmitter }],
    blockTimestamp: BigInt(fixture.anchor_block_timestamp),
  }), readFixtureMarket);
  assert.equal(result.status, "FAIL");
  assert.equal(result.steps.at(-1)?.step, 3);
  assert.match(result.steps.at(-1)?.message ?? "", /leafCount mismatch/);
});

test("negative step 3: leaf_index outside disclosed tree returns FAIL", async () => {
  const tampered = structuredClone(fixture);
  tampered.leaf_index = fixtureBatch!.leaves.length;
  const result = await verifyPublishedEvidence(tampered, readFixtureAnchor, readFixtureMarket);
  assert.equal(result.status, "FAIL");
  assert.equal(result.steps.at(-1)?.step, 3);
  assert.match(result.steps.at(-1)?.message ?? "", /leaf_index .* outside leafCount/);
});

test("negative step 4: tampered expiry_ns fails against the on-chain market", async () => {
  const tampered = structuredClone(fixture);
  tampered.preimage.expiry_ns = (BigInt(fixture.preimage.expiry_ns) + 1_000_000_000n).toString();
  resealAsSingleLeaf(tampered);
  const result = await verifyPublishedEvidence(
    tampered,
    async () => ({
      events: [{ root: tampered.root, leafCount: 1n, submitter: fixtureContext.expectedSubmitter }],
      blockTimestamp: BigInt(tampered.anchor_block_timestamp),
    }),
    readFixtureMarket,
    { ...fixtureContext, expectedLeafCount: 1 },
  );
  printResult(result);
  assert.equal(result.status, "FAIL");
  assert.equal(result.steps.at(-1)?.step, 4);
  assert.match(result.steps.at(-1)?.message ?? "", /expiry_ns mismatch: chain .* file/);
});

test("negative step 4: tampered outcome fails against the on-chain market", async () => {
  const tampered = structuredClone(fixture);
  tampered.outcome = "NO";
  const result = await verifyPublishedEvidence(tampered, readFixtureAnchor, readFixtureMarket);
  printResult(result);
  assert.equal(result.status, "FAIL");
  assert.equal(result.steps.at(-1)?.step, 4);
  assert.match(result.steps.at(-1)?.message ?? "", /outcome mismatch: chain YES, file NO/);
});

test("negative step 4: tampered market_id fails as unknown on-chain", async () => {
  const tampered = structuredClone(fixture);
  tampered.market_id = hex(999_999);
  tampered.preimage.market_id = tampered.market_id;
  resealAsSingleLeaf(tampered);
  tampered.risk_decision = {
    ...(tampered.risk_decision ?? fixtureContext.riskDecision!),
    market_id: tampered.market_id,
  };
  const result = await verifyPublishedEvidence(
    tampered,
    async () => ({
      events: [{ root: tampered.root, leafCount: 1n, submitter: fixtureContext.expectedSubmitter }],
      blockTimestamp: BigInt(tampered.anchor_block_timestamp),
    }),
    readFixtureMarket,
    {
      ...fixtureContext,
      expectedLeafCount: 1,
      riskDecision: { ...fixtureContext.riskDecision!, market_id: tampered.market_id },
    },
  );
  printResult(result);
  assert.equal(result.status, "FAIL");
  assert.equal(result.steps.at(-1)?.step, 4);
  assert.match(result.steps.at(-1)?.message ?? "", /unknown marketId/);
});

test("negative step 5: synthetic late anchor returns NOT PROVABLE using nanoseconds", async () => {
  const manifest = {
    v: 1 as const,
    estimator: "test",
    code_commit: "test",
    package_versions: {},
    config: { edge: 0.03, max_disagreement: 0.1 },
  };
  const fullEvidence = { synthetic: "late-anchor", model_manifest: manifest };
  const preimage: ForecastPreimageV1 = {
    v: 1,
    market_id: hex(1),
    venue_id: hex(2),
    symbol: "BTC",
    interval_sec: 1,
    expiry_ns: "2000000000",
    p_agent: 0.5,
    side: "YES",
    p_market: 0.5,
    model_hash: canonicalHash(manifest),
    evidence_digest: canonicalHash(fullEvidence),
    nonce: hex(4),
  };
  const commitment = commitmentFor(preimage);
  const late: PublishedForecastEvidence = {
    market_id: preimage.market_id,
    observed_at_ns: "1000000000",
    preimage,
    canonical_preimage: canonicalForecast(preimage),
    commitment,
    evidence: fullEvidence,
    leaf_index: 0,
    merkle_proof: [],
    root: commitment,
    anchor_tx: hex(5),
    anchor_block_timestamp: "3",
    outcome: "YES",
    anchored_late: true,
  };
  const result = await verifyPublishedEvidence(late, async () => ({
    events: [{ root: commitment, leafCount: 1n, submitter: fixtureContext.expectedSubmitter }],
    blockTimestamp: 3n,
  }), async (marketId) => ({
    marketId,
    expiry: 2n,
    winningOutcome: 0,
    isResolved: true,
    isVoided: false,
  }), {
    expectedSubmitter: fixtureContext.expectedSubmitter,
    expectedLeafCount: 1,
    riskDecision: {
      market_id: preimage.market_id,
      decided_at_ns: "1",
      allowed: false,
      reason: "below-edge",
      absolute_edge_e4: 0,
      risk_config_hash: canonicalHash({
        v: 1,
        edge: 0.03,
        max_disagreement: 0.1,
        execution: "disabled-recorder-only",
      }),
    },
  });
  printResult(result);
  assert.equal(result.status, "NOT PROVABLE");
  assert.deepEqual(result.steps.map((step) => step.status), ["PASS", "PASS", "PASS", "PASS", "NOT PROVABLE"]);
  assert.equal(result.steps.at(-1)?.step, 5);
  assert.match(result.steps.at(-1)?.message ?? "", /anchor_ns 3000000000 is not before on-chain expiry_ns 2000000000/);
});
