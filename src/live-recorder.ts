import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  activeMarkets,
  createExchange,
  outcomeSymbols,
  shutdown,
  type UnifiedMarket,
} from "@dreamdex-bot-kit/ec-core";
import { isBinaryMarket } from "@somnia-chain/markets-sdk";
import { parseEther } from "viem";
import {
  SpotHistory,
  estimateUp,
  marketImpliedUp,
  referenceReader,
  sdkSpotReader,
  type Asset,
} from "../vendor/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.js";
import { evidenceDigest, modelHash } from "./model.js";
import { probabilityOnGrid } from "./canonical.js";
import { AnchorCoordinator } from "./anchor-coordinator.js";
import { EventOnlyAnchor } from "./emitter.js";
import { ForecastRecorder } from "./recorder.js";
import { AppendOnlyStore } from "./store.js";
import { buildSourceInventory } from "./source-inventory.js";
import type {
  ForecastObserved,
  ForecastRiskDecision,
  ForecastSkipReason,
  Hex32,
  ModelManifestV1,
} from "./types.js";

const VENUE_ID = (process.env.VENUE_ID ?? "").toLowerCase() as Hex32;
const EMITTER_ADDRESS = process.env.EMITTER_ADDRESS as `0x${string}` | undefined;
const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex32 | undefined;
const STORE_PATH = process.env.RECORDER_STORE ?? resolve("data/forecast-events.jsonl");
const POLL_MS = Number(process.env.RECORDER_POLL_MS ?? 5_000);
const WINDOW_MS = Number(process.env.OF_MOMENTUM_WINDOW_MS ?? 60_000);
const MAX_SPOT_AGE_MS = Number(process.env.OF_MAX_SPOT_AGE_MS ?? 15_000);
const VOL_WINDOW_MS = Number(process.env.OF_VOL_WINDOW_MS ?? 600_000);
const EXPECTED_MOVE = Number(process.env.OF_EXPECTED_MOVE ?? 0.0015);
const MIN_VOL = Number(process.env.OF_MIN_VOL ?? 0.0002);
const SENSITIVITY = Number(process.env.OF_SENSITIVITY ?? 20);
const REQUIRE_MEASURED_VOL = process.env.OF_REQUIRE_MEASURED_VOL !== "false";
const EDGE = Number(process.env.OF_EDGE ?? 0.03);
const MAX_DISAGREEMENT = Number(process.env.OF_MAX_DISAGREEMENT ?? 0.1);
const ANCHOR_RETRY_BASE_MS = Number(process.env.ANCHOR_RETRY_BASE_MS ?? 5_000);
const ANCHOR_RETRY_MAX_MS = Number(process.env.ANCHOR_RETRY_MAX_MS ?? 300_000);
const BALANCE_CHECK_MS = Number(process.env.RECORDER_BALANCE_CHECK_MS ?? 3_600_000);
const HEARTBEAT_MS = Number(process.env.RECORDER_HEARTBEAT_MS ?? 60_000);
const LOW_BALANCE_WEI = parseEther(process.env.RECORDER_LOW_BALANCE_STT ?? "0.128881152");
const RUN_ONCE = process.env.RECORDER_RUN_ONCE === "true";
const RECONCILE_ONLY = process.argv.includes("--reconcile");
const UPSTREAM_DIR = resolve("vendor/dreamdex-bot-kit");

if (!RECONCILE_ONLY && !/^0x[0-9a-f]{64}$/.test(VENUE_ID)) throw new Error("VENUE_ID must be explicit lowercase bytes32");
if (!RECONCILE_ONLY && !EMITTER_ADDRESS) throw new Error("EMITTER_ADDRESS is required");
if (!RECONCILE_ONLY && !PRIVATE_KEY) throw new Error("PRIVATE_KEY is required for root anchoring");
for (const [name, value] of Object.entries({
  POLL_MS,
  WINDOW_MS,
  MAX_SPOT_AGE_MS,
  VOL_WINDOW_MS,
  ANCHOR_RETRY_BASE_MS,
  ANCHOR_RETRY_MAX_MS,
  BALANCE_CHECK_MS,
  HEARTBEAT_MS,
})) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const nowNs = (): string => (BigInt(Date.now()) * 1_000_000n).toString();
const isAsset = (value: string): value is Asset => value === "BTC" || value === "ETH";

const SOURCE_SCOPES = [
  "src",
  "vendor/dreamdex-bot-kit/packages/ec-core",
  "vendor/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.ts",
  "package.json",
  "package-lock.json",
] as const;

