import { randomBytes } from "node:crypto";
import { canonicalForecast, commitmentFor } from "./canonical.js";
import { buildForecastBatch } from "./merkle.js";
import type { AppendOnlyStore } from "./store.js";
import type {
  BatchPrepared,
  ForecastPreimage,
  ForecastPreimageV1,
  ForecastPreimageV2,
  Hex32,
} from "./types.js";

const nowNs = (): string => (BigInt(Date.now()) * 1_000_000n).toString();

export class ForecastRecorder {
  constructor(private readonly store: AppendOnlyStore) {}

  async record(
    preimage: (Omit<ForecastPreimageV1, "nonce"> | Omit<ForecastPreimageV2, "nonce">) & { nonce?: Hex32 },
    evidence: unknown,
  ): Promise<{
    created: boolean;
    commitment: Hex32;
  }> {
    const complete = {
      ...preimage,
      nonce: preimage.nonce ?? (`0x${randomBytes(32).toString("hex")}` as Hex32),
    } as ForecastPreimage;
    const canonical = canonicalForecast(complete);
    const commitment = commitmentFor(complete);
    const result = await this.store.addForecast({
      market_id: complete.market_id,
      observed_at_ns: complete.v === 2 ? complete.observed_at_ns : nowNs(),
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
    const version = pending[0]!.preimage.v;
    const tree = buildForecastBatch(pending.filter((forecast) => forecast.preimage.v === version));
    const batch: BatchPrepared = {
      batch_id: tree.root,
      root: tree.root,
      prepared_at_ns: nowNs(),
      ledger_head: this.store.headHash(),
      ...(tree.merkleVersion === 2 ? { merkle_version: 2 as const } : {}),
      leaves: tree.leaves,
    };
    await this.store.addPreparedBatch(batch);
    return batch;
  }
}
