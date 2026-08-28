# Operating ProofEdge

A price-feed connect timeout once killed the recorder. Systemd started it again
eight seconds later; the new process recovered the stale writer lock, reopened
the fsynced ledger and continued collecting. The restart recovered bytes. It did
not prove that new forecasts and anchors were advancing, and that difference
controls every procedure below
(`ops/proof-edge-recorder.service:7-18`,
`939ebb96c41dec5846e540cd0535fea2db4ea3f6`).

Three rules take precedence over every command below:

1. Never run two writers against the same JSONL file.
2. Never edit or truncate the ledger to make a verifier pass.
3. Never refresh an old probability, timestamp or model manifest. Append the
   new fact or keep the failure visible.

The 27 August fork at physical lines 621 and 622 is retained because we followed
those rules after discovering the damage. The reader reports line 621 as the
losing terminal orphan; it does not erase it
(`incidents/2026-08-27/forecast-events.jsonl.corrupted`, SHA-256
`274642299ee63bf97b4b1bb28b181beba8960961afec0af532a5006a3d894475`;
`test/store.test.ts:96-112`).

## Before the first start

Use Node.js 22 or later, initialize the pinned submodule and install from the
lockfile:

```sh
git submodule update --init --recursive
npm ci
npm run check
```

Copy `.env.example` to a file outside the repository and set its mode to `0600`.
It contains the public Shannon RPC, DreamDEX venue, active emitter and frozen
estimator defaults. Add only a dedicated funded Shannon key. The live process
refuses to start without an explicit lowercase `VENUE_ID`, `EMITTER_ADDRESS`
and `PRIVATE_KEY` (`.env.example:1-21`, `src/live-recorder.ts:36-72`). Do not
print the environment file in a ticket, terminal transcript or publication log.

For a foreground check:

```sh
PROOF_EDGE_ENV=/absolute/path/outside/the/repository/proof-edge.env
node --env-file="$PROOF_EDGE_ENV" --import tsx src/live-recorder.ts
```

The checked-in user units under `ops/` are deployment examples, not portable
installers. Before copying them into `~/.config/systemd/user/`, change
`WorkingDirectory` and the `--env-file` argument in the local unit copy. Keep
those machine-specific edits out of Git. Then reload and start the recorder:

```sh
systemctl --user daemon-reload
systemctl --user enable --now proof-edge-recorder.service
systemctl --user status proof-edge-recorder.service
```

The writer creates `<ledger>.writer.lock` atomically. Its owner record contains
the PID, a random token and the Linux process-start token. A live owner blocks a
second writer; a process killed by `SIGKILL` leaves a lock that the next writer
can identify as stale and recover. This depends on Linux `/proc`
(`src/store.ts:83-164`, `test/store-lock.test.ts:10-46`). Do not delete a lock
merely because it exists.

## What healthy means

`systemctl is-active` is one signal, not the health definition. A healthy run
has a live service, recent recorder heartbeats, and forecast and anchor counts
that continue to change when qualifying markets exist. The watchdog samples
those facts every ten minutes. It alerts immediately when the service is down;
if either count is unchanged for two ticks, it alerts on the second tick
(`scripts/watchdog.ts:8-56`, `ops/proof-edge-watchdog.timer:1-8`).

Install the watchdog unit, timer and alert unit beside the recorder, adjust the
same local paths, then enable the timer:

```sh
systemctl --user enable --now proof-edge-watchdog.timer
systemctl --user start proof-edge-watchdog.service
journalctl --user -u proof-edge-watchdog.service -n 20 --no-pager
```

The second check is the published record itself:

```sh
npm run verify:log
npm run verify:chain
npm run verify:completeness
npm run verify:all
```

`verify:log` validates the JSONL hashes, canonical commitments, derived risk
decisions and scores. `verify:chain` matches anchored batches to receipts and
both emitter event formats. `verify:completeness` scans the declared production
scope for roots omitted from the published ledger. `verify:all` checks every
resolution-gated evidence file. These commands read
`published/forecast-events.jsonl` by default; point `RECORDER_STORE` at the
private ledger only for deliberate local diagnosis
(`package.json:22-26`, `scripts/verify-log.ts:5`,
`scripts/verify-chain.ts:11`, `scripts/verify-completeness.ts:63`,
`scripts/verify-evidence.ts:135`).

