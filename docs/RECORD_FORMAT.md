# Forecast record formats v1 and v2

`JSON.stringify(0.74)` produces `0.74`. A ProofEdge v1 probability is
`0.7400`. Those two byte strings describe the same JavaScript number and
produce different commitments, which is why this format is implemented by a
schema-aware canonicalizer instead of ordinary JSON serialization. The exact
v1 fixture is frozen in `test/canonical.test.ts:28-38`.

This document specifies the bytes a verifier must preserve. Readers dispatch on
`v`; they never upgrade, normalize or re-encode a historical record.

## One forecast has six layers

| Layer | Purpose | Can change after observation? |
| --- | --- | --- |
| Canonical preimage | Freezes identity, probabilities, expiry and hashes | No |
| Evidence body | Retains the inputs and model manifest named by `evidence_digest` | No |
| JSONL event | Gives the observation a place in local history | Append-only |
| Merkle batch | Groups commitments under one root | No after `batch_prepared` |
| Chain event | Timestamps root, leaf count and, for v2-era batches, ledger head | No |
| Public evidence file | Packages existing fields for one independent verification | Derived only |

The layers are deliberately separate. A Merkle proof does not carry the order
book. The evidence body does not establish chain time. The JSONL event chain
does not make a local timestamp authoritative.

## 1. Canonical preimage

The frozen v1 preimage is UTF-8 JSON with lexicographically sorted keys and no
whitespace:

```json
{"evidence_digest":"0x…","expiry_ns":"1787676300000000000","interval_sec":898,"market_id":"0x…","model_hash":"0x…","nonce":"0x…","p_agent":0.7400,"p_market":0.6100,"side":"YES","symbol":"BTC","v":1,"venue_id":"0x…"}
```

The rules are exact:

- `v` is `1`;
- IDs, digests and nonce are lowercase, `0x`-prefixed `bytes32`;
- the recorder generates a 32-byte random nonce when none is supplied;
- `p_agent` and `p_market` are in `[0, 1]`, lie on the `1e-4` grid, and
  always serialize with four fractional digits;
- `interval_sec` is the actual market field, not a value inferred from a
  cadence label;
- `expiry_ns` is a canonical decimal string because epoch nanoseconds are not
  safe JavaScript integers;
- `p_market` is captured once at observation and is never refreshed;
- the commitment is Keccak-256 over the exact canonical UTF-8 bytes.

Validation and byte construction live in `src/canonical.ts:15-66,109-110`;
nonce generation lives in `src/recorder.ts:18-38`.

### What v2 changed

v1 left the outer `observed_at_ns` field outside the preimage. A valid v1
commitment therefore does not authenticate that timestamp. v2 inserts the same
canonical decimal string between `nonce` and `p_agent` in sorted-key order
and requires the envelope value to match it
(`src/canonical.ts:69-106`, `src/evidence.ts:125-157`).

That was a forward change, not a migration. The v1 function and every v1 root
remain byte-for-byte unchanged. A batch cannot mix v1 and v2 observations
(`test/store.test.ts:144-163`).

## 2. Evidence body and model identity

`evidence_digest` is Keccak-256 over deterministic JSON for the complete
observation payload. The live adapter records oracle time, spot, momentum
return, opening or fixed reference, measured and used volatility, the top three
YES bid and ask levels, the raw market midpoint, market timing fields and the
model manifest (`src/live-recorder.ts:224-280`).

The store recomputes the digest before accepting a forecast and again when it
loads the ledger. A changed book level or manifest is rejected rather than
treated as a new rendering of the same observation
(`src/store.ts:346-354`, `test/store.test.ts:235-241`).

`model_hash` is the hash of the manifest, not a friendly version label. Current
manifests include:

- estimator identity and every estimator/risk parameter;
- a path-keyed SHA-256 inventory of local `src/`, vendored `ec-core`, the
  upstream signal file and package locks, plus an aggregate digest;
- an explicit dirty-tree flag, while the path hashes still bind the dirty
  bytes;
- the checked-out upstream commit and installed markets SDK version;
- Node, V8, modules, OpenSSL and libuv versions;
- RPC, WebSocket, indexer, price-feed, venue and protocol addresses;
- prompt text, if a future estimator has one.

The manifest is assembled at recorder startup
(`src/live-recorder.ts:80-167`); the source inventory hashes paths and bytes
in `src/source-inventory.ts:24-48`. Changing any of those fields creates a new
`model_hash`. Old observations are not rewritten.

