# ProofEdge threat model

Line 621 and line 622 of our supposedly append-only ledger had the same parent.
Line 621 was a publication watermark. Line 622 started a branch that continued
for another 430 lines. The bytes prove the fork; they do not tell us which
process-level action started the second writer, and we do not know
(`incidents/2026-08-27/forecast-events.jsonl.corrupted`, SHA-256
`274642299ee63bf97b4b1bb28b181beba8960961afec0af532a5006a3d894475`;
`test/store.test.ts:96-112`).

That incident changed the boundary we defend. A forecast commitment is useful
only if an independent reader can establish four separate facts: the disclosed
bytes are unchanged, their root reached the chain before expiry, the resolved
market agrees with the disclosed outcome, and every production root inside the
declared audit period is present. ProofEdge checks those facts. It does not turn
uptime, price-feed accuracy or forecasting skill into cryptographic properties.

## The claim, in one table

| Claim | What enforces it | What it does not establish |
| --- | --- | --- |
| The forecast bytes were not edited | Versioned canonical JSON, `evidence_digest`, and Keccak-256 | That the captured inputs were true |
| The forecast belonged to this batch | Ordered Merkle proof, leaf index, root and leaf count | That every batch was disclosed |
| The batch existed before expiry | Emitter receipt block time compared with on-chain expiry | A minimum lead time before expiry |
| Expiry and outcome match DreamDEX | `getMarketOnchain(market_id)` during verification | That the oracle or chain was correct |
| Every scoped production root was disclosed | `verify:completeness` over the configured emitter, submitter and block period | Roots sent outside that scope |
| A PASS/FAIL gate ruling matches the sealed configuration | The verifier recomputes it from `model_manifest.config`, `p_agent` and `p_market` | `decided_at_ns` is operator-supplied; the decision has no dedicated anchor |
| The recorder was continuously online | Nothing | Missed markets during downtime or filtering |

The adversary in this document may control the repository publisher and
dashboard, rewrite local files, choose which evidence files to show, and submit
arbitrary roots from the production key. We assume Keccak-256
collision/preimage resistance, Somnia consensus, the deployed emitter bytecode
and the versioned canonical formats. We do not assume that the indexer, RPC,
spot source, opening-price reference, order book or market oracle is correct.

## How a proof is assembled

### 1. Freeze one observation

The recorder seals `market_id`, venue, symbol, interval, expiry, `p_agent`,
`p_market`, side, `model_hash`, `evidence_digest` and a random nonce. Both
probabilities sit on a fixed `1e-4` grid. Canonicalization sorts the keys and
then hashes the exact UTF-8 bytes; the recorder supplies a 32-byte random nonce
when none was provided (`src/canonical.ts:15-66,109-110`,
`src/recorder.ts:18-38`).

Version 2 also places `observed_at_ns` inside those bytes. Version 1 did not.
For a historical v1 record, an operator able to rewrite and re-anchor the whole
record could choose a different outer observation timestamp without changing
the commitment. We kept the v1 function frozen and introduced a separate v2
schema instead of silently changing old proofs
(`src/canonical.ts:69-106`, commit
`0f0fec7ffcfa816cf1c52635d5b855c108a9f761`).

`evidence_digest` binds the retained observation body and model manifest.
Changing a book level, spot value or manifest breaks that digest. A valid digest
still says only “these were the bytes we recorded,” not “the feed told the
truth” (`src/store.ts:346-354`).

### 2. Put observations into one root

Leaves are sorted by `market_id` and commitment. An odd node is duplicated, and
the leaf index fixes the left/right order of each proof step. Version 2
domain-separates leaves and parents with `0x00` and `0x01`; historical v1
trees retain their unprefixed construction. A batch cannot mix the two versions
(`src/merkle.ts:4-56`).

This proves membership after disclosure. It does not prove completeness. Our
first six-leaf production-shaped root still verifies, but we did not retain its
evidence bodies, so those six forecasts cannot support calibration
(`deployments/shannon.json:39-43`, `test/evidence.test.ts:105-109`).

