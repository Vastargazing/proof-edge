import { keccak256, toBytes } from "viem";
import type { ForecastPreimageV1, Hex32 } from "./types.js";

const HEX32 = /^0x[0-9a-f]{64}$/;
const DECIMAL_NS = /^(0|[1-9][0-9]*)$/;
const SYMBOL = /^[A-Z0-9._-]{1,16}$/;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex32;

export { ZERO_HASH };

function assertHex32(value: string, name: string): asserts value is Hex32 {
  if (!HEX32.test(value)) throw new Error(`${name} must be lowercase 0x-prefixed bytes32`);
}

function fixedProbability(value: number, name: string): string {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be finite and within [0, 1]`);
  }
  const scaled = Math.round(value * 10_000);
  if (Math.abs(value * 10_000 - scaled) > 1e-8) {
    throw new Error(`${name} must lie on the frozen 1e-4 grid`);
  }
  return (scaled / 10_000).toFixed(4);
}

export function validateForecastV1(value: ForecastPreimageV1): void {
  if (value.v !== 1) throw new Error("v must be 1");
  assertHex32(value.market_id, "market_id");
  assertHex32(value.venue_id, "venue_id");
  assertHex32(value.model_hash, "model_hash");
  assertHex32(value.evidence_digest, "evidence_digest");
  assertHex32(value.nonce, "nonce");
  if (!SYMBOL.test(value.symbol)) throw new Error("symbol must be a short uppercase asset code");
  if (!Number.isSafeInteger(value.interval_sec) || value.interval_sec <= 0) {
    throw new Error("interval_sec must be a positive safe integer from the market row");
  }
  if (!DECIMAL_NS.test(value.expiry_ns)) throw new Error("expiry_ns must be a canonical decimal string");
  if (value.side !== "YES" && value.side !== "NO") throw new Error("side must be YES or NO");
  fixedProbability(value.p_agent, "p_agent");
  fixedProbability(value.p_market, "p_market");
}

/**
 * Frozen schema-aware canonical JSON. Keys are lexicographically sorted, all
 * strings use JSON escaping, and probability fields always have four digits.
 */
export function canonicalForecastV1(value: ForecastPreimageV1): string {
  validateForecastV1(value);
  const encoded: Record<string, string> = {
    evidence_digest: JSON.stringify(value.evidence_digest),
    expiry_ns: JSON.stringify(value.expiry_ns),
    interval_sec: String(value.interval_sec),
    market_id: JSON.stringify(value.market_id),
    model_hash: JSON.stringify(value.model_hash),
    nonce: JSON.stringify(value.nonce),
    p_agent: fixedProbability(value.p_agent, "p_agent"),
    p_market: fixedProbability(value.p_market, "p_market"),
    side: JSON.stringify(value.side),
    symbol: JSON.stringify(value.symbol),
    v: "1",
    venue_id: JSON.stringify(value.venue_id),
  };
  return `{${Object.keys(encoded)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encoded[key]}`)
    .join(",")}}`;
}

export function commitmentFor(value: ForecastPreimageV1): Hex32 {
  return keccak256(toBytes(canonicalForecastV1(value)));
}

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

/** Generic deterministic JSON for manifests, evidence, and the event hash chain. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    for (const key of keys) {
      if (object[key] === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function canonicalHash(value: unknown): Hex32 {
  return keccak256(toBytes(canonicalJson(value)));
}

export function probabilityOnGrid(value: number): number {
  if (!Number.isFinite(value)) throw new Error("probability must be finite");
  return Math.max(0, Math.min(1, Math.round(value * 10_000) / 10_000));
}