The first four production evidence bodies retain
`volatility.measured = null`, `volatility.used = 0.0015`, and the historical
SDK label `0.28.x`. Later production requires measured volatility and records
the installed exact SDK version. That difference remains in the sealed bodies;
we did not backfill it. The four files are identified by their shared root in
`evidence/index.json:3-29`; one body shows the retained fields at
`evidence/0x000000000000000000000000000000000000000000000000000000000000961a-1787677622133000000.json:35-36,75`.

## 3. JSONL ledger

Each physical line is a `LogEnvelope`:

```text
seq
written_at_ns
prev_event_hash
event
event_hash = keccak256(canonical JSON of the four fields above)
```

The writer appends one JSON object plus a newline, calls `fsync`, and only then
updates its in-memory index (`src/store.ts:505-525`). The event union currently
contains:

```text
forecast_observed
forecast_risk_decision
forecast_skipped
recorder_heartbeat
spot_observed
batch_prepared
batch_anchored
publication_watermark
forecast_revealed
forecast_scored
```

Their typed fields are the public schema in `src/types.ts:50-225`.

On open, a reader refuses a partial final line or an invalid `event_hash`, then
reconstructs the chain from parent hashes. A terminal losing branch is reported
as an orphan; a fork with descendants on both sides fails closed
(`src/store.ts:259-318`).

`publication_watermark` exists only in a published copy. It records the captured
block, source-ledger head, disclosed and undisclosed root counts, pending roots
and completeness failures. Roots mined after that block belong to the next
publication window instead of racing the current snapshot
(`src/types.ts:153-164`, `scripts/verify-completeness.ts:63-79`).

Forecasts are idempotent by `market_id`; a second commitment for the same
market fails. Prepared and anchored batches, reveals and scores are separately
idempotent. A risk decision is idempotent by
`(market_id, risk_config_hash)`, so a new configuration appends a new ruling
instead of changing the first one (`src/store.ts:655-729`).

The PASS subset uses the first risk decision sorted by `decided_at_ns`.
`verifyRecordedRiskDecision` recomputes `allowed`, reason, absolute edge and
configuration hash from the sealed probabilities and
`model_manifest.config`. The timestamp itself is operator-written, and the
decision is a separate log event rather than part of the forecast commitment
(`src/store.ts:621-651`, `src/risk-verifier.ts:19-57`).

`forecast_skipped`, heartbeats and deduplicated spot observations are retained
for operational diagnosis. A skip is idempotent by `(market_key, reason)`: the
first refusal of a market for a given reason is appended, every later refusal
with the same key is dropped, and the key set is rebuilt from the ledger on
open, so the rule survives restarts (`src/store.ts:242-244,687-691`). Spot
observations are idempotent by `(asset, oracle_observed_at_ms)`. These events
make a warm-up refusal or the last successful pulse visible; they do not prove
that discovery returned every market, and a frozen input shows up as the
absence of new events rather than as repeated ones. Current
discovery inspects at most 50 active rows and records one forecast only after
the BTC/ETH binary-market, spot, momentum, on-chain metadata, two-sided book,
reference and measured-volatility gates pass. Startup replays the retained spot
horizon into `SpotHistory`, so a service restart does not silently discard the
volatility warm-up (`src/live-recorder.ts:131-140,204-285,348-385`).

## 4. Merkle batch

Pending observations are sorted by `market_id`, then commitment.
`batch_id` equals the root. An odd node is duplicated, and the leaf index
determines whether each sibling is hashed on the left or right
(`src/merkle.ts:17-56`).

The two tree versions are:

```text
v1 leaf   = commitment
v1 parent = keccak256(left || right)

v2 leaf   = keccak256(0x00 || commitment)
v2 parent = keccak256(0x01 || left || right)
```

Version 2 separates the leaf and internal-node domains. Version 1 stays
unprefixed so its published roots continue to verify. The contract exposes a
pure verifier for each construction
(`contracts/ForecastRootEmitter.sol:33-66`).

`batch_prepared` is fsynced before submission. A restart can therefore recover
an unanchored batch instead of rebuilding it with a different root. Submission
failure uses exponential backoff while observation continues
(`src/anchor-coordinator.ts:62-105`).

## 5. Chain anchor

The active storage-free emitter records:

```text
RootAnchoredWithLedgerHead(root, leafCount, ledgerHead, submitter)
```

`ledgerHead` is the JSONL head that existed immediately before
`batch_prepared`. The active emitter
`0xf700bde4cbe7000a4ce075ea093e6a835974b95f` was deployed at block
`471812148` and first used at block `471834978`
(`deployments/shannon.json:24-37`).

