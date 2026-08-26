import { randomBytes } from "node:crypto";
import { canonicalForecastV1, commitmentFor } from "./canonical.js";
import { buildForecastBatch } from "./merkle.js";
import type { AppendOnlyStore } from "./store.js";
import type { BatchPrepared, ForecastPreimageV1, Hex32 } from "./types.js";

const nowNs = (): string => (BigInt(Date.now()) * 1_000_000n).toString();

export class ForecastRecorder {
  constructor(private readonly store: AppendOnlyStore) {}

  async record(preimage: Omit<ForecastPreimageV1, "nonce"> & { nonce?: Hex32 }, evidence: unknown): Promise<{
    created: boolean;
    commitment: Hex32;
  }> {
    const complete: ForecastPreimageV1 = {
      ...preimage,
      nonce: preimage.nonce ?? (`0x${randomBytes(32).toString("hex")}` as Hex32),
    };
    const canonical = canonicalForecastV1(complete);
    const commitment = commitmentFor(complete);
    const result = await this.store.addForecast({
      market_id: complete.market_id,
      observed_at_ns: nowNs(),
      preimage: complete,
      canonical_preimage: canonical,
      commitment,
      evidence,
    });
    return { created: result.created, commitment: result.value.commitment };
  }

  async preparePendingBatch(): Promise<BatchPrepared | null> {
    const pending = this.store.pendingForecasts();
    if (pending.length === 0) return null;
    const tree = buildForecastBatch(pending);
    const batch: BatchPrepared = {
      batch_id: tree.root,
      root: tree.root,
      prepared_at_ns: nowNs(),
      ledger_head: this.store.headHash(),
      leaves: tree.leaves,
    };
    await this.store.addPreparedBatch(batch);
    return batch;
  }
}