### 3. Use chain time and chain market state

The evidence verifier reads the transaction receipt, finds the matching root,
checks the submitter and leaf count, and fetches the receipt block timestamp. It
then loads DreamDEX by `market_id` and rejects a different expiry, outcome or
unknown market (`src/evidence-verifier.ts:96-169`).

“On time” has one exact meaning: the anchor block timestamp in nanoseconds is
strictly less than the on-chain expiry. Equality is late. A structurally valid
late record returns `NOT PROVABLE`, remains visible, and does not enter scoring
(`src/evidence-verifier.ts:172-193`, `src/store.ts:456-469`). There is no
minimum lead-time rule; a root mined one block before expiry qualifies.

### 4. Check roots we might prefer not to show

A valid evidence file proves one disclosed leaf. It cannot reveal a second root
that the operator omitted. `verify:completeness` therefore scans both
production emitters for events from the declared submitter and compares them
with anchored batches in the public ledger. Undisclosed roots, duplicate
anchors, leaf-count mismatches, overlapping disclosed windows and ledger roots
missing on-chain are failures
(`scripts/verify-completeness.ts:82-175`, `src/completeness.ts`).

The default legacy scan starts at block `471035786`. The preceding closed range
`471035563..471035785` contains ten synthetic gas-benchmark roots with leaf
counts 1 through 10 and no forecast preimages. The active ledger-head emitter is
scanned from its deployment block `471812148`
(`scripts/verify-completeness.ts:27-43,153-158`).

Scope is part of the trust boundary. A different wallet, emitter or start block
can hide activity from this command. A wholly hidden legacy event exposes its
root and leaf count, but not its market IDs; overlap becomes knowable only after
the leaf list is disclosed.

### 5. Bind the local history, not only the Merkle tree

The first production emitter stored only `root`, `leafCount` and submitter.
We initially treated that event as the proof boundary. It was the obvious
design, and it was incomplete: the operator could delete an earlier JSONL
segment, rebuild every `prev_event_hash`, and leave each disclosed Merkle proof
valid.

We replaced it with `RootAnchoredWithLedgerHead`, which puts the exact
preceding JSONL head in the same transaction as the new root. The active emitter
was deployed at block `471812148`; its first root was mined at block
`471834978`. The legacy emitter remains readable, but its old roots cannot be
upgraded retroactively (`contracts/ForecastRootEmitter.sol:11-30`,
`deployments/shannon.json:13-37`; commits
`329b2f5b7ae970f7dde46a6025ffa799bdc43b3e` and
`80d036c3203a43af0f3e8b7bb4ae2e4433d18b61`).

Even the forward event anchors only the prefix immediately before
`batch_prepared`. Events after the newest anchored head remain a removable
tail until another batch commits a later head. Heartbeats are JSONL events, not
empty on-chain roots, so the newest liveness tail has the same limitation.

## Two hostile reviews

We ran the first adversarial review on 26 August against the working submission,
not against a threat-model checklist written in advance. It found three ways to
make a correct-looking public record say too much: the evidence verifier trusted
file-supplied market truth, publication depended on a manual snapshot, and the
local hash chain could be rebuilt after deleting history. The fixes landed in
commits `347076763f06019d72b7915c71ea606a9a8c41d2`,
`fb3a0d0ed56cbc634f89e3e1742ac54fa163dcba`, and
`329b2f5b7ae970f7dde46a6025ffa799bdc43b3e`; the forward-only emitter deployment
followed in `80d036c3203a43af0f3e8b7bb4ae2e4433d18b61`.

Later that day we started a second review in a fresh window without giving the
reviewer the first repair narrative. Git records the resulting fixes and their
order, but not that separation of review context, so the fresh-window detail is
an operator statement rather than a cryptographic claim. This pass found five
more boundaries:

