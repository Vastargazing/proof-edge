# ProofEdge threat model

This document describes the checked-in system at the audit-fix snapshot. It
separates properties enforced by hashes, properties read from Somnia Shannon,
and facts that still depend on the operator. It does not treat availability or
good forecasting performance as a cryptographic property.

## Assets and adversary

The protected assets are the exact forecast preimage, its observation evidence,
its position in a Merkle batch, the batch's anchor time, the resolved market
outcome, the score derived from the sealed probabilities, and the completeness
of roots submitted by the declared production wallet during the declared
period.

The adversary may control the repository publisher and dashboard, reorder or
rewrite local files, choose which files to show, and submit arbitrary roots from
the production key. The model does not assume that the recorder is continuously
online or that upstream market, price-feed, indexer, RPC, or oracle data is
correct. Keccak-256 collision/preimage resistance and the versioned canonical
byte formats are assumed. Somnia consensus and the deployed contract code are also
assumed.

## What hashes prove

- `canonical_preimage` fixes the versioned bytes for `market_id`, venue, symbol,
  interval, expiry, probabilities, side, model hash, evidence digest, and nonce.
  A changed field changes the commitment unless Keccak-256 is broken.
- v2 additionally commits `observed_at_ns`. Historical v1 records do **not**
  attest their outer observation timestamp: an operator able to rewrite and
  re-anchor a complete v1 record could choose that envelope timestamp freely.
- `evidence_digest` binds the retained observation body, including source data
  and model manifest. It does not prove those inputs were truthful.
- An ordered Merkle proof binds a commitment to a disclosed root and leaf index.
  v2 trees hash leaves as `keccak256(0x00 || commitment)` and parents as
  `keccak256(0x01 || left || right)`; frozen v1 trees retain their unprefixed
  construction.
- The JSONL `prev_event_hash` chain detects deletion, insertion, reordering, or
  editing if the expected head is known independently. By itself, a local hash
  chain can be rebuilt by the operator.
- Scores are recomputed from the sealed `p_agent`, sealed `p_market`, and the
  revealed binary outcome. Historical probabilities are not refreshed.
- Seeded bootstrap intervals use a canonical `market_id` order, so JSONL order
  no longer changes the reported interval.

None of these properties proves that a forecast was created before expiry. That
ordering comes from the chain anchor.

## What the chain proves

- A successful receipt from the configured emitter proves that a root and leaf
  count were submitted by the address indexed in `RootAnchored` at the receipt's
  block timestamp.
- `verify` resolves the supplied `market_id` through `getMarketOnchain`, rejects
  a nonexistent ID, and compares the file's expiry and outcome with on-chain
  state. Anchor time is compared with on-chain expiry, not an indexer field.
- A forecast is called on-time only when the anchor block timestamp is strictly
  earlier than on-chain expiry. No minimum lead time is enforced.
- `verify:completeness` enumerates all roots from the configured emitter,
  submitter, and production block period. A missing disclosed batch, wrong leaf
  count, duplicate root event, or overlap between disclosed batches is a
  failure.
- The forward emitter format includes the preceding JSONL head in the same
  transaction as the Merkle root. For a forward-format batch, `verify:chain`
  rejects a missing or different head.

Emitter `0x3020…e4f` is the legacy root-only contract. The active ledger-head
emitter `0xf700…b95f` was deployed at block `471812148` and first used at block
`471834978`. Existing roots cannot be upgraded retroactively.

## What remains trusted

- Recorder uptime and polling cadence. Filtered discovered windows now leave
  reason-coded skip events and normal operation leaves periodic heartbeats;
  downtime is visible as absence after the last pulse. A market never returned
  by discovery still leaves no event for completeness scanning.
- Discovery and input availability. Each poll inspects at most 50 active rows;
  non-binary or non-BTC/ETH rows, already-seen IDs, missing spot/momentum,
  unreadable on-chain markets, invalid intervals, expired rows, one-sided books,
  unanswered opening/fixed references, and missing required measured volatility
  are skipped.
- Accuracy and independence of spot, order-book, opening-reference, indexer,
  RPC, oracle, and chain data. Their endpoints and current runtime versions are
  sealed in new model hashes, but sealing a source does not validate it.
- The operator's definition of the production emitter, submitter, and block
  period. Roots sent from a different wallet or contract are outside the scan.
- Protection of the submitter key and the host that owns the live ledger.
- Timely operation and Git credentials of the hourly publisher. The checked-in
  job validates, scoped-commits, pushes without force, verifies completeness
  after publication, and raises a systemd alert on failure.
- For legacy roots, the full local ledger history. Their Merkle contents are
  bound, but the surrounding JSONL head was not placed on-chain.

Even after forward activation, each root anchors the prefix immediately before
its `batch_prepared` event. Events after the newest anchored head remain a
removable tail until a later batch anchors a newer head. Heartbeats are local
ledger events rather than empty on-chain roots, so the newest heartbeat tail is
not independently chain-attested until a later forecast batch anchors its head.

## Adversarial-audit findings and repairs

### Selective publication

