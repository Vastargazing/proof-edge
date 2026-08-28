import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";
import { modelHash } from "../src/model.js";
import { buildSourceInventory } from "../src/source-inventory.js";
import type { Hex32, ModelManifestV1 } from "../src/types.js";

const EXPECTED_MODEL_HASH = process.env.EXPECTED_MODEL_HASH as Hex32 | undefined;
const PRINT_ONLY = process.argv.includes("--print");
const VENUE_ID = (process.env.VENUE_ID ?? "").toLowerCase() as Hex32;
const UPSTREAM_DIR = resolve("vendor/dreamdex-bot-kit");
const SOURCE_SCOPES = [
  "src",
  "vendor/dreamdex-bot-kit/packages/ec-core",
  "vendor/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.ts",
  "package.json",
  "package-lock.json",
] as const;

if (EXPECTED_MODEL_HASH !== undefined && !/^0x[0-9a-f]{64}$/.test(EXPECTED_MODEL_HASH)) {
  throw new Error("EXPECTED_MODEL_HASH must be an explicit lowercase bytes32");
}
if (!PRINT_ONLY && EXPECTED_MODEL_HASH === undefined) {
  throw new Error("EXPECTED_MODEL_HASH is required unless --print is used");
}
if (!/^0x[0-9a-f]{64}$/.test(VENUE_ID)) {
  throw new Error("VENUE_ID must be an explicit lowercase bytes32");
}

const numberFromEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
};

function actualUpstreamCommit(): string {
  const commit = execFileSync("git", ["-C", UPSTREAM_DIR, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("cannot resolve pinned dreamdex-bot-kit commit");
  return commit;
}

async function exactSdkVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(resolve("node_modules/@somnia-chain/markets-sdk/package.json"), "utf8")) as {
    version?: string;
  };
  if (!pkg.version || !/^\d+\.\d+\.\d+/.test(pkg.version)) throw new Error("cannot resolve markets-sdk version");
  return pkg.version;
}

const config = loadConfig();
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
  config: {
    model: "strike",
    momentum_window_ms: numberFromEnv("OF_MOMENTUM_WINDOW_MS", 60_000),
    max_spot_age_ms: numberFromEnv("OF_MAX_SPOT_AGE_MS", 15_000),
    vol_window_ms: numberFromEnv("OF_VOL_WINDOW_MS", 600_000),
    expected_move_fallback: numberFromEnv("OF_EXPECTED_MOVE", 0.0015),
    min_vol: numberFromEnv("OF_MIN_VOL", 0.0002),
    sensitivity: numberFromEnv("OF_SENSITIVITY", 20),
    require_measured_volatility: process.env.OF_REQUIRE_MEASURED_VOL !== "false",
    edge: numberFromEnv("OF_EDGE", 0.03),
    max_disagreement: numberFromEnv("OF_MAX_DISAGREEMENT", 0.1),
    probability_grid: 10_000,
    market_baseline: "best-yes-bid-ask-midpoint",
    recorder_poll_ms: numberFromEnv("RECORDER_POLL_MS", 5_000),
    data_sources: {
      rpc_url: config.rpcUrl,
      ws_rpc_url: config.wsRpcUrl,
      indexer_url: config.indexerUrl,
      price_feed: config.priceFeed ?? null,
      contract_addresses: config.addresses,
      venue_id: VENUE_ID,
    },
  },
  source_files: source.files,
  source_tree_dirty: source.dirty,
};

const actual = modelHash(manifest);
if (PRINT_ONLY) {
  console.log(
    `MODEL_HASH_COMPUTED model_hash=${actual} source_aggregate=${source.aggregate} source_tree_dirty=${source.dirty}`,
  );
} else if (actual !== EXPECTED_MODEL_HASH) {
  console.error(
    `MODEL_HASH_MISMATCH expected=${EXPECTED_MODEL_HASH} actual=${actual} `
      + `source_aggregate=${source.aggregate} source_tree_dirty=${source.dirty}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `MODEL_HASH_OK model_hash=${actual} source_aggregate=${source.aggregate} source_tree_dirty=${source.dirty}`,
  );
}