Legacy emitter `0x3020c7ea249b6be98d0e9acf911eaeeb766ace4f`
emitted only `(root, leafCount, submitter)`. Its history remains valid but
cannot be upgraded with a ledger head. `verify:chain` accepts both eras and
requires an exact head for every forward batch
(`scripts/verify-chain.ts:33-80`).

The contract stores no timestamp mapping. Verification reads the successful
transaction receipt and immutable block timestamp. The recorder converts block
seconds to nanoseconds and marks every leaf whose expiry is less than or equal
to that time as late (`src/emitter.ts:91-127`). A late record remains visible
but is excluded from the provable and scored sets. There is no minimum
lead-time rule. Current writers persist both `status` and `late_market_ids`;
readers derive them again and reject inconsistent metadata
(`src/store.ts:374-398`).

## 6. Public evidence

The hourly publisher copies the complete validated ledger even when outcomes
are pending. In the normal hourly flow, an unresolved observation therefore
becomes public before its individual reveal file exists. This narrows the
selective-publication gap; it does not prove publisher uptime.

After resolution, the evidence exporter copies existing fields into
`evidence/<market_id>-<observed_at_ns>.json`:

- preimage, exact canonical bytes, commitment and full evidence body;
- first risk decision, leaf count, Merkle version, index and proof;
- root, anchor transaction and block timestamp;
- resolved outcome and derived `anchored_late` marker.

It derives these values from the ledger rather than recalculating a new
forecast (`src/evidence.ts:26-100`). Unresolved forecasts and records without a
full evidence body do not receive individual files. The first six-leaf smoke
batch is the only documented missing-body exception; its commitments still
verify. Its probabilities and outcomes remain in the ledger-derived score and
calibration, but without individual evidence files those six points cannot be
independently reverified from the public proof set
(`deployments/shannon.json:39-43`, `test/evidence.test.ts:104-112`).

`evidence/index.json` lists filename, leaf index, root, transaction and late
status. Its totals separate provable and late records. Cleanup is
non-destructive: an obsolete owned file that fails local validation is moved,
byte-for-byte, to `evidence/_rejected/<filename>/evidence.json` beside a
`reason.json`. A stale file that still verifies is kept, and an existing
quarantine entry is never overwritten
(`test/evidence.test.ts:114-177`).

## Verification order

`npm run verify -- <file>` performs five ordered checks:

1. Rebuild the canonical preimage, commitment, evidence digest, model hash and
   risk ruling.
2. Rebuild the ordered Merkle path with the declared tree version.
3. Decode the emitter receipt; match root, submitter, leaf count, proof depth and
   block timestamp.
4. Read DreamDEX by `market_id`; match on-chain expiry and outcome.
5. Require `anchor_block_timestamp × 1_000_000_000 < expiry_ns`.

The full sequence is implemented in `src/evidence-verifier.ts:62-193`. A byte or
chain mismatch is `FAIL`. A valid proof anchored at or after expiry is
`NOT PROVABLE`, not `FAIL`.

## Compatibility boundaries

- The six-leaf smoke root `0x5e759f…ef094`, transaction
  `0xaf9a9b…11f1e`, has valid commitments but no retained evidence bodies.
- v1 does not authenticate outer `observed_at_ns`; v2 does.
- v1 Merkle trees do not use domain prefixes; v2 trees do.
- Legacy root events do not bind a JSONL head; forward events do.
- Historical anchors without explicit `status` and `late_market_ids` remain
  readable because readers derive timing from block time and expiry.
- Risk decisions have no dedicated anchor. Their formula is reproducible, while
  their operator-written ordering timestamp remains trusted.

The wider trust boundary is documented in
[`THREAT_MODEL.md`](../THREAT_MODEL.md). Recovery, publisher operation and
completeness range overrides are in [`docs/RUNBOOK.md`](RUNBOOK.md).

## Sources

- Frozen preimages: `src/canonical.ts`, `test/canonical.test.ts`; commit
  `0f0fec7ffcfa816cf1c52635d5b855c108a9f761`.
- Ledger and restart behavior: `src/store.ts`, `src/recorder.ts`,
  `src/anchor-coordinator.ts`; tests in `test/store.test.ts`.
- Merkle and emitter formats: `src/merkle.ts`,
  `contracts/ForecastRootEmitter.sol`, `deployments/shannon.json`.
- Public reveal format: `src/evidence.ts`, `src/evidence-verifier.ts`,
  `test/evidence.test.ts`, `test/evidence-verifier.test.ts`.
