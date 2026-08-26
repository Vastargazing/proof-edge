import assert from "node:assert/strict";
import test from "node:test";
import { buildForecastBatch, verifyProof } from "../src/merkle.js";
import type { ForecastObserved, Hex32 } from "../src/types.js";

const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const record = (n: number): ForecastObserved => ({
  market_id: hex(100 - n),
  observed_at_ns: String(n),
  preimage: { v: 1 } as ForecastObserved["preimage"],
  canonical_preimage: "{}",
  commitment: hex(n),
});
const recordV2 = (n: number): ForecastObserved => ({
  ...record(n),
  preimage: { v: 2 } as ForecastObserved["preimage"],
});

test("ordered Merkle proofs verify for odd and even leaf counts", () => {
  for (const count of [1, 2, 3, 8, 9]) {
    const batch = buildForecastBatch(Array.from({ length: count }, (_, index) => record(index + 1)));
    assert.equal(batch.leaves.length, count);
    for (const leaf of batch.leaves) {
      assert.equal(verifyProof(batch.root, leaf.commitment, leaf.proof, leaf.index), true);
      assert.equal(verifyProof(batch.root, hex(999), leaf.proof, leaf.index), false);
    }
  }
});

test("batch ordering is deterministic by market id", () => {
  const a = buildForecastBatch([record(1), record(2), record(3)]);
  const b = buildForecastBatch([record(3), record(1), record(2)]);
  assert.equal(a.root, b.root);
  assert.deepEqual(a.leaves, b.leaves);
});

test("v2 domain-separates leaves and internal nodes without changing v1", () => {
  const v1 = buildForecastBatch([record(1), record(2), record(3)]);
  const v2 = buildForecastBatch([recordV2(1), recordV2(2), recordV2(3)]);
  assert.equal(v1.merkleVersion, 1);
  assert.equal(v2.merkleVersion, 2);
  assert.notEqual(v2.root, v1.root);
  for (const leaf of v2.leaves) {
    assert.equal(leaf.merkle_version, 2);
    assert.equal(verifyProof(v2.root, leaf.commitment, leaf.proof, leaf.index, 2), true);
    assert.equal(verifyProof(v2.root, leaf.commitment, leaf.proof, leaf.index, 1), false);
  }
});

test("one batch cannot mix legacy and domain-separated leaves", () => {
  assert.throws(() => buildForecastBatch([record(1), recordV2(2)]), /cannot mix v1 and v2/);
});