function actualUpstreamCommit(): string {
  const commit = execFileSync("git", ["-C", UPSTREAM_DIR, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("cannot resolve pinned dreamdex-bot-kit commit");
  return commit;
}

async function exactSdkVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(resolve("node_modules/@somnia-chain/markets-sdk/package.json"), "utf8")) as { version?: string };
  if (!pkg.version || !/^\d+\.\d+\.\d+/.test(pkg.version)) throw new Error("cannot resolve markets-sdk version");
  return pkg.version;
}

const ctx = createExchange({ withSigner: false });
const estimatorConfig = {
  model: "strike",
  momentum_window_ms: WINDOW_MS,
  max_spot_age_ms: MAX_SPOT_AGE_MS,
  vol_window_ms: VOL_WINDOW_MS,
  expected_move_fallback: EXPECTED_MOVE,
  min_vol: MIN_VOL,
  sensitivity: SENSITIVITY,
  require_measured_volatility: REQUIRE_MEASURED_VOL,
  edge: EDGE,
  max_disagreement: MAX_DISAGREEMENT,
  probability_grid: 10_000,
  market_baseline: "best-yes-bid-ask-midpoint",
  recorder_poll_ms: POLL_MS,
  data_sources: {
    rpc_url: ctx.config.rpcUrl,
    ws_rpc_url: ctx.config.wsRpcUrl,
    indexer_url: ctx.config.indexerUrl,
    price_feed: ctx.config.priceFeed ?? null,
    contract_addresses: ctx.config.addresses,
    venue_id: VENUE_ID,
  },
};

function marketId(market: UnifiedMarket): Hex32 | null {
  if (!isBinaryMarket(market.info)) return null;
  const id = String(market.info.marketId ?? "").toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(id) ? (id as Hex32) : null;
}

const store = await AppendOnlyStore.open(STORE_PATH, { writable: true });
const recorder = new ForecastRecorder(store);
const anchor = RECONCILE_ONLY ? null : new EventOnlyAnchor(EMITTER_ADDRESS!, PRIVATE_KEY!);
const spotReader = sdkSpotReader(ctx);
const refs = referenceReader(ctx);
const history = new SpotHistory(WINDOW_MS, MAX_SPOT_AGE_MS, VOL_WINDOW_MS);
const restoredSpots = store.spotObservations(Date.now() - Math.max(VOL_WINDOW_MS, WINDOW_MS * 2));
for (const spot of restoredSpots) {
  history.record(spot.asset, { price: spot.price, at: spot.oracle_observed_at_ms });
}
const source = await buildSourceInventory(SOURCE_SCOPES);
const manifest: ModelManifestV1 = {
  v: 1,
  estimator: "dreamdex-ec-oracle-follow-strike-adapter",
  code_commit: source.aggregate,
  package_versions: {
    "dreamdex-bot-kit": actualUpstreamCommit(),
    "@somnia-chain/markets-sdk": await exactSdkVersion(),
  },
  runtime_versions: {
    node: process.version,
    v8: process.versions.v8,
    modules: process.versions.modules,
    openssl: process.versions.openssl,
    uv: process.versions.uv,
  },
  config: estimatorConfig,
  source_files: source.files,
  source_tree_dirty: source.dirty,
};
const frozenModelHash = modelHash(manifest);
const riskConfigHash = evidenceDigest({
  v: 1,
  edge: EDGE,
  max_disagreement: MAX_DISAGREEMENT,
  execution: "disabled-recorder-only",
});
const anchorCoordinator = anchor ? new AnchorCoordinator(anchor, store, recorder, {
  retryBaseMs: ANCHOR_RETRY_BASE_MS,
  retryMaxMs: ANCHOR_RETRY_MAX_MS,
  balanceCheckMs: BALANCE_CHECK_MS,
  lowBalanceWei: LOW_BALANCE_WEI,
  log,
}) : null;
let stopped = false;
let lastHeartbeatMs = 0;
process.on("SIGINT", () => (stopped = true));
process.on("SIGTERM", () => (stopped = true));

async function recordSkip(
  market: UnifiedMarket,
  reason: ForecastSkipReason,
  id?: Hex32,
): Promise<false> {
  const marketKey = id ?? String((market.info as { marketId?: unknown }).marketId ?? market.symbol ?? "unknown");
  const created = await store.addForecastSkip({
    attempted_at_ns: nowNs(),
    market_key: marketKey,
    ...(id === undefined ? {} : { market_id: id }),
    reason,
  });
  if (created) log(`window skipped market=${marketKey} reason=${reason}`);
  return false;
}

