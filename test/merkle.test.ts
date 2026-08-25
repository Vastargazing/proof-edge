import assert from "node:assert/strict";
import test from "node:test";
import { buildForecastBatch, verifyProof } from "../src/merkle.js";
import type { ForecastObserved, Hex32 } from "../src/types.js";

const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const record = (n: number): ForecastObserved => ({
  market_id: hex(100 - n),
  observed_at_ns: String(n),
  preimage: {} as ForecastObserved["preimage"],
  canonical_preimage: "{}",
  commitment: hex(n),
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