| Finding | Status after the review |
| --- | --- |
| Anchors could land while a public snapshot was being assembled | Closed with a captured block watermark; later roots are reported as pending rather than compared with an earlier snapshot (`b1c99737c1aa64b538a8507f1c036cb888b916ef`, `test/completeness.test.ts:49-58`) |
| v1 `observed_at_ns` lived outside the commitment | Closed forward-only in v2; historical v1 timestamps remain unauthenticated (`0f0fec7ffcfa816cf1c52635d5b855c108a9f761`, `test/canonical.test.ts:48-56`) |
| `leaf_index` was accepted without the on-chain leaf count | Closed by checking submitter, `leafCount`, index bounds and proof depth (`0ba5e291a80045dbced9c105fa5b4340fee37bf4`, `src/evidence-verifier.ts:96-123`) |
| Risk-gate decisions were displayed but not independently recomputed | Partly closed: `allowed`, reason, edge and config hash are derived again from the sealed manifest (`src/risk-verifier.ts:19-57`) |
| Merkle leaves and internal nodes shared one hash domain | Closed forward-only with v2 `0x00`/`0x01` prefixes; frozen v1 proofs keep the old construction (`src/merkle.ts:4-26`) |

The risk-decision residue matters for the dashboard's PASS subset. A decision is
a separate JSONL event, not part of the forecast commitment and not given its
own on-chain anchor. A later ledger-head root may cover it as history, but the
report chooses the first decision by operator-written `decided_at_ns`
(`src/store.ts:621-651`). The verifier proves that the chosen ruling follows the
sealed thresholds; it does not prove when the operator made that ruling.

## What broke, and what we changed

### The hash chain forked

The first repair was not to erase line 621. Readers now validate every
`event_hash`, construct the graph from `prev_event_hash`, report a terminal
losing branch as an orphan, and select the sole branch that continues. If both
sides have descendants, the reader fails closed. A bad event hash also fails
closed (`src/store.ts:166-211,280-318`).

The writer now takes an atomic sidecar lock containing its PID, a random token
and the Linux process-start token. A live owner causes an immediate refusal; a
lock left by `SIGKILL` is recovered without trusting PID reuse
(`src/store.ts:83-164`, `test/store-lock.test.ts:10-46`). We paid for that
decision with a Linux `/proc` dependency on the recorder host.

### Pending outcomes blocked publication

