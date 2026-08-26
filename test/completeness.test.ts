import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCompleteness, type OnchainRootAnchor } from "../src/completeness.js";
import type { BatchPrepared, Hex32 } from "../src/types.js";

const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const anchor = (root: number, leaves: number, tx = root): OnchainRootAnchor => ({
  root: hex(root),
  leafCount: BigInt(leaves),
  transactionHash: hex(tx),
  blockNumber: BigInt(tx),
});
const batch = (root: number, markets: number[]): BatchPrepared => ({
  batch_id: hex(root),
  root: hex(root),
  prepared_at_ns: "1",
  leaves: markets.map((market, index) => ({
    market_id: hex(market),
    commitment: hex(root * 100 + market),
    index,
    proof: [],
  })),
});

test("completeness lists undisclosed roots with their on-chain leaf count", () => {
  const report = analyzeCompleteness([anchor(1, 2), anchor(2, 7)], [batch(1, [10, 11])]);
  assert.equal(report.undisclosed.length, 1);
  assert.equal(report.undisclosed[0]?.root, hex(2));
  assert.equal(report.undisclosed[0]?.leafCount, 7n);
  assert.deepEqual(report.ledgerRootsMissingOnchain, []);
});

test("completeness flags disclosed overlapping windows, duplicates, and count mismatches", () => {
  const report = analyzeCompleteness(
    [anchor(1, 2, 101), anchor(1, 2, 102), anchor(2, 9, 103)],
    [batch(1, [10, 11]), batch(2, [10])],
  );
  assert.deepEqual(report.overlappingWindows, [{ marketId: hex(10), roots: [hex(1), hex(2)] }]);
  assert.equal(report.duplicateRootAnchors.length, 1);
  assert.deepEqual(report.duplicateRootAnchors[0]?.transactions, [hex(101), hex(102)]);
  assert.deepEqual(report.leafCountMismatches, [{ root: hex(2), chain: "9", ledger: 1 }]);
});

