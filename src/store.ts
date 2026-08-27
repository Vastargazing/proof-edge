import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalHash, ZERO_HASH } from "./canonical.js";
import { evidenceDigest } from "./model.js";
import { buildResolveScoreReport, type ResolveScoreReport } from "./scoring.js";
import type {
  BatchAnchored,
  BatchPrepared,
  ForecastObserved,
  ForecastAnchorStatus,
  ForecastReveal,
  ForecastRiskDecision,
  ForecastSkipped,
  ForecastScore,
  Hex32,
  LogEnvelope,
  LogEventData,
  PublicationWatermark,
  RecorderHeartbeat,
  SpotObserved,
} from "./types.js";

const nowNs = (): string => (BigInt(Date.now()) * 1_000_000n).toString();
const HEX32 = /^0x[0-9a-f]{64}$/;
const SKIP_REASONS = new Set<ForecastSkipped["reason"]>([
  "non_binary_market",
  "invalid_market_id",
  "already_recorded",
  "unsupported_asset",
  "missing_spot",
  "momentum_unavailable",
  "invalid_market_metadata",
  "missing_market_midpoint",
  "missing_reference",
  "volatility_warmup",
  "expired_market",
  "evaluation_error",
]);

function hashEnvelopeBody(value: Omit<LogEnvelope, "event_hash">): Hex32 {
  return canonicalHash(value);
}

export interface OrphanedLogEvent {
  line: number;
  seq: number;
  event_hash: Hex32;
  prev_event_hash: Hex32;
  event_type: LogEventData["type"];
}

export interface StoreReadReport {
  total_events: number;
  accepted_events: number;
  orphan_count: number;
  orphan_events: OrphanedLogEvent[];
  head_event_hash: Hex32;
}

export interface StoreOpenOptions {
  writable?: boolean;
  warn?: (message: string) => void;
}

interface WriterLockOwner {
  pid: number;
  process_start_token: string | null;
  token: string;
}

interface WriterLock {
  path: string;
  owner: WriterLockOwner;
}

interface ParsedEnvelope {
  line: number;
  index: number;
  envelope: LogEnvelope;
}

async function processStartToken(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return null;
    // Field 22 is process start time. The suffix starts at field 3.
    return stat.slice(closingParen + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

async function lockOwnerIsAlive(owner: WriterLockOwner): Promise<boolean> {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  const currentStart = await processStartToken(owner.pid);
  return owner.process_start_token === null || currentStart === null || currentStart === owner.process_start_token;
}

async function readLockOwner(path: string): Promise<WriterLockOwner | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<WriterLockOwner>;
    if (typeof value.pid !== "number" || typeof value.token !== "string") return null;
    return {
      pid: value.pid,
      process_start_token: typeof value.process_start_token === "string" ? value.process_start_token : null,
      token: value.token,
    };
  } catch {
    return null;
  }
}