The old snapshot path refused to publish while an outcome was pending. That
made a selective-publication attack possible: an operator could delay an
uncomfortable forecast until its answer existed. The hourly publisher now
copies the complete validated ledger, including anchored unresolved forecasts.
Individual files in `evidence/` remain resolution-gated
([record format § public evidence](docs/RECORD_FORMAT.md#6-public-evidence),
commit `e451f60808f4641bedead4da233962a0b08514e7`).

The job captures a block watermark, exports, runs the test and verification
suite, stages only the public ledger, dashboard data and evidence, pushes
without force, then repeats completeness after the push
(`scripts/publish-and-push.ts:54-101`). It runs hourly, so the private live
ledger may lead the repository by roughly one hour and several roots
(`ops/proof-edge-evidence.timer:1-8`).

### Evidence files supplied their own truth

The early verifier accepted expiry and outcome from the evidence file. That was
the easiest data source and the wrong authority. The current verifier reads both
from DreamDEX on-chain state. Tests mutate expiry, outcome and `market_id`;
each mutation fails at the chain check
(`test/evidence-verifier.test.ts:158-213`).

### Restart was not the same as liveness

Systemd restarts the recorder eight seconds after failure, but restart policy
does not prove that forecasts and anchors continue to advance
(`ops/proof-edge-recorder.service:7-18`). The watchdog samples service state,
forecast count and anchor count every ten minutes. An inactive unit alerts
immediately; a counter unchanged for two ticks alerts on the second
(`ops/proof-edge-watchdog.service:6-13`,
`ops/proof-edge-watchdog.timer:1-8`).

We observed a price-feed connect timeout terminate the process. Systemd
restarted it after eight seconds, the recorder recovered its writer lock and
fsynced state, and collection continued. We deliberately did not replace the
fail-fast path during the collection window because changing
forecast-affecting code would rotate `model_hash` and split the sample. That
choice is recorded in commit
`939ebb96c41dec5846e540cd0535fea2db4ea3f6`. We estimated the cost of one
isolated crash at one or two missed windows. If the feed stays unavailable and
the journal shows repeated restarts, that tradeoff no longer holds.

### The feed froze while the heartbeat continued

On 28 August the Somnia price feed stopped advancing at 14:49:55 UTC and
resumed on its own at 15:44:47 UTC. The recorder never crashed. Its poll loop
kept running, and because the heartbeat is written from inside that loop, the
ledger showed a heartbeat every minute. Each poll fetched the same frozen
oracle sample, which the store deduplicates by oracle timestamp, so no
`spot_observed` event was appended; momentum then failed the fifteen-second
freshness rule and every window was skipped with `momentum_unavailable`. Skip
events are deduplicated per market and reason, so after the first skip per
market the journal fell silent. Four consecutive fifteen-minute windows, about
34 forecasts at that day's rate, left no commitment
(`incidents/2026-08-28/README.md`).

The watchdog added after 27 August alerted on the flat forecast and anchor
counters from its second tick onward, which is exactly what it was built for.
The sentence above, that a heartbeat proves only that the process wrote
recently, was confirmed from the other side: a live heartbeat did not mean
live inputs. The operator read the silence as a hung loop and restarted the
recorder at 15:51:55 UTC, seven minutes after the feed had recovered. The
restart is still a useful record: it went through the pinned clone and the
fail-closed hash check, kept `model_hash` unchanged, and replayed the retained
spot horizon.

The watchdog now reads two ages from the ledger: the last heartbeat and the
last spot observation. A live unit whose heartbeat is older than fifteen
minutes is `recorder_stalled`; a fresh heartbeat with a spot older than
fifteen minutes is `inputs_stale`, an upstream condition that no restart can
fix. Only `recorder_stalled` triggers an automatic restart, and it goes through
the recorder unit, so `ExecStartPre` still refuses a drifted tree. At most two
automatic restarts are attempted per episode, with a three-tick grace period
between them; every attempt is written to the journal as `WATCHDOG_RESTART`
and raises the alert unit. An episode ends when a tick observes new forecasts
(`scripts/watchdog.ts`, `ops/proof-edge-watchdog.service`).

This is a compensating control, not a repair. Whether a price-feed read inside
the poll loop can block without a timeout is a property of `src/` and the
pinned upstream; this episode did not exercise it, and nothing rules it out.
Changing either before 8 September would rotate `model_hash` and split the
sample, the same tradeoff recorded for the fail-fast path above. If the loop
ever stops heartbeating, the watchdog restarts it and says so; the cause stays
in the code until the window closes.

### The recorder and the repository diverged

The live recorder is pinned to commit `9756f2c` in a dedicated clone. That
commit's source inventory reproduces the current `model_hash`,
`0x253a60a726a063c0e14acd10d7a206a0b82308a8bc703ced5304c79a1dd16417`. The
version began on 28 August at 05:40 UTC, when the recorder restarted after a
25-hour outage onto a day of accumulated `src/` commits; its estimator
configuration, endpoints and runtime versions are identical to the sixth
version, and only the inventoried source changed. Forty minutes after that
start, commit `80f1605` changed `src/publisher.ts` on `main`. Every later
commit therefore carries a different inventory aggregate: recomputing the
manifest from `HEAD` does not reproduce the hash the recorder is sealing, and a
restart from `HEAD` would open an eighth version.

The divergence is deliberate. We froze the recorder's code so that publisher,
documentation and dashboard work could continue without splitting the sample
before submission, and the systemd unit now refuses to start unless the
working tree hashes to the expected value
(`ops/proof-edge-recorder.service`, `scripts/check-recorder-model.ts`). To
reproduce the hash, check out `9756f2c` with the pinned submodule under Node
`v22.22.1` and the same estimator environment, then run
`scripts/check-recorder-model.ts --print` taken from `main`; the script is
outside the inventory. Every sealed manifest is also disclosed in full inside
its evidence body, so a verifier can compare it field by field without a
rebuild.

One historical version cannot be tied to git at all. Version 4
(`0x914a3008…`, eight forecasts observed on 26 August between 09:45 and 10:15
UTC) started from an uncommitted working tree. No commit reproduces its
`code_commit`, and the legacy manifest of that era carried neither per-file
digests nor a dirty-tree flag. Its eight forecasts remain in the mixed
historical total. For that version, the claim that `model_hash` covers the
code cannot be verified. Version 2 started 24 minutes before its own initial
commit, but its code matches `b62aed2` byte for byte.

## What remains trusted

- Discovery reads at most 50 active rows per poll. Unsupported assets, duplicate
  market IDs, absent spot or momentum, unreadable on-chain metadata, expired
  rows, one-sided books, missing references and unwarmed measured volatility
  leave no commitment. Each leaves one reason-coded `forecast_skipped` event
  per market and reason; a repeated skip with the same key is deduplicated for
  the life of the ledger, so a long input outage looks like silence in the
  journal, not like a stream of skips
  (`src/live-recorder.ts:180-195,204-285,373-380`, `src/store.ts:242-244`).
- A market absent from discovery leaves no event. Heartbeats show that the
  process wrote recently; their absence does not enumerate the markets missed
  during downtime.
- The spot source, order book, opening reference, indexer, RPC, oracle and chain
  may be wrong or correlated. Sealing their values and runtime versions detects
  later edits, not bad inputs.
- The submitter key and live-ledger host must remain under operator control.
  Compromise lets an attacker create new scoped roots; the audit will show them,
  but cannot label the intent.
- The operator still chooses the production emitter, submitter and block range.
  The verifier cannot audit a scope it was never told to scan.
- Publication depends on the hourly timer, network access and Git credentials.
  The checked-in service raises an alert on failure, but installation and
  response remain operational duties
  (`ops/proof-edge-evidence.service:1-13`,
  `ops/proof-edge-evidence-alert.service:1-8`).
- Legacy roots still depend on the retained local ordering around their batches
  because their emitter events contain no ledger head.

Consequently, an anchored root cannot disappear silently inside the configured
audit period: completeness reports it. A market can disappear before anchoring
because of downtime, the 50-row cap, an input filter, a different
wallet/contract, or a wrongly chosen period. A disclosed observation can be
false without any hash failure. Those are the residual disappearance and
forgery scenarios.

## Reproduce the audit

From a clean clone with public Shannon RPC access:

```bash
npm run check
npm run verify:log
npm run verify:chain
npm run verify:completeness
npm run verify:all
```

`verify:log` checks the JSONL structure and derived scores. `verify:chain`
matches both emitter eras and requires the exact ledger head for forward
batches. `verify:completeness` searches for omitted scoped roots.
`verify:all` checks every resolution-gated evidence file. Operational recovery
and audit-range overrides are documented in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md); the frozen byte formats are in
[`docs/RECORD_FORMAT.md`](docs/RECORD_FORMAT.md).

## Sources

- Canonical bytes and Merkle formats: `src/canonical.ts`, `src/merkle.ts`,
  `docs/RECORD_FORMAT.md`; commit
  `0f0fec7ffcfa816cf1c52635d5b855c108a9f761`.
- Chain and completeness verification: `src/evidence-verifier.ts`,
  `scripts/verify-chain.ts`, `scripts/verify-completeness.ts`,
  `deployments/shannon.json`.
- Ledger-head repair: commits
  `329b2f5b7ae970f7dde46a6025ffa799bdc43b3e` and
  `80d036c3203a43af0f3e8b7bb4ae2e4433d18b61`.
- Retained fork and writer lock: commit
  `4e7cec44891dd0c51ab568c28719e9c27bff1f58`,
  `incidents/2026-08-27/forecast-events.jsonl.corrupted`, `src/store.ts`,
  `test/store.test.ts`, `test/store-lock.test.ts`.
- Publisher and availability decisions: commits
  `e451f60808f4641bedead4da233962a0b08514e7` and
  `939ebb96c41dec5846e540cd0535fea2db4ea3f6`;
  `scripts/publish-and-push.ts`, `ops/`.
