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
- actual Git commit resolved from the checked-out dreamdex-bot-kit submodule;
- installed markets SDK version (new records read `node_modules`; the first four
  production records retain their historical `0.28.x` label);
- every estimator parameter, including volatility windows, thresholds, and the
  recorder polling interval;
- RPC, WebSocket, indexer, price-feed, venue, and protocol contract endpoints;
- Node/V8/module/OpenSSL/libuv runtime versions;
- prompt text when an estimator has one.

Changing any of these creates a new model hash. Old records are never rewritten.

## Evidence digest

The v1 live adapter commits to its complete observation payload: oracle write
time, spot, return, opening/fixed reference, measured or fallback volatility,
top three YES bid/ask levels, raw market midpoint, market timestamps, and model
manifest.

The first four production bodies record `volatility.measured = null` and
`volatility.used = 0.0015`. Later production bodies set
`require_measured_volatility = true` and contain a measured value. Both are
historical facts in sealed evidence; neither is backfilled.

The complete evidence object is retained in the append-only log alongside
the public preimage. On load and before append, the recorder recomputes
`evidence_digest` and rejects a mismatch. A reveal can therefore publish the
exact evidence object rather than an unverifiable summary. A reproducible
snapshot is published at `published/forecast-events.jsonl`. The pre-v1 smoke
batch is the only explicit exception.

## Merkle envelope

The frozen preimage does not contain batch metadata. The append-only event log
adds it separately after commitment creation:

```text
forecast_observed(preimage, commitment)
forecast_risk_decision(allowed, reason, edge, risk config hash)
batch_prepared(root, leaf index, proof)
batch_anchored(transaction, block number, block timestamp, gas, timing status, late market IDs)
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
Forecast, reveal, and score are separately idempotent. Risk decisions are
idempotent per `(market_id, risk_config_hash)`, allowing a changed configuration
to create an explicit new decision without rewriting the old one. If the
process stops between any two stages, the next loop fills only the missing
stage. The risk gate affects execution eligibility, never inclusion after a
forecast passes discovery/input filters. Those filters are: the first 50 active
rows returned per poll, binary BTC/ETH only, one observation per `market_id`,
valid spot and momentum, authoritative on-chain expiry, positive interval and
time-to-expiry, a two-sided YES book midpoint, an answered opening/fixed
reference, and measured volatility when the production flag requires it.

Current writers persist `status: "on_time" | "anchored_late"` on every anchor
and list the late leaves in `late_market_ids`. Readers derive the same status
from the immutable block timestamp and each forecast expiry, and reject
inconsistent metadata. Late records stay auditable but are excluded from the
provable set and Brier scoring. Legacy anchor events without these fields remain
readable because their status is derived rather than assumed.

This proves integrity of observations the recorder made. It does not prove
continuous uptime or enumerate markets skipped before valid estimator inputs
were available.

## Public evidence files

The hourly publisher copies the full validated JSONL ledger even while outcomes
are pending; the dashboard reports pending resolution separately. After
resolution, the evidence exporter copies each complete production record's
existing `forecast_observed` fields (`preimage`, exact `canonical_preimage`,
commitment, observation timestamp, and full evidence body) into one JSON file
per forecast. It adds the existing batch leaf index and proof, root, anchor
transaction and block timestamp, resolved outcome, and the derived
`anchored_late` marker. Filenames are `<market_id>-<observed_at_ns>.json`;
`observed_at_ns` is the recorder's commit timestamp. No unresolved forecast is
eligible for an individual evidence export. Legacy smoke records without the
full observation body are also ineligible; their partial commitments remain in the historical ledger but
do not enter `evidence/` or its provable count.

`evidence/index.json` lists leaf index, filename, root, transaction, and late
status for every published file. Its totals separate provable and late records.
The exporter never deletes rejected evidence. If an obsolete owned filename
fails deterministic JSON/preimage or Merkle verification, its original bytes
move to `evidence/_rejected/<filename>/evidence.json` and a sibling
`reason.json` records why. Existing quarantine entries are never overwritten.
A stale file that passes local verification stays in place, even during an RPC
outage. Every quarantine and protected stale file is logged with its reason.

## Anchor verification

Production uses the storage-free `ForecastRootEmitter`:

1. locate its `RootAnchored` log in the recorded transaction receipt;
2. verify receipt success and root/leaf count;
3. read `market_id`, expiry, and final outcome from chain and reject disagreement
   with the file;
4. read the immutable block timestamp and require it to precede the on-chain
   expiry (there is no minimum lead-time rule);
5. recompute the preimage commitment and verify the ordered Merkle proof against
   the emitted root.

Legacy anchors emit only `(root, leafCount, submitter)`. The forward emitter
format additionally emits the local event-chain head that existed immediately
before `batch_prepared`. `verify:chain` requires the exact head for those new
anchors, so removing an earlier batch and rebuilding local hashes changes the
head and fails against chain. Activating this format requires deployment of the
updated emitter and a recorder restart; it does not retrofit old anchors.

The contract also exposes a pure proof verifier. Time ordering is verified from
the receipt instead of contract storage; this is the explicit gas/security
tradeoff selected for the hackathon recorder.

The RPC block timestamp is in seconds. The verifier multiplies it by
`1_000_000_000` before comparing it with `expiry_ns`; the synthetic late-anchor
regression test fixes this unit boundary.