async function acquireWriterLock(file: string): Promise<WriterLock> {
  const path = `${file}.writer.lock`;
  const owner: WriterLockOwner = {
    pid: process.pid,
    process_start_token: await processStartToken(process.pid),
    token: randomUUID(),
  };
  const temporary = `${path}.${process.pid}.${owner.token}.tmp`;
  await writeFile(temporary, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
  try {
    for (;;) {
      try {
        // Publishing a fully-written hard link avoids exposing a partial owner
        // record to a competing process.
        await link(temporary, path);
        return { path, owner };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readLockOwner(path);
        if (existing !== null && await lockOwnerIsAlive(existing)) {
          throw new Error(
            `store writer lock is held for ${file} by pid ${existing.pid}; refusing a second writer`,
          );
        }
        try {
          await unlink(path);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function releaseWriterLock(lock: WriterLock): Promise<void> {
  const existing = await readLockOwner(lock.path);
  if (existing?.token !== lock.owner.token) return;
  await unlink(lock.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function chooseCanonicalChain(parsed: ParsedEnvelope[]): { canonical: ParsedEnvelope[]; orphans: ParsedEnvelope[] } {
  const byHash = new Map<Hex32, ParsedEnvelope>();
  const children = new Map<Hex32, ParsedEnvelope[]>();
  for (const item of parsed) {
    if (byHash.has(item.envelope.event_hash)) {
      throw new Error(`duplicate log event hash at line ${item.line}`);
    }
    byHash.set(item.envelope.event_hash, item);
    const siblings = children.get(item.envelope.prev_event_hash) ?? [];
    siblings.push(item);
    children.set(item.envelope.prev_event_hash, siblings);
  }

  const selectedChild = new Map<Hex32, ParsedEnvelope>();
  for (const [parent, siblings] of children) {
    if (siblings.length === 1) {
      selectedChild.set(parent, siblings[0]!);
      continue;
    }
    const continued = siblings.filter((item) => (children.get(item.envelope.event_hash)?.length ?? 0) > 0);
    if (continued.length > 1) {
      throw new Error(
        `log contains a true branch after ${parent}: both sides have descendants at lines ${continued.map((item) => item.line).join(", ")}`,
      );
    }
    // A sole continued side is canonical. If all siblings are terminal, the
    // physically last event wins and every other tip remains loudly reported.
    selectedChild.set(parent, continued[0] ?? siblings.at(-1)!);
  }

  const canonical: ParsedEnvelope[] = [];
  const acceptedHashes = new Set<Hex32>();
  let parent = ZERO_HASH;
  while (selectedChild.has(parent)) {
    const item = selectedChild.get(parent)!;
    if (acceptedHashes.has(item.envelope.event_hash)) {
      throw new Error(`log hash chain contains a cycle at line ${item.line}`);
    }
    canonical.push(item);
    acceptedHashes.add(item.envelope.event_hash);
    parent = item.envelope.event_hash;
  }
  return {
    canonical,
    orphans: parsed.filter((item) => !acceptedHashes.has(item.envelope.event_hash)),
  };
}

export class AppendOnlyStore {
  readonly file: string;
  private events: LogEnvelope[] = [];
  private forecasts = new Map<Hex32, ForecastObserved>();
  private prepared = new Map<Hex32, BatchPrepared>();
  private anchored = new Map<Hex32, BatchAnchored>();
  private commitmentToBatch = new Map<Hex32, Hex32>();
  private riskDecisions = new Map<string, ForecastRiskDecision>();
  private reveals = new Map<Hex32, ForecastReveal>();
  private scores = new Map<Hex32, ForecastScore>();
  private watermarks: PublicationWatermark[] = [];
  private skipKeys = new Set<string>();
  private heartbeats: RecorderHeartbeat[] = [];
  private spots: SpotObserved[] = [];
  private writerLock: WriterLock | null = null;
  private closed = false;
  private report: StoreReadReport = {
    total_events: 0,
    accepted_events: 0,
    orphan_count: 0,
    orphan_events: [],
    head_event_hash: ZERO_HASH,
  };

  private riskKey(marketId: Hex32, riskConfigHash: Hex32): string {
    return `${marketId}:${riskConfigHash}`;
  }

  private skipKey(value: ForecastSkipped): string {
    return `${value.market_key}:${value.reason}`;
  }

  private lateMarketIds(batch: BatchPrepared, anchor: BatchAnchored): Hex32[] {
    const anchorNs = BigInt(anchor.block_timestamp) * 1_000_000_000n;
    return batch.leaves.flatMap((leaf) => {
      const forecast = this.forecasts.get(leaf.market_id);
      if (!forecast) throw new Error(`batch references missing forecast ${leaf.market_id}`);
      return anchorNs >= BigInt(forecast.preimage.expiry_ns) ? [leaf.market_id] : [];
    });
  }

  private constructor(file: string) {
    this.file = file;
  }

  static async open(file: string, options: StoreOpenOptions = {}): Promise<AppendOnlyStore> {
    const store = new AppendOnlyStore(file);
    if (options.writable) {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      store.writerLock = await acquireWriterLock(file);
    }
    let raw = "";
    try {
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (raw.length > 0 && !raw.endsWith("\n")) {
        throw new Error("append-only log ends with a partial line; refusing recovery");
      }
      const lines = raw.split("\n").filter(Boolean);
      const parsed = lines.map((line, index): ParsedEnvelope => {
        const event = JSON.parse(line) as LogEnvelope;
        const body: Omit<LogEnvelope, "event_hash"> = {
          seq: event.seq,
          written_at_ns: event.written_at_ns,
          prev_event_hash: event.prev_event_hash,
          event: event.event,
        };
        if (hashEnvelopeBody(body) !== event.event_hash) {
          throw new Error(`log event hash mismatch at line ${index + 1}`);
        }
        return { line: index + 1, index, envelope: event };
      });
      const { canonical, orphans } = chooseCanonicalChain(parsed);
      for (const item of canonical) {
        store.validate(item.envelope.event);
        store.index(item.envelope.event);
        store.events.push(item.envelope);
      }
      const orphanEvents = orphans.map((item): OrphanedLogEvent => ({
        line: item.line,
        seq: item.envelope.seq,
        event_hash: item.envelope.event_hash,
        prev_event_hash: item.envelope.prev_event_hash,
        event_type: item.envelope.event.type,
      }));
      store.report = {
        total_events: parsed.length,
        accepted_events: canonical.length,
        orphan_count: orphanEvents.length,
        orphan_events: orphanEvents,
        head_event_hash: store.headHash(),
      };
      if (orphanEvents.length > 0) {
        const warn = options.warn ?? console.error;
        warn(`LEDGER_ALERT orphan_count=${orphanEvents.length} accepted_events=${canonical.length} total_events=${parsed.length}`);
        for (const orphan of orphanEvents) {
          warn(
            `LEDGER_ALERT orphan line=${orphan.line} seq=${orphan.seq} type=${orphan.event_type}`
            + ` event_hash=${orphan.event_hash} prev_event_hash=${orphan.prev_event_hash}`,
          );
        }
      }
      return store;
    } catch (error) {
      if (store.writerLock !== null) await releaseWriterLock(store.writerLock);
      store.writerLock = null;
      throw error;
    }
  }

  readReport(): StoreReadReport {
    return {
      ...this.report,
      orphan_events: this.report.orphan_events.map((event) => ({ ...event })),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.writerLock !== null) await releaseWriterLock(this.writerLock);
    this.writerLock = null;
  }

  private assertWritable(): void {
    if (this.closed) throw new Error(`store is closed: ${this.file}`);
    if (this.writerLock === null) throw new Error(`store was opened read-only: ${this.file}`);
  }

  private validate(event: LogEventData): void {
    if (event.type === "forecast_observed") {
      if (event.value.evidence !== undefined && evidenceDigest(event.value.evidence) !== event.value.preimage.evidence_digest) {
        throw new Error(`evidence digest mismatch for market ${event.value.market_id}`);
      }
      const existing = this.forecasts.get(event.value.market_id);
      if (existing && existing.commitment !== event.value.commitment) {
        throw new Error(`conflicting forecast for market ${event.value.market_id}`);
      }
    } else if (event.type === "batch_prepared") {
      if (event.value.ledger_head !== undefined && event.value.ledger_head !== this.headHash()) {
        throw new Error(
          `ledger head mismatch before batch ${event.value.batch_id}:`
          + ` recorded ${event.value.ledger_head}, actual ${this.headHash()}`,
        );
      }
      for (const leaf of event.value.leaves) {
        const forecast = [...this.forecasts.values()].find((item) => item.commitment === leaf.commitment);
        if (!forecast) throw new Error(`batch references unknown commitment ${leaf.commitment}`);
        const merkleVersion = event.value.merkle_version ?? 1;
        if ((leaf.merkle_version ?? 1) !== merkleVersion || forecast.preimage.v !== merkleVersion) {
          throw new Error(`batch Merkle version does not match forecast ${leaf.market_id}`);
        }
        const existing = this.commitmentToBatch.get(leaf.commitment);
        if (existing && existing !== event.value.batch_id) {
          throw new Error(`commitment ${leaf.commitment} appears in two batches`);
        }
      }
    } else if (event.type === "batch_anchored") {
      const prepared = this.prepared.get(event.value.batch_id);
      if (!prepared || prepared.root !== event.value.root) {
        throw new Error(`anchor has no matching prepared batch ${event.value.batch_id}`);
      }
      if (prepared.ledger_head !== undefined && event.value.ledger_head !== prepared.ledger_head) {
        throw new Error(
          `anchored ledger head mismatch for batch ${event.value.batch_id}:`
          + ` prepared ${prepared.ledger_head}, anchored ${event.value.ledger_head ?? "missing"}`,
        );
      }
      const lateMarketIds = this.lateMarketIds(prepared, event.value);
      const expectedStatus = lateMarketIds.length > 0 ? "anchored_late" : "on_time";
      if (event.value.status !== undefined && event.value.status !== expectedStatus) {
        throw new Error(`anchor timing status mismatch for batch ${event.value.batch_id}`);
      }
      if (event.value.status !== undefined || event.value.late_market_ids !== undefined) {
        if (event.value.status === undefined || event.value.late_market_ids === undefined) {
          throw new Error(`anchor timing metadata is incomplete for batch ${event.value.batch_id}`);
        }
        if (event.value.late_market_ids.length !== lateMarketIds.length
          || event.value.late_market_ids.some((marketId, index) => marketId !== lateMarketIds[index])) {
          throw new Error(`late market list mismatch for batch ${event.value.batch_id}`);
        }
      }
    } else if (event.type === "publication_watermark") {
      if (!/^(0|[1-9][0-9]*)$/.test(event.value.block_number)) {
        throw new Error("publication watermark block_number must be a canonical decimal string");
      }
      if (!/^(0|[1-9][0-9]*)$/.test(event.value.captured_at_ns)) {
        throw new Error("publication watermark captured_at_ns must be a canonical decimal string");
      }
      if (event.value.source_ledger_head !== this.headHash()) {
        throw new Error(
          `publication watermark source head mismatch: recorded ${event.value.source_ledger_head}, actual ${this.headHash()}`,
        );
      }
      for (const [name, count] of Object.entries({
        onchain_anchors: event.value.onchain_anchors,
        disclosed_roots: event.value.disclosed_roots,
        undisclosed_roots: event.value.undisclosed_roots,
        pending_roots: event.value.pending_roots,
      })) {
        if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${name} must be a non-negative safe integer`);
      }
      if (!Array.isArray(event.value.failures) || event.value.failures.some((item) => typeof item !== "string")) {
        throw new Error("publication watermark failures must be strings");
      }
    } else if (event.type === "forecast_skipped") {
      if (!event.value.market_key.trim()) throw new Error("forecast skip market_key is required");
      if (event.value.market_id !== undefined && !HEX32.test(event.value.market_id)) {
        throw new Error("forecast skip market_id must be lowercase bytes32");
      }
      if (!SKIP_REASONS.has(event.value.reason)) throw new Error("unsupported forecast skip reason");
      if (!/^(0|[1-9][0-9]*)$/.test(event.value.attempted_at_ns)) {
        throw new Error("forecast skip attempted_at_ns must be a canonical decimal string");
      }
    } else if (event.type === "recorder_heartbeat") {
      if (!/^(0|[1-9][0-9]*)$/.test(event.value.at_ns)) {
        throw new Error("heartbeat at_ns must be a canonical decimal string");
      }
      if (event.value.status !== "running") throw new Error("unsupported recorder heartbeat status");
      if (!HEX32.test(event.value.model_hash)) throw new Error("heartbeat model_hash must be lowercase bytes32");
    } else if (event.type === "spot_observed") {
      if (event.value.asset !== "BTC" && event.value.asset !== "ETH") throw new Error("unsupported spot asset");
      if (!Number.isFinite(event.value.price) || event.value.price <= 0) throw new Error("spot price must be positive");
      if (!Number.isSafeInteger(event.value.oracle_observed_at_ms) || event.value.oracle_observed_at_ms <= 0) {
        throw new Error("spot oracle timestamp must be a positive safe integer");
      }
      if (!/^(0|[1-9][0-9]*)$/.test(event.value.recorded_at_ns)) {
        throw new Error("spot recorded_at_ns must be a canonical decimal string");
      }
    } else if (event.type === "forecast_risk_decision") {
      const existing = this.riskDecisions.get(this.riskKey(event.value.market_id, event.value.risk_config_hash));
      if (existing && canonicalHash(existing) !== canonicalHash(event.value)) {
        throw new Error(`conflicting risk decision for market ${event.value.market_id}`);
      }
    } else if (event.type === "forecast_revealed") {
      const existing = this.reveals.get(event.value.market_id);
      if (existing && canonicalHash(existing) !== canonicalHash(event.value)) {
        throw new Error(`conflicting reveal for market ${event.value.market_id}`);
      }
    } else if (event.type === "forecast_scored") {
      if (this.forecastAnchorStatus(event.value.market_id) !== "on_time") {
        throw new Error(`cannot score forecast without an on-time anchor ${event.value.market_id}`);
      }
      const reveal = this.reveals.get(event.value.market_id);
      if (!reveal || reveal.outcome === "VOID" || reveal.outcome !== event.value.outcome) {
        throw new Error(`score has no matching resolved reveal ${event.value.market_id}`);
      }
      const forecast = this.forecasts.get(event.value.market_id)!;
      const observed = event.value.outcome === "YES" ? 1 : 0;
      const brier = (probability: number) => Math.round((probability - observed) ** 2 * 100_000_000);
      if (event.value.brier_agent_e8 !== brier(forecast.preimage.p_agent)
        || event.value.brier_market_e8 !== brier(forecast.preimage.p_market)) {
        throw new Error(`score does not match sealed probabilities ${event.value.market_id}`);
      }
      const existing = this.scores.get(event.value.market_id);
      if (existing && canonicalHash(existing) !== canonicalHash(event.value)) {
        throw new Error(`conflicting score for market ${event.value.market_id}`);
      }
    }
  }

  private index(event: LogEventData): void {
    if (event.type === "forecast_observed") {
      this.forecasts.set(event.value.market_id, event.value);
    } else if (event.type === "batch_prepared") {
      this.prepared.set(event.value.batch_id, event.value);
      for (const leaf of event.value.leaves) {
        this.commitmentToBatch.set(leaf.commitment, event.value.batch_id);
      }
    } else if (event.type === "batch_anchored") {
      this.anchored.set(event.value.batch_id, event.value);
    } else if (event.type === "publication_watermark") {
      this.watermarks.push(event.value);
    } else if (event.type === "forecast_skipped") {
      this.skipKeys.add(this.skipKey(event.value));
    } else if (event.type === "recorder_heartbeat") {
      this.heartbeats.push(event.value);
    } else if (event.type === "spot_observed") {
      this.spots.push(event.value);
    } else if (event.type === "forecast_risk_decision") {
      this.riskDecisions.set(this.riskKey(event.value.market_id, event.value.risk_config_hash), event.value);
    } else if (event.type === "forecast_revealed") {
      this.reveals.set(event.value.market_id, event.value);
    } else if (event.type === "forecast_scored") {
      this.scores.set(event.value.market_id, event.value);
    }
  }

  private async append(event: LogEventData): Promise<LogEnvelope> {
    this.assertWritable();
    this.validate(event);
    const previous = this.events[this.events.length - 1]?.event_hash ?? ZERO_HASH;
    const body: Omit<LogEnvelope, "event_hash"> = {
      seq: this.events.length,
      written_at_ns: nowNs(),
      prev_event_hash: previous,
      event,
    };
    const envelope: LogEnvelope = { ...body, event_hash: hashEnvelopeBody(body) };
    const handle = await open(this.file, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(envelope)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.index(event);
    this.events.push(envelope);
    return envelope;
  }

  forecast(marketId: Hex32): ForecastObserved | undefined {
    return this.forecasts.get(marketId);
  }

  headHash(): Hex32 {
    return this.events[this.events.length - 1]?.event_hash ?? ZERO_HASH;
  }

  allForecasts(): ForecastObserved[] {
    return [...this.forecasts.values()];
  }

  pendingForecasts(): ForecastObserved[] {
    return [...this.forecasts.values()].filter((item) => !this.commitmentToBatch.has(item.commitment));
  }

  unanchoredBatches(): BatchPrepared[] {
    return [...this.prepared.values()].filter((batch) => !this.anchored.has(batch.batch_id));
  }

  preparedBatches(): BatchPrepared[] {
    return [...this.prepared.values()];
  }

  anchoredBatches(): BatchAnchored[] {
    return [...this.anchored.values()];
  }

  anchoredBatch(batchId: Hex32): BatchAnchored | undefined {
    return this.anchored.get(batchId);
  }

  publicationWatermark(): PublicationWatermark | undefined {
    return this.watermarks.at(-1);
  }

  latestHeartbeat(): RecorderHeartbeat | undefined {
    return this.heartbeats.at(-1);
  }

  skipCount(): number {
    return this.skipKeys.size;
  }

  spotObservations(sinceMs = 0): SpotObserved[] {
    return this.spots.filter((spot) => spot.oracle_observed_at_ms >= sinceMs);
  }

  forecastAnchorStatus(marketId: Hex32): ForecastAnchorStatus {
    const forecast = this.forecasts.get(marketId);
    if (!forecast) throw new Error(`unknown forecast ${marketId}`);
    const batchId = this.commitmentToBatch.get(forecast.commitment);
    if (!batchId) return "unanchored";
    const anchor = this.anchored.get(batchId);
    if (!anchor) return "unanchored";
    return BigInt(anchor.block_timestamp) * 1_000_000_000n < BigInt(forecast.preimage.expiry_ns)
      ? "on_time"
      : "anchored_late";
  }

  batchAnchorStatus(batchId: Hex32): ForecastAnchorStatus {
    const batch = this.prepared.get(batchId);
    if (!batch) throw new Error(`unknown batch ${batchId}`);
    const anchor = this.anchored.get(batchId);
    if (!anchor) return "unanchored";
    return this.lateMarketIds(batch, anchor).length > 0 ? "anchored_late" : "on_time";
  }

  hasRiskDecision(marketId: Hex32, riskConfigHash?: Hex32): boolean {
    if (riskConfigHash) return this.riskDecisions.has(this.riskKey(marketId, riskConfigHash));
    return [...this.riskDecisions.values()].some((item) => item.market_id === marketId);
  }

  riskDecision(marketId: Hex32, riskConfigHash: Hex32): ForecastRiskDecision | undefined {
    return this.riskDecisions.get(this.riskKey(marketId, riskConfigHash));
  }

  isRevealed(marketId: Hex32): boolean {
    return this.reveals.has(marketId);
  }

  revealedOutcome(marketId: Hex32): ForecastReveal["outcome"] | undefined {
    return this.reveals.get(marketId)?.outcome;
  }

  isScored(marketId: Hex32): boolean {
    return this.scores.has(marketId);
  }

  riskDecisionCount(): number {
    return this.riskDecisions.size;
  }

  riskDecisionsFor(marketId: Hex32): ForecastRiskDecision[] {
    return [...this.riskDecisions.values()]
      .filter((item) => item.market_id === marketId)
      .sort((a, b) => BigInt(a.decided_at_ns) < BigInt(b.decided_at_ns) ? -1 : 1);
  }

  revealCount(): number {
    return this.reveals.size;
  }

  scoreCount(): number {
    return this.scores.size;
  }

  allScores(): ForecastScore[] {
    return [...this.scores.values()];
  }

  resolveScoreReport(): ResolveScoreReport {
    return buildResolveScoreReport([...this.forecasts.values()].map((forecast) => {
      const firstRiskDecision = this.riskDecisionsFor(forecast.market_id).at(0);
      return {
        market_id: forecast.market_id,
        model_hash: forecast.preimage.model_hash,
        p_agent: forecast.preimage.p_agent,
        p_market: forecast.preimage.p_market,
        anchor_status: this.forecastAnchorStatus(forecast.market_id),
        outcome: this.reveals.get(forecast.market_id)?.outcome,
        score: this.scores.get(forecast.market_id),
        risk_allowed: firstRiskDecision?.allowed,
      };
    }));
  }

  async addForecast(value: ForecastObserved): Promise<{ created: boolean; value: ForecastObserved }> {
    const existing = this.forecasts.get(value.market_id);
    if (existing) {
      if (existing.commitment !== value.commitment) {
        throw new Error(`market ${value.market_id} was already evaluated with another commitment`);
      }
      return { created: false, value: existing };
    }
    await this.append({ type: "forecast_observed", value });
    return { created: true, value };
  }

  async addPreparedBatch(value: BatchPrepared): Promise<void> {
    if (value.batch_id !== value.root) throw new Error("batch_id must equal the Merkle root");
    if (this.prepared.has(value.batch_id)) return;
    await this.append({ type: "batch_prepared", value });
  }

  async addAnchoredBatch(value: BatchAnchored): Promise<void> {
    const existing = this.anchored.get(value.batch_id);
    if (existing) {
      if (existing.transaction_hash !== value.transaction_hash) throw new Error("conflicting anchor transaction");
      return;
    }
    await this.append({ type: "batch_anchored", value });
  }

  async addPublicationWatermark(value: PublicationWatermark): Promise<void> {
    if (this.watermarks.length > 0) throw new Error("published ledger already contains a watermark");
    await this.append({ type: "publication_watermark", value });
  }

  async addForecastSkip(value: ForecastSkipped): Promise<boolean> {
    if (this.skipKeys.has(this.skipKey(value))) return false;
    await this.append({ type: "forecast_skipped", value });
    return true;
  }

  async addHeartbeat(value: RecorderHeartbeat): Promise<void> {
    await this.append({ type: "recorder_heartbeat", value });
  }

  async addSpotObservation(value: SpotObserved): Promise<boolean> {
    const duplicate = this.spots.some((spot) =>
      spot.asset === value.asset && spot.oracle_observed_at_ms === value.oracle_observed_at_ms);
    if (duplicate) return false;
    await this.append({ type: "spot_observed", value });
    return true;
  }

  async addRiskDecision(value: ForecastRiskDecision): Promise<void> {
    const existing = this.riskDecisions.get(this.riskKey(value.market_id, value.risk_config_hash));
    if (existing) {
      if (canonicalHash(existing) !== canonicalHash(value)) throw new Error("conflicting risk decision");
      return;
    }
    await this.append({ type: "forecast_risk_decision", value });
  }

  async addReveal(value: ForecastReveal): Promise<void> {
    const existing = this.reveals.get(value.market_id);
    if (existing) {
      if (existing.outcome !== value.outcome) throw new Error("conflicting reveal outcome");
      return;
    }
    await this.append({ type: "forecast_revealed", value });
  }

  async addScore(value: ForecastScore): Promise<void> {
    const existing = this.scores.get(value.market_id);
    if (existing) {
      if (canonicalHash(existing) !== canonicalHash(value)) throw new Error("conflicting score");
      return;
    }
    await this.append({ type: "forecast_scored", value });
  }

  async addEvent(event: LogEventData): Promise<void> {
    await this.append(event);
  }
}