async function heartbeat(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastHeartbeatMs < HEARTBEAT_MS) return;
  await store.addHeartbeat({ at_ns: (BigInt(now) * 1_000_000n).toString(), model_hash: frozenModelHash, status: "running" });
  lastHeartbeatMs = now;
  log(`heartbeat model_hash=${frozenModelHash}`);
}

async function evaluate(market: UnifiedMarket, spots: Map<Asset, { price: number; at: number }>): Promise<boolean> {
  if (!isBinaryMarket(market.info)) return recordSkip(market, "non_binary_market");
  const id = marketId(market);
  if (!id) return recordSkip(market, "invalid_market_id");
  if (store.forecast(id)) return recordSkip(market, "already_recorded", id);
  const asset = String(market.info.asset ?? "");
  if (!isAsset(asset)) return recordSkip(market, "unsupported_asset", id);
  const observed = spots.get(asset);
  if (!observed) return recordSkip(market, "missing_spot", id);
  const momentum = history.momentum(asset, Date.now());
  if (!momentum) return recordSkip(market, "momentum_unavailable", id);
  const intervalSec = Number(market.info.intervalSec);
  // Market identity and expiry are authoritative only on-chain. The indexed
  // row remains a discovery surface, never the timestamp sealed in the preimage.
  const onchain = await ctx.exchange.client.getMarketOnchain(id);
  const expirySec = onchain.expiry;
  if (!Number.isSafeInteger(intervalSec) || intervalSec <= 0 || expirySec <= 0n) {
    return recordSkip(market, "invalid_market_metadata", id);
  }

  const { yes } = outcomeSymbols(market);
  const book = await ctx.exchange.fetchOrderBook(yes, 3);
  const pMarketRaw = marketImpliedUp(book);
  if (pMarketRaw === null) return recordSkip(market, "missing_market_midpoint", id);
  const reference = await refs.referenceFor({ marketId: id, strike: market.info.strike }, momentum.spot);
  if (!reference) return recordSkip(market, "missing_reference", id);
  const measuredVol = history.volatility(asset);
  if (REQUIRE_MEASURED_VOL && measuredVol === null) return recordSkip(market, "volatility_warmup", id);
  const expectedMove = Math.max(measuredVol ?? EXPECTED_MOVE, MIN_VOL);
  const timeToExpiryMs = Number(expirySec * 1_000n - BigInt(Date.now()));
  if (timeToExpiryMs <= 0) return recordSkip(market, "expired_market", id);
  const estimate = estimateUp({
    spot: momentum.spot,
    r: momentum.r,
    strike: reference.price,
    timeToExpiryMs,
    windowMs: WINDOW_MS,
    expectedMove,
    sensitivity: SENSITIVITY,
    model: "strike",
    anchorUp: pMarketRaw,
  });
  const pAgent = probabilityOnGrid(estimate.pUp);
  const pMarket = probabilityOnGrid(pMarketRaw);
  const observationMs = Date.now();
  const observedAtNs = (BigInt(observationMs) * 1_000_000n).toString();
  const evidence = {
    v: 1,
    observed_at_ms: observationMs,
    oracle_observed_at_ms: observed.at,
    market_id: id,
    venue_id: VENUE_ID,
    interval_sec: intervalSec,
    expiry_sec: expirySec.toString(),
    spot: momentum.spot,
    momentum_return: momentum.r,
    reference: { kind: reference.kind, price: reference.price },
    volatility: { measured: measuredVol, used: expectedMove },
    yes_book: { bids: book.bids.slice(0, 3), asks: book.asks.slice(0, 3) },
    p_market_raw: pMarketRaw,
    model_manifest: manifest,
  };

  const result = await recorder.record({
    v: 2,
    observed_at_ns: observedAtNs,
    market_id: id,
    venue_id: VENUE_ID,
    symbol: asset,
    interval_sec: intervalSec,
    expiry_ns: (expirySec * 1_000_000_000n).toString(),
    p_agent: pAgent,
    side: pAgent >= pMarket ? "YES" : "NO",
    p_market: pMarket,
    model_hash: frozenModelHash,
    evidence_digest: evidenceDigest(evidence),
  }, evidence);
  if (result.created) {
    const decision = await ensureRiskDecision(store.forecast(id)!);
    log(`recorded ${asset} ${intervalSec}s ${id} p_agent=${pAgent.toFixed(4)} p_market=${pMarket.toFixed(4)} risk=${decision.reason}`);
  }
  return result.created;
}