An orphan is an incident even when `verify:log` can select one continued chain.
An invalid `event_hash`, a partial final line or a fork with descendants on both
sides is a hard failure (`src/store.ts:166-211,259-318`).

## Diagnose by symptom

### The recorder is down or restarting

Start with the unit and the last journal entries:

```sh
systemctl --user status proof-edge-recorder.service
journalctl --user -u proof-edge-recorder.service -n 100 --no-pager
```

The unit restarts a failed process after eight seconds and sends the stop result
to the alert helper (`ops/proof-edge-recorder.service:7-18`,
`ops/proof-edge-recorder-stop-alert.mjs:3-15`). Confirm that the next process
opened the store and resumed heartbeats. Do not treat a new PID as proof that
forecasting resumed.

During the collection window we left an isolated feed timeout fail-fast because
changing forecast-affecting code would have produced a new `model_hash`. That
choice ceases to apply if the journal shows repeated feed failures: repeated
restarts turn an estimated one-or-two-window loss into an availability fault
(`THREAT_MODEL.md:217-226`). Preserve the journal and record the resulting gap;
never backfill the missed markets.

### Forecasts stop advancing

If the service is active but the forecast count is flat, inspect the skip and
heartbeat events before touching configuration. Discovery reads at most 50
active rows. Unsupported assets, duplicate IDs, missing or stale spot,
unavailable momentum, unreadable on-chain metadata, expiry, a one-sided book,
missing opening reference and unwarmed measured volatility all produce skips
instead of commitments (`src/live-recorder.ts:180-285,373-380`).

A heartbeat proves that the process appended recently. It does not enumerate
markets that discovery failed to return. If a filter is behaving as configured,
leave the gap visible. Changing an estimator setting rotates `model_hash`; it is
not an incident repair that can be applied to old observations.

### Forecasts advance but anchors do not

Search the recorder journal for `anchor_failed`, `outstanding`,
`balance_check_failed` and `low_balance`. Submission failures do not stop market
observation. The coordinator retries from 5 seconds with exponential backoff,
capped at 5 minutes, and submits fsynced prepared batches before a new pending
batch after restart (`src/anchor-coordinator.ts:49-105`,
`src/live-recorder.ts:50-54`).

Do not rebuild a prepared batch or split its leaves. Restore RPC access or fund
the dedicated Shannon wallet, then let the existing batch retry. If the root is
mined at or after any leaf's expiry, the ledger records `anchored_late`; the
forecast stays public and never enters proof or scoring
(`src/store.ts:246-253,580-595`).

Batch contents are not an operator tuning knob. `preparePendingBatch` takes all
currently unbatched forecasts of the oldest pending canonical version; v1 and
v2 never share a tree (`src/recorder.ts:42-56`). Once `batch_prepared` is
fsynced, do not delay, repack or split it to save gas. The ten-transaction
Shannon comparison in [`GAS_BUDGET.md`](GAS_BUDGET.md) is the retained
historical benchmark, not permission to push a root past a leaf's expiry.

### The ledger reports an orphan or refuses to open

Stop the writer, preserve the exact bytes and hash the copy before analysis:

```sh
systemctl --user stop proof-edge-recorder.service
sha256sum data/forecast-events.jsonl
npm run verify:log
```

Do not remove the losing line, manufacture a new `prev_event_hash`, or delete a
lock owned by a live process. A sole continued branch can be read while the
terminal sibling remains reported. Any ambiguous continued fork stays closed.
The retained 27 August byte image and its regression tests are the reference for
that behavior (`src/store.ts:166-211`, `test/store.test.ts:47-112`).

## Reconcile without a wallet

Reconcile-only mode reads final DreamDEX state, appends missing risk decisions,
reveals and scores idempotently, and exits. It does not discover markets or send
an anchor transaction (`src/live-recorder.ts:56-61,133,348-354`). Because it is
still a writer, stop the live service first:

```sh
systemctl --user stop proof-edge-recorder.service
RECORDER_STORE=data/forecast-events.jsonl npm run recorder:reconcile
systemctl --user start proof-edge-recorder.service
```

