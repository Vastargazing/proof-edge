import type { EventOnlyAnchor } from "./emitter.js";
import type { ForecastRecorder } from "./recorder.js";
import type { AppendOnlyStore } from "./store.js";

export interface AnchorCoordinatorOptions {
  retryBaseMs: number;
  retryMaxMs: number;
  balanceCheckMs: number;
  lowBalanceWei: bigint;
  now?: () => number;
  log?: (message: string) => void;
}

type AnchorClient = Pick<EventOnlyAnchor, "anchor" | "balance">;

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 500);
};

/** Keeps observation and local batching alive while root submission is unavailable. */
export class AnchorCoordinator {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private consecutiveFailures = 0;
  private retryAtMs = 0;
  private nextBalanceCheckMs = 0;

  constructor(
    private readonly anchor: AnchorClient,
    private readonly store: AppendOnlyStore,
    private readonly recorder: ForecastRecorder,
    private readonly options: AnchorCoordinatorOptions,
  ) {
    if (!Number.isFinite(options.retryBaseMs) || options.retryBaseMs <= 0) {
      throw new Error("retryBaseMs must be positive");
    }
    if (!Number.isFinite(options.retryMaxMs) || options.retryMaxMs < options.retryBaseMs) {
      throw new Error("retryMaxMs must be at least retryBaseMs");
    }
    if (!Number.isFinite(options.balanceCheckMs) || options.balanceCheckMs <= 0) {
      throw new Error("balanceCheckMs must be positive");
    }
    if (options.lowBalanceWei < 0n) throw new Error("lowBalanceWei must be non-negative");
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  private async checkBalance(nowMs: number): Promise<void> {
    if (nowMs < this.nextBalanceCheckMs) return;
    this.nextBalanceCheckMs = nowMs + this.options.balanceCheckMs;
    try {
      const balance = await this.anchor.balance();
      if (balance < this.options.lowBalanceWei) {
        this.log(`ALERT low_balance balance_wei=${balance} threshold_wei=${this.options.lowBalanceWei}`);
      }
    } catch (error) {
      this.log(`ALERT balance_check_failed error=${errorMessage(error)}`);
    }
  }

  private backoffMs(): number {
    const exponent = Math.min(this.consecutiveFailures - 1, 30);
    return Math.min(this.options.retryBaseMs * (2 ** exponent), this.options.retryMaxMs);
  }

  async tick(): Promise<number> {
    const recovered = new Set(this.store.unanchoredBatches().map((batch) => batch.batch_id));
    const prepared = await this.recorder.preparePendingBatch();
    if (prepared) {
      this.log(`prepared ${prepared.leaves.length} leaves root=${prepared.root}`);
    }

    const nowMs = this.now();
    await this.checkBalance(nowMs);
    const outstanding = this.store.unanchoredBatches();
    if (outstanding.length === 0 || nowMs < this.retryAtMs) return 0;

    let anchored = 0;
    for (const batch of outstanding) {
      try {
        const hash = await this.anchor.anchor(batch, this.store);
        const label = recovered.has(batch.batch_id) ? "recovered batch" : `${batch.leaves.length} leaves`;
        if (this.store.batchAnchorStatus(batch.batch_id) === "anchored_late") {
          const late = this.store.anchoredBatch(batch.batch_id)?.late_market_ids ?? [];
          this.log(`ALERT anchored_late ${label} root=${batch.root} tx=${hash} late_market_ids=${late.join(",")}`);
        } else {
          this.log(`anchored ${label} root=${batch.root} tx=${hash}`);
        }
        this.consecutiveFailures = 0;
        this.retryAtMs = 0;
        anchored++;
      } catch (error) {
        this.consecutiveFailures++;
        const retryInMs = this.backoffMs();
        this.retryAtMs = this.now() + retryInMs;
        this.log(
          `ALERT anchor_failed root=${batch.root} leaves=${batch.leaves.length}`
          + ` failures=${this.consecutiveFailures} retry_in_ms=${retryInMs}`
          + ` outstanding=${this.store.unanchoredBatches().length} error=${errorMessage(error)}`,
        );
        break;
      }
    }
    return anchored;
  }
}
