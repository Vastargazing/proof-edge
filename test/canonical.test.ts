import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalForecast,
  canonicalForecastV1,
  commitmentFor,
  probabilityOnGrid,
} from "../src/canonical.js";
import type { ForecastPreimageV1, ForecastPreimageV2 } from "../src/types.js";

const bytes = (hex: string) => `0x${hex.repeat(64).slice(0, 64)}` as `0x${string}`;

const fixture = (): ForecastPreimageV1 => ({
  v: 1,
  market_id: bytes("1"),
  venue_id: bytes("2"),
  symbol: "BTC",
  interval_sec: 898,
  expiry_ns: "1787676300000000000",
  p_agent: 0.74,
  side: "YES",
  p_market: 0.61,
  model_hash: bytes("3"),
  evidence_digest: bytes("4"),
  nonce: bytes("5"),
});

test("v1 canonicalization sorts keys and freezes four probability digits", () => {
  assert.equal(
    canonicalForecastV1(fixture()),
    '{"evidence_digest":"0x4444444444444444444444444444444444444444444444444444444444444444","expiry_ns":"1787676300000000000","interval_sec":898,"market_id":"0x1111111111111111111111111111111111111111111111111111111111111111","model_hash":"0x3333333333333333333333333333333333333333333333333333333333333333","nonce":"0x5555555555555555555555555555555555555555555555555555555555555555","p_agent":0.7400,"p_market":0.6100,"side":"YES","symbol":"BTC","v":1,"venue_id":"0x2222222222222222222222222222222222222222222222222222222222222222"}',
  );
});

test("commitment is deterministic and rejects off-grid input", () => {
  assert.equal(commitmentFor(fixture()), commitmentFor({ ...fixture() }));
  assert.throws(() => commitmentFor({ ...fixture(), p_agent: 0.74001 }), /1e-4 grid/);
  assert.equal(probabilityOnGrid(0.74001), 0.74);
});

test("unsafe expiry number cannot enter the string-only schema", () => {
  assert.throws(
    () => canonicalForecastV1({ ...fixture(), expiry_ns: "01787676300000000000" }),
    /canonical decimal string/,
  );
});

test("v2 commits observed_at_ns while v1 canonical bytes remain frozen", () => {
  const v1 = fixture();
  const v2: ForecastPreimageV2 = { ...v1, v: 2, observed_at_ns: "1787676200123000000" };
  assert.equal(
    canonicalForecast(v2),
    '{"evidence_digest":"0x4444444444444444444444444444444444444444444444444444444444444444","expiry_ns":"1787676300000000000","interval_sec":898,"market_id":"0x1111111111111111111111111111111111111111111111111111111111111111","model_hash":"0x3333333333333333333333333333333333333333333333333333333333333333","nonce":"0x5555555555555555555555555555555555555555555555555555555555555555","observed_at_ns":"1787676200123000000","p_agent":0.7400,"p_market":0.6100,"side":"YES","symbol":"BTC","v":2,"venue_id":"0x2222222222222222222222222222222222222222222222222222222222222222"}',
  );
  assert.notEqual(commitmentFor(v2), commitmentFor({ ...v2, observed_at_ns: "1787676200123000001" }));
  assert.equal(canonicalForecast(v1), canonicalForecastV1(v1));
});