Do not run reconciliation beside the recorder. The writer lock should refuse
the second process, but the operational rule is to avoid creating that race.
Run the public exporters only after reconciliation has closed the store:

```sh
npm run publish:evidence
npm run publish:snapshot
```

## Publication failures

`proof-edge-evidence.timer` starts the publisher hourly with up to 60 seconds of
random delay (`ops/proof-edge-evidence.timer:1-9`). `publish:auto` requires a
clean dedicated checkout, rebases on `origin/main`, captures a Shannon block
watermark, exports evidence and the snapshot, and runs the full test and audit
path. It stages only the public ledger, dashboard data and `evidence/`, pushes
without force, retries one ordinary fetch/rebase/push race, and scans
completeness again after the push (`scripts/publish-and-push.ts:44-101`,
`src/publisher.ts:3-36`).

When the timer fails, inspect the publisher journal:

```sh
systemctl --user status proof-edge-evidence.service
journalctl --user -u proof-edge-evidence.service -n 100 --no-pager
git status --short
```

A dirty publisher checkout is a refusal, not something to stash automatically.
Do not force-push and do not add unrelated paths to the publication commit.
Resolve the checkout or network failure, then start the oneshot again. The live
private ledger may lead the repository by roughly one timer interval; the
publication watermark prevents roots mined after its captured block from being
misreported as missing.

Evidence pruning is non-destructive. Invalid JSON, a failed canonical preimage
or a failed Merkle proof moves the original bytes under `evidence/_rejected/`
with a `reason.json`; locally valid stale files are kept for review, and an
existing quarantine entry is not overwritten (`test/evidence.test.ts:111-171`).

## Completeness scope

The default legacy-emitter scan starts at block `471035786`. The closed range
`471035563..471035785` contains ten synthetic gas-benchmark roots with leaf
counts 1 through 10 and no forecast preimages. Inspecting that range is expected
to report those roots as undisclosed:

```sh
COMPLETENESS_FROM_BLOCK=471035563 npm run verify:completeness
```

The ledger-head emitter is scanned from its deployment block `471812148`.
`SUBMITTER_ADDRESS`, `EMITTER_ADDRESSES`, `COMPLETENESS_TO_BLOCK`,
`COMPLETENESS_BLOCK_CHUNK` and `COMPLETENESS_RPC_CONCURRENCY` override the
defaults. Chunk size is limited to 1,000 blocks; concurrency must be between 1
and 50 (`scripts/verify-completeness.ts:27-50`). Every override changes the
audit scope. Record it with the result rather than presenting a narrower scan as
the default production audit.

## The emitter migration is complete

The active emitter is `0xf700bde4cbe7000a4ce075ea093e6a835974b95f`.
It was deployed in transaction `0x0c246c…a1e0` at block `471812148`; the first
`RootAnchoredWithLedgerHead` root was mined at block `471834978`. The legacy
emitter `0x3020…e4f` remains part of verification through block `471834977`, but
it is inactive and its root-only history cannot be retrofitted
(`deployments/shannon.json:13-37`).

Do not repeat the old activation checklist. A future emitter replacement is a
new migration: record its address, deployment transaction and first scan block;
update the protected recorder environment and public deployment metadata; run
the ABI and test checks; restart the recorder once; and confirm the first event
before changing the completeness periods. Pointing current code at the legacy
emitter makes `anchorRootWithLedgerHead` fail and retry rather than silently
downgrading the proof (`contracts/ForecastRootEmitter.sol:11-30`).

## Before publishing forensic bytes

The retained incident ledger contains complete preimages and nonces. Before
committing any new forensic ledger image, enumerate every physical
`forecast_observed`, including orphan branches, and check each market on Shannon
for a resolved or void outcome. Do not infer safety from local reveal events.
If even one market is unresolved, keep the byte image private: publication would
reveal that forecast before its answer.

The operational boundary remains narrower than the cryptographic one. The
watchdog does not prove uptime. A successful hash does not prove a price feed.
The completeness command cannot find roots outside the emitter, submitter and
block range it was given. Preserve those absences in the incident record instead
of repairing them into a cleaner history. The byte formats are frozen in
[`RECORD_FORMAT.md`](RECORD_FORMAT.md); the exact residual trust assumptions are
listed in [`../THREAT_MODEL.md`](../THREAT_MODEL.md).
