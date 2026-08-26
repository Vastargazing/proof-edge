import type { BatchPrepared, Hex32 } from "./types.js";

export interface EmittedRootAnchor {
  root: Hex32;
  leafCount: bigint;
  ledgerHead?: Hex32;
}

export function verifyEmittedRootAnchor(batch: BatchPrepared, emitted: EmittedRootAnchor): void {
  if (emitted.root !== batch.root) {
    throw new Error(`root mismatch: chain ${emitted.root}, ledger ${batch.root}`);
  }
  if (emitted.leafCount !== BigInt(batch.leaves.length)) {
    throw new Error(`leaf count mismatch: chain ${emitted.leafCount}, ledger ${batch.leaves.length}`);
  }
  if (batch.ledger_head !== undefined) {
    if (emitted.ledgerHead === undefined) throw new Error("ledger head missing from on-chain anchor");
    if (emitted.ledgerHead !== batch.ledger_head) {
      throw new Error(`ledger head mismatch: chain ${emitted.ledgerHead}, ledger ${batch.ledger_head}`);
    }
  }
}
