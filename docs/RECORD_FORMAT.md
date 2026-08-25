# Forecast record format v1

This document freezes the v1 bytes used by production recorder batches.

The root `0x5e759f…ef094`, anchored in transaction `0xaf9a9b…11f1e`, is a
pre-v1 integration smoke batch. Its commitments and Merkle proofs remain valid,
but its full evidence bodies were not retained and its model hash predates the
final risk-threshold manifest. It is excluded from calibration claims.

## Preimage

The preimage is UTF-8 JSON with lexicographically sorted keys and no whitespace.
String escaping follows JSON. `p_agent` and `p_market` are the only
schema-special numbers: they are always emitted with exactly four fractional
digits on the `1e-4` grid. `expiry_ns` is a decimal string because epoch
nanoseconds are not safe JavaScript numbers.

```json
{"evidence_digest":"0x…","expiry_ns":"1787676300000000000","interval_sec":898,"market_id":"0x…","model_hash":"0x…","nonce":"0x…","p_agent":0.7400,"p_market":0.6100,"side":"YES","symbol":"BTC","v":1,"venue_id":"0x…"}
```

Frozen rules:

- `v = 1`;
- lowercase 0x-prefixed bytes32 IDs and digests;
- 32-byte random nonce;
- Keccak-256 over the exact canonical UTF-8 bytes;
- probability grid `1e-4`;
- actual `interval_sec` field, never an interval inferred from a label;
- market baseline captured once at observation time and never refreshed.

## Model hash

`model_hash` is Keccak-256 over deterministic JSON containing:

- estimator identity;
- SHA-256 of the local adapter plus pinned upstream signal source;
- pinned dreamdex-bot-kit commit;
- markets SDK version family;
- every estimator parameter, including volatility windows and thresholds;
- prompt text when an estimator has one.

Changing any of these creates a new model hash. Old records are never rewritten.

## Evidence digest

The v1 live adapter commits to its complete observation payload: oracle write
time, spot, return, opening/fixed reference, measured and fallback volatility,
top three YES bid/ask levels, raw market midpoint, market timestamps, and model
manifest.

The complete evidence object is retained in the local append-only log alongside
the public preimage. On load and before append, the recorder recomputes
`evidence_digest` and rejects a mismatch. A reveal can therefore publish the
exact evidence object rather than an unverifiable summary. The pre-v1 smoke
batch is the only explicit exception.

## Merkle envelope

The frozen preimage does not contain batch metadata. The append-only event log
adds it separately after commitment creation:

```text
forecast_observed(preimage, commitment)
forecast_risk_decision(allowed, reason, edge, risk config hash)
batch_prepared(root, leaf index, proof)
batch_anchored(transaction, block number, block timestamp, gas)
forecast_revealed(outcome)
forecast_scored(Brier agent, Brier market)
```

Leaves are sorted by `market_id` then commitment. Parent nodes are ordered
`keccak256(left || right)`; an odd final node is duplicated. The leaf index
supplies proof direction. `batch_id` equals the root.

Every JSONL event is also linked to its predecessor with `prev_event_hash`, and
is fsynced before the recorder continues. Restart reconstructs the index and
refuses partial lines, broken sequence numbers, broken hash chains, conflicting
forecasts for one market ID, or one commitment appearing in two batches.
Forecast, risk decision, reveal, and score are separately idempotent. If the
process stops between any two stages, the next loop fills only the missing
stage. All evaluated markets are recorded; the risk gate affects execution
eligibility, never inclusion in the calibration sample.

## Anchor verification

Production uses the storage-free `ForecastRootEmitter`:

1. locate its `RootAnchored` log in the recorded transaction receipt;
2. verify receipt success and root/leaf count;
3. read the immutable block timestamp and require it to precede `expiry_ns`;
4. recompute the preimage commitment;
5. verify the ordered Merkle proof against the emitted root.

The contract also exposes a pure proof verifier. Time ordering is verified from
the receipt instead of contract storage; this is the explicit gas/security
tradeoff selected for the hackathon recorder.
