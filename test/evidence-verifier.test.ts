import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { canonicalForecastV1, canonicalHash, commitmentFor } from "../src/canonical.js";
import {
  verifyPublishedEvidence,
  type ChainAnchorReader,
  type ChainMarketReader,
} from "../src/evidence-verifier.js";
import type { ForecastPreimageV1, Hex32, PublishedForecastEvidence } from "../src/types.js";

const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const fixtureFile = resolve(
  "evidence/0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json",
);
const fixture = JSON.parse(await readFile(fixtureFile, "utf8")) as PublishedForecastEvidence;
const readFixtureAnchor: ChainAnchorReader = async (transactionHash) => {
  if (transactionHash !== fixture.anchor_tx) throw new Error(`unknown anchor transaction ${transactionHash}`);
  return { roots: [fixture.root], blockTimestamp: BigInt(fixture.anchor_block_timestamp) };
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
  value.canonical_preimage = canonicalForecastV1(value.preimage);
  value.commitment = commitmentFor(value.preimage);
  value.root = value.commitment;
  value.leaf_index = 0;
  value.merkle_proof = [];
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

test("negative step 3: foreign anchor_tx returns FAIL at on-chain root", async () => {
  const foreignTransaction = "0xaf9a9b6e7faa6283e8e6a1dcf195b6e21885c2747181206ed76d83f355111f1e" as Hex32;
  const foreignRoot = "0x5e759f913317c47f705c2df93b88c317872422d633471dcb7a1d642a512ef094" as Hex32;
  const tampered = structuredClone(fixture);
  tampered.anchor_tx = foreignTransaction;
  const result = await verifyPublishedEvidence(tampered, async (transactionHash) => {
    assert.equal(transactionHash, foreignTransaction);
    return { roots: [foreignRoot], blockTimestamp: 1_787_676_797n };
  }, readFixtureMarket);
  printResult(result);
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.steps.map((step) => step.status), ["PASS", "PASS", "FAIL"]);
  assert.equal(result.steps.at(-1)?.step, 3);
  assert.match(result.steps.at(-1)?.message ?? "", /on-chain root/);
});

test("negative step 4: tampered expiry_ns fails against the on-chain market", async () => {
  const tampered = structuredClone(fixture);
  tampered.preimage.expiry_ns = (BigInt(fixture.preimage.expiry_ns) + 1_000_000_000n).toString();
  resealAsSingleLeaf(tampered);
  const result = await verifyPublishedEvidence(
    tampered,
    async () => ({ roots: [tampered.root], blockTimestamp: BigInt(tampered.anchor_block_timestamp) }),
    readFixtureMarket,
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
  const result = await verifyPublishedEvidence(
    tampered,
    async () => ({ roots: [tampered.root], blockTimestamp: BigInt(tampered.anchor_block_timestamp) }),
    readFixtureMarket,
  );
  printResult(result);
  assert.equal(result.status, "FAIL");
  assert.equal(result.steps.at(-1)?.step, 4);
  assert.match(result.steps.at(-1)?.message ?? "", /unknown marketId/);
});

test("negative step 5: synthetic late anchor returns NOT PROVABLE using nanoseconds", async () => {
  const fullEvidence = { synthetic: "late-anchor" };
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
    model_hash: hex(3),
    evidence_digest: canonicalHash(fullEvidence),
    nonce: hex(4),
  };
  const commitment = commitmentFor(preimage);
  const late: PublishedForecastEvidence = {
    market_id: preimage.market_id,
    observed_at_ns: "1000000000",
    preimage,
    canonical_preimage: canonicalForecastV1(preimage),
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
    roots: [commitment],
    blockTimestamp: 3n,
  }), async (marketId) => ({
    marketId,
    expiry: 2n,
    winningOutcome: 0,
    isResolved: true,
    isVoided: false,
  }));
  printResult(result);
  assert.equal(result.status, "NOT PROVABLE");
  assert.deepEqual(result.steps.map((step) => step.status), ["PASS", "PASS", "PASS", "PASS", "NOT PROVABLE"]);
  assert.equal(result.steps.at(-1)?.step, 5);
  assert.match(result.steps.at(-1)?.message ?? "", /anchor_ns 3000000000 is not before on-chain expiry_ns 2000000000/);
});