async function ensureRiskDecision(forecast: ForecastObserved): Promise<ForecastRiskDecision> {
  const existing = store.riskDecision(forecast.market_id, riskConfigHash);
  if (existing) return existing;
  const absoluteEdge = Math.abs(forecast.preimage.p_agent - forecast.preimage.p_market);
  const allowed = absoluteEdge >= EDGE && (MAX_DISAGREEMENT <= 0 || absoluteEdge <= MAX_DISAGREEMENT);
  const reason: ForecastRiskDecision["reason"] = absoluteEdge < EDGE
    ? "below-edge"
    : MAX_DISAGREEMENT > 0 && absoluteEdge > MAX_DISAGREEMENT
      ? "model-disagreement"
      : "edge-band";
  const decision: ForecastRiskDecision = {
    market_id: forecast.market_id,
    decided_at_ns: (BigInt(Date.now()) * 1_000_000n).toString(),
    allowed,
    reason,
    absolute_edge_e4: Math.round(absoluteEdge * 10_000),
    risk_config_hash: riskConfigHash,
  };
  await store.addRiskDecision(decision);
  return decision;
}

async function revealAndScore(): Promise<number> {
  let completed = 0;
  for (const forecast of store.allForecasts()) {
    let outcome = store.revealedOutcome(forecast.market_id);
    const wasRevealed = outcome !== undefined;
    if (!outcome) {
      if (BigInt(forecast.preimage.expiry_ns) > BigInt(Date.now()) * 1_000_000n) continue;
      const onchain = await ctx.exchange.client.getMarketOnchain(forecast.market_id).catch(() => null);
      if (!onchain || (!onchain.isResolved && !onchain.isVoided)) continue;
      outcome = onchain.isVoided ? "VOID" : onchain.winningOutcome === 0 ? "YES" : "NO";
    }
    const eventNs = (BigInt(Date.now()) * 1_000_000n).toString();
    await store.addReveal({ market_id: forecast.market_id, revealed_at_ns: eventNs, outcome });
    let scored = false;
    if (outcome !== "VOID"
      && store.forecastAnchorStatus(forecast.market_id) === "on_time"
      && !store.isScored(forecast.market_id)) {
      const observed = outcome === "YES" ? 1 : 0;
      const brier = (p: number) => Math.round((p - observed) ** 2 * 100_000_000);
      await store.addScore({
        market_id: forecast.market_id,
        scored_at_ns: eventNs,
        outcome,
        brier_agent_e8: brier(forecast.preimage.p_agent),
        brier_market_e8: brier(forecast.preimage.p_market),
      });
      scored = true;
    }
    if (!wasRevealed || scored) {
      log(`resolved ${forecast.market_id} outcome=${outcome}${scored ? " scored=true" : ""}`);
      const report = store.resolveScoreReport();
      log(`score summary all_n=${report.all_evaluated_windows.n} risk_passed_n=${report.risk_gate_passed.n}`);
      completed++;
    }
  }
  return completed;
}

log(`recorder starting model_hash=${frozenModelHash} store=${STORE_PATH} restored_spots=${restoredSpots.length}`);
try {
  if (RECONCILE_ONLY) {
    for (const forecast of store.allForecasts()) await ensureRiskDecision(forecast);
    const completed = await revealAndScore();
    log(`reconcile complete resolved_or_scored=${completed}`);
  } else {
    await heartbeat(true);
    while (!stopped) {
      for (const forecast of store.allForecasts()) await ensureRiskDecision(forecast);
      await revealAndScore();
      const spots = new Map<Asset, { price: number; at: number }>();
      for (const asset of ["BTC", "ETH"] as const) {
        const spot = await spotReader.getSpot(asset);
        if (spot) {
          await store.addSpotObservation({
            asset,
            price: spot.price,
            oracle_observed_at_ms: spot.at,
            recorded_at_ns: nowNs(),
          });
          history.record(asset, spot);
          spots.set(asset, spot);
        }
      }
      const markets = await activeMarkets(ctx, { max: 50 });
      let recorded = 0;
      for (const market of markets) {
        try {
          if (await evaluate(market, spots)) recorded++;
        } catch (error) {
          log(`market ${market.symbol} skipped: ${(error as Error).message}`);
          await recordSkip(market, "evaluation_error", marketId(market) ?? undefined);
        }
      }
      await heartbeat();
      const anchored = await anchorCoordinator!.tick();
      if (RUN_ONCE && recorded > 0 && anchored > 0) break;
      await sleep(POLL_MS);
    }
  }
} finally {
  await store.close();
  await shutdown(ctx);
}
log("recorder stopped");
process.exit(0);