The old snapshot job refused to publish while any outcome was pending. The job
now validates and atomically publishes the complete ledger, including pending
records, and the dashboard shows `pending_resolution`. Current ledger totals are
generated in `dashboard/app/forecast-data.json`; current resolved, on-time proof
totals are generated in `evidence/index.json`. Individual evidence files remain
resolution-gated. The hourly unit runs both exporters without starting a second
writer. Publication runs hourly, so the live ledger may lead the public copy by
up to one hour and several roots.

### File-supplied market truth

The evidence verifier previously trusted file-supplied expiry and outcome. It
now reads the market from chain. Tests independently tamper expiry, outcome, and
market ID; all three fail with the mismatched field or unknown-ID reason.

### Hidden competing roots

The completeness command found 35 legacy events from the wallet when scanning
from emitter deployment: 27 production roots and 10 synthetic benchmark roots.
All 27 production roots are now disclosed with matching leaf counts. The ten
benchmark roots are the closed block range `471035563..471035785`, with leaf
counts 1 through 10, and are excluded by the documented default production
start `471035786`.

The legacy event exposes only `root` and `leafCount`. If a root is wholly hidden,
the command proves that it is hidden and reports its leaf count, but cannot infer
which market IDs it covers. Window overlap is detectable once both leaf lists are
disclosed. This limitation cannot be repaired for past events off-chain.

### Rewritable local event chain

The updated contract and recorder bind a preceding ledger head to every new
root. A regression test models deleting an earlier batch, rebuilding the local
chain, and receiving `FAIL` for the head mismatch. This repair is forward-only:
the first ledger-head root was anchored at block `471834978`, while earlier
production roots remain legacy.

### Concurrent-writer ledger incident (2026-08-27)

The incident image is retained byte-for-byte at
`incidents/2026-08-27/forecast-events.jsonl.corrupted` with SHA-256
`274642299ee63bf97b4b1bb28b181beba8960961afec0af532a5006a3d894475`.
It contains no wallet secret. Line 621 is a terminal publication-watermark
branch from the same parent as line 622; lines 622 through 1051 form the
continued chain. The image is evidence and a regression fixture, not a ledger
that any runtime component may rewrite.

Readers validate every event's own `event_hash`, build connectivity from
`prev_event_hash`, and expose the canonical-chain decision in a structured
integrity report. Terminal losing branches and disconnected events are listed
as orphans, counted in publication output, and rendered as a separate dashboard
counter. They are never silently indexed. A fork is fail-closed when competing
sides both have descendants, because that is sustained history on both sides
rather than a terminal orphan. An invalid event hash is always fail-closed.

Writers must explicitly request writable store access. Writable open acquires
an atomic sidecar lock containing the process ID and Linux process start token;
a live owner causes an immediate refusal. A dead owner, including a process
terminated by `SIGKILL`, is detected without trusting PID reuse and the stale
lock is recovered. Read-only verification and publication do not take the
writer lock.

The checked-in watchdog samples the recorder service plus forecast and anchor
counts every ten minutes. Either counter remaining unchanged for two consecutive
ticks is an alert; an inactive recorder service is an immediate alert. Its state
lives outside the checkout under `~/.local/state/proof-edge/`. The timer and
alert units still depend on the operator installing and enabling the checked-in
units. The recorder unit also has a stop hook that emits an immediate alert for
any non-successful service result, including a crash that systemd subsequently
restarts.

The recorder deliberately remains fail-fast on transient price-feed errors. An
observed connect timeout terminated the process; the stop hook alerted and
systemd restarted it after eight seconds, restoring `SpotHistory`, recovering
the writer lock, and retaining every fsynced event and prepared batch. The
operational cost of an isolated crash is estimated at one or two missed windows.
We consciously did not strengthen this error path before the collection
deadline because changing forecast- or recording-affecting code would rotate
`model_hash` and split the accumulating sample. If the feed instead remains
unavailable for hours and alerts or the journal show tens of restarts, this
tradeoff no longer holds and the repair must be treated as an explicit model
version change.

### Overstated documentation and display counts

The dashboard now describes immutable preimages rather than immutable outcomes,
scores, or risk decisions. Its proof count includes only resolved, on-time
forecasts with full evidence. Documentation records the four historical
fallback-volatility/`0.28.x` manifests, the current exact version behavior, the
real discovery filters, the lack of minimum lead time, and the boundary between
recorded-sample inclusion and global market completeness.

## Residual forgery and disappearance scenarios

A published forecast can be changed without a verifier failure only if the
adversary breaks the hash assumptions, compromises or changes the chain/RPC
trust base, or changes an unanchored tail before a forward ledger head covers it.
Source observations can still be false because their correctness is not proved
by hashing.

An anchored production root cannot disappear silently from the configured
period: `verify:completeness` reports it. A market can still disappear before
anchoring because of downtime, the 50-row discovery cap, any documented input
filter, use of a different submitter/emitter, or an incorrectly chosen audit
period. A fully hidden legacy root's leaf membership cannot be recovered.

Independent checking works from a public clone with public Shannon access:
`npm run check`, `verify:log`, `verify:chain`, `verify:completeness`, and
`verify:all`. The forward ledger-head format is active from block `471834978`.
