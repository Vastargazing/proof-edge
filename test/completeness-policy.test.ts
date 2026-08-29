import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCompleteness, type OnchainRootAnchor } from "../src/completeness.js";
import { acceptedDuplicateAnchors, blockingCompletenessFailures } from "../scripts/completeness-policy.js";
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

test("a resend of a disclosed root that the ledger anchors is accepted, not blocking", () => {
  const report = analyzeCompleteness([anchor(1, 1, 10), anchor(1, 1, 11)], [batch(1, [7])]);
  const accepted = acceptedDuplicateAnchors(report, new Map([[hex(1), hex(11)]]));
  assert.deepEqual(accepted.map((item) => [item.root, item.transactions, item.ledger_transaction]), [
    [hex(1), [hex(10), hex(11)], hex(11)],
  ]);
  assert.deepEqual(blockingCompletenessFailures(report, accepted), []);
});

test("a duplicate the ledger does not anchor still blocks publication", () => {
  const report = analyzeCompleteness([anchor(1, 1, 10), anchor(1, 1, 11)], [batch(1, [7])]);
  const accepted = acceptedDuplicateAnchors(report, new Map([[hex(1), hex(99)]]));
  assert.deepEqual(accepted, []);
  assert.deepEqual(blockingCompletenessFailures(report, accepted), [
    `root anchored multiple times ${hex(1)} txs=${hex(10)},${hex(11)}`,
  ]);
});

test("a duplicate of an undisclosed root is never accepted", () => {
  const report = analyzeCompleteness([anchor(2, 1, 20), anchor(2, 1, 21)], []);
  const accepted = acceptedDuplicateAnchors(report, new Map([[hex(2), hex(21)]]));
  assert.deepEqual(accepted, []);
  assert.equal(
    blockingCompletenessFailures(report, accepted).includes(
      `root anchored multiple times ${hex(2)} txs=${hex(20)},${hex(21)}`,
    ),
    true,
  );
});

test("a duplicate whose leaf count disagrees with the ledger is never accepted", () => {
  const report = analyzeCompleteness([anchor(3, 2, 30), anchor(3, 2, 31)], [batch(3, [7])]);
  const accepted = acceptedDuplicateAnchors(report, new Map([[hex(3), hex(31)]]));
  assert.deepEqual(accepted, []);
  assert.equal(blockingCompletenessFailures(report, accepted).length, 2);
});

test("accepting a duplicate hides no other finding", () => {
  const report = analyzeCompleteness(
    [anchor(1, 1, 10), anchor(1, 1, 11), anchor(4, 1, 40)],
    [batch(1, [7]), batch(5, [8])],
  );
  const accepted = acceptedDuplicateAnchors(report, new Map([[hex(1), hex(11)]]));
  assert.deepEqual(blockingCompletenessFailures(report, accepted), [
    `undisclosed root ${hex(4)} leaf_count=1 tx=${hex(40)}`,
    `ledger root missing on-chain ${hex(5)}`,
  ]);
});
