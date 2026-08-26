import assert from "node:assert/strict";
import test from "node:test";
import { verifyEmittedRootAnchor } from "../src/chain-verifier.js";
import type { BatchPrepared, Hex32 } from "../src/types.js";

const hex = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const batch: BatchPrepared = {
  batch_id: hex(1),
  root: hex(1),
  prepared_at_ns: "1",
  ledger_head: hex(100),
  leaves: [{ market_id: hex(2), commitment: hex(3), index: 0, proof: [] }],
};

test("chain anchor accepts the exact ledger head", () => {
  assert.doesNotThrow(() => verifyEmittedRootAnchor(batch, {
    root: batch.root,
    leafCount: 1n,
    ledgerHead: hex(100),
  }));
});

test("deleting a prior ledger batch and rechaining produces a ledger head FAIL", () => {
  const rewrittenAfterBatchDeletion = { ...batch, ledger_head: hex(99) };
  assert.throws(() => verifyEmittedRootAnchor(rewrittenAfterBatchDeletion, {
    root: batch.root,
    leafCount: 1n,
    ledgerHead: hex(100),
  }), /ledger head mismatch: chain .* ledger/);
});

test("a forward-format batch cannot pass against a legacy root-only event", () => {
  assert.throws(() => verifyEmittedRootAnchor(batch, {
    root: batch.root,
    leafCount: 1n,
  }), /ledger head missing/);
});
