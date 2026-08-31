# Operating ProofEdge

A price-feed connect timeout once killed the recorder. Systemd started it again
eight seconds later; the new process recovered the stale writer lock, reopened
the fsynced ledger and continued collecting. The restart recovered bytes. It did
not prove that new forecasts and anchors were advancing, and that difference
controls every procedure below
(`ops/proof-edge-recorder.service:7-20`,
`939ebb96c41dec5846e540cd0535fea2db4ea3f6`).

Three rules take precedence over every command below:

1. Never run two writers against the same JSONL file.
2. Never edit or truncate the ledger to make a verifier pass.
3. Never refresh an old probability, timestamp or model manifest. Append the
   new fact or keep the failure visible.

## The first 60 seconds

Run these five commands in order. Do not restart the service or remove the lock
between them; the first pass is evidence collection.

```sh
systemctl --user status proof-edge-recorder.service --no-pager
journalctl --user -u proof-edge-recorder.service -n 100 --no-pager
ps -eo pid,ppid,lstart,args | rg '[s]rc/live-recorder\.ts'
lsof -- data/forecast-events.jsonl data/forecast-events.jsonl.writer.lock
RECORDER_STORE=data/forecast-events.jsonl npm run verify:log
```

Compare the `ps` rows with the service's main PID. A second
`src/live-recorder.ts` row, with or without `--reconcile`, is already an
incident. If the sidecar exists, read its single owner record with
`sed -n '1p' data/forecast-events.jsonl.writer.lock` and match its `pid` to the
same list. If `lsof` is unavailable, use
`fuser -v data/forecast-events.jsonl`. An empty `lsof` or `fuser` result does not
overrule `ps` or the PID recorded in the writer lock: the store opens the ledger
for one append and fsync, then closes it
(`src/store.ts:505-522`). After these five commands, continue with the matching
symptom below.

## Stop if the state is unclear

When the output does not fit one symptom, preserve first. Stop the systemd
writer, then repeat the process and file-owner checks:

```sh
systemctl --user stop proof-edge-recorder.service
ps -eo pid,ppid,lstart,args | rg '[s]rc/live-recorder\.ts'
lsof -- data/forecast-events.jsonl data/forecast-events.jsonl.writer.lock
```

If either check still shows a process, record its full command and start time,
then stop that process deliberately. Do not copy the ledger while an identified
writer is still running. Once both checks are clear, make a non-overwriting copy
outside the repository and hash both paths:

```sh
INCIDENT_COPY=/absolute/path/outside/the/repository/forecast-events.jsonl.incident
cp --no-clobber --preserve=all data/forecast-events.jsonl "$INCIDENT_COPY"
sha256sum data/forecast-events.jsonl "$INCIDENT_COPY"
```

Keep the original bytes even if `verify:log` fails. The repository proves that
the 27 August file forked; it does not prove which process-level action started
the second writer
([threat model § the hash chain forked](../THREAT_MODEL.md#the-hash-chain-forked)).

The retained 27 August bytes fork at physical lines 621 and 622. The reader
reports line 621 as the losing terminal orphan; it does not erase it
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

During a fixed collection window, run the recorder from a dedicated detached
worktree. The current manifest inventories all of `src/`, including operational
files such as `src/publisher.ts`; letting the hourly publisher update the
recorder checkout would therefore rotate `model_hash` on the next restart even
when the estimator did not change. The publisher must use a different checkout.

Before the first start, compute the planned hash from the exact recorder
worktree and environment:

```sh
node --env-file=/absolute/path/proof-edge.env --import tsx \
  scripts/check-recorder-model.ts --print
```

Copy the reported value into `EXPECTED_MODEL_HASH` in the local recorder unit,
then run the same command without `--print`. It must return `MODEL_HASH_OK`.
The checked-in unit shows the current Shannon v7 pin and runs this check as
`ExecStartPre`; a mismatch refuses startup before the ledger is opened. Change
the worktree pin and expected hash only as one deliberate model-version change.

The check is fail-closed on purpose. If anything in the inventory drifts, the
unit does not start at all and collection stops until a person intervenes; we
chose a visible outage over a silent eighth `model_hash`. That makes the
watchdog the safety net for this decision: an inactive recorder unit raises
its alert on the next tick. When `ExecStartPre` fails, the repair is to
restore the clone to its pinned state (see the frozen inputs below), never to
edit `EXPECTED_MODEL_HASH` or remove the check to get the service running.

### Frozen until 2026-09-08

The running recorder is pinned to commit `9756f2c` in the dedicated clone. Its
`model_hash` is
`0x253a60a726a063c0e14acd10d7a206a0b82308a8bc703ced5304c79a1dd16417`. Until
the collection window closes on 2026-09-08, everything below is sealed into
that hash and must not change in the recorder's working directory:

- the 35 inventoried files, byte for byte: `package.json`, `package-lock.json`,
  every file under `src/`, every file under
  `vendor/dreamdex-bot-kit/packages/ec-core/`, and
  `vendor/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.ts`. The
  inventory walks directories, so a new, renamed or deleted file inside `src/`
  or `ec-core/` changes the hash; an editor swap file or a stray build output
  is enough;
- the submodule pin `dccd2fdbf5e59316a5e9209546707b91b5f4cd7d` and the
  installed `@somnia-chain/markets-sdk` `0.28.1`;
- the Node.js binary, `v22.22.1`: the Node, V8, modules, OpenSSL and libuv
  versions are part of the manifest;
- the estimator environment: every `OF_*` variable, `RECORDER_POLL_MS`,
  `VENUE_ID`, `NETWORK`, and the data-source settings `RPC_URL`, `WS_RPC_URL`,
  `INDEXER_URL`, `PRICE_FEED_URL`, `PRICE_FEED_QUOTE` plus any contract-address
  override.

In the dedicated recorder clone this means: no `npm ci`, `npm install` or
`npm update`; no `git pull`, `git checkout` or rebase; no editor sessions; no
system Node.js upgrade. Confirm the clone before any restart:

```sh
git -C /path/to/recorder-clone status --porcelain --untracked-files=all -- \
  src vendor/dreamdex-bot-kit/packages/ec-core \
  vendor/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.ts \
  package.json package-lock.json
```

The output must be empty. Values that can change without touching the hash:
`EMITTER_ADDRESS`, `PRIVATE_KEY`, `RECORDER_STORE`, `ANCHOR_RETRY_BASE_MS`,
`ANCHOR_RETRY_MAX_MS`, `RECORDER_HEARTBEAT_MS`, `RECORDER_BALANCE_CHECK_MS`,
`RECORDER_LOW_BALANCE_STT`, and every path outside the inventory (`scripts/`,
`test/`, `docs/`, `ops/`, `dashboard/`, `contracts/`, `tsconfig.json`).

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
if either count is unchanged for `WATCHDOG_STALE_TICKS` ticks, it alerts on
that tick. Two ticks were enough while the five-minute series ran; since
DreamDEX moved to hourly windows on 28 August the host unit uses seven, so a
whole hour without a window is the alarm, not the gap between windows
(`scripts/watchdog.ts`, `ops/proof-edge-watchdog.service`,
`ops/proof-edge-watchdog.timer:1-8`).

A fail-fast recorder on an unreliable uplink is not the same as a recorder that
is down. Each tick reads `ActiveState` and `SubState` and reports them as
`unit_state`, with the unit's cumulative `unit_restarts`. A unit systemd is
actively restarting (`activating`, or `auto-restart`) counts as running while
the heartbeat is younger than `WATCHDOG_HEARTBEAT_STALE_MS`, so a tick that
lands in the few seconds between a crash and its restart no longer raises
`recorder_service_down`. A restart loop that outlives that threshold, and any
unit that is `failed` or `inactive`, is still reported as down on the first
tick that sees it. Watch `unit_restarts` rather than the alert to judge how
badly the uplink is flapping; on 29 August it grew by roughly twenty per hour
while the recorder kept writing.

Each tick also reports two ages read from the ledger, `heartbeat_age_s` and
`last_spot_age_s`, and classifies a quiet recorder by them. A live unit whose
heartbeat is older than `WATCHDOG_HEARTBEAT_STALE_MS` (fifteen minutes) is
`recorder_stalled`: the poll loop stopped. A fresh heartbeat with a spot older
than `WATCHDOG_SPOT_STALE_MS` is `inputs_stale`: the upstream feed stopped, and
a restart cannot help. Only `recorder_stalled` triggers an automatic restart.
The watchdog runs `systemctl --user restart proof-edge-recorder.service`, so
the hash check in `ExecStartPre` still applies and a drifted tree stays down.
It attempts at most `WATCHDOG_MAX_AUTO_RESTARTS` (two) restarts per episode,
waits `WATCHDOG_RESTART_GRACE_TICKS` (three ticks) between them, writes every
attempt to the journal as `WATCHDOG_RESTART`, and still exits non-zero so the
alert unit fires; an automatic restart is never silent. The episode and its
budget end when a tick sees new forecasts. To reset the budget by hand after an
operator repair, remove `~/.local/state/proof-edge/watchdog.json`; the
counters rebuild on the next tick.

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

The unit restarts a failed process after four seconds and sends the stop result
to the alert helper (`ops/proof-edge-recorder.service:7-20`,
`ops/proof-edge-recorder-stop-alert.mjs`). The delay was eight seconds until
29 August; it was halved when the operator's VPN client started producing
around twenty connect timeouts per hour, because each gap is lost observation
time. Confirm that the next process
opened the store and resumed heartbeats. The helper always writes the journal
alert; its desktop popup is optional and can be switched off with
`PROOF_EDGE_DESKTOP_NOTIFY=0` in a local unit drop-in when a flapping uplink
turns every fail-fast restart into a critical notification (on 29 August the
counter passed 160 restarts in a day, most of them in the six hours after
the operator changed VPN clients — `incidents/2026-08-29/README.md`). Keep
the journal alert; it is what the watchdog and the incident record rely on. Do not treat a new PID as proof that
forecasting resumed.

During the collection window we left an isolated feed timeout fail-fast because
changing forecast-affecting code would have produced a new `model_hash`. That
choice ceases to apply if the journal shows repeated feed failures: repeated
restarts turn an estimated one-or-two-window loss into an availability fault
([threat model § restart was not the same as liveness](../THREAT_MODEL.md#restart-was-not-the-same-as-liveness)).
Preserve the journal and record the resulting gap;
never backfill the missed markets.

### The recorder refuses to start with `MODEL_HASH_MISMATCH`

`ExecStartPre` found that the recorder clone no longer hashes to
`EXPECTED_MODEL_HASH`. The journal line names the actual aggregate and whether
the tree was dirty. Do not bypass the check and do not change the expected
hash. Instead, in the recorder clone:

```sh
git status --porcelain --untracked-files=all -- src \
  vendor/dreamdex-bot-kit/packages/ec-core \
  vendor/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.ts \
  package.json package-lock.json
git rev-parse HEAD                              # must print the pinned commit
git -C vendor/dreamdex-bot-kit rev-parse HEAD   # must print the pinned upstream
node --version                                  # must match the manifest
```

Remove stray files reported by the first command, return the clone to the
pinned commit with `git checkout --detach <pin>` if `HEAD` moved, and re-run
`scripts/check-recorder-model.ts` without `--print` until it prints
`MODEL_HASH_OK`. A changed Node.js or SDK version cannot be repaired in place;
it is a deliberate model-version change and must be recorded as one.

### Forecasts stop advancing

If the service is active but the forecast count is flat, inspect the skip and
heartbeat events before touching configuration. Discovery reads at most 50
active rows. Unsupported assets, duplicate IDs, missing or stale spot,
unavailable momentum, unreadable on-chain metadata, expiry, a one-sided book,
missing opening reference and unwarmed measured volatility all leave one
reason-coded skip event per market and reason instead of a commitment. The
same market skipped again for the same reason writes nothing more, even after
a restart, so the journal cannot tell "nothing qualifies" from "nothing has
happened for an hour"; that is what the watchdog's counters and ages are for
(`src/live-recorder.ts:180-285,373-380`, `src/store.ts:242-244`).

A heartbeat proves that the process appended recently. It does not enumerate
markets that discovery failed to return. If a filter is behaving as configured,
leave the gap visible. Changing an estimator setting rotates `model_hash`; it is
not an incident repair that can be applied to old observations.

The 28 August signature is heartbeats every minute, no new `spot_observed`
event, one `momentum_unavailable` skip per market and then silence, because
repeated skips are deduplicated. The watchdog reports it as `inputs_stale`.
Confirm the feed directly (`fetchPrice` through the SDK returns the oracle
timestamp; compare it with the clock) and read the last spot age from the tick.
Do not restart the recorder for this; it re-fetches the same frozen sample.
Wait for the feed, then let measured volatility warm up again. Record the gap
in the incident log (`incidents/2026-08-28/README.md`).

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
the second process, but the operational rule is to avoid creating that race. A
manual `recorder:reconcile` is still a writer, which is why the first-minute
`ps` command searches for both modes. We did not establish which process caused
the retained fork.
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
path. After the completeness watermark it regenerates the statistics blocks in
`README.md` from the exported dashboard data. It stages only the public ledger,
dashboard data, `evidence/` and that README, pushes without force, retries one
ordinary fetch/rebase/push race, and scans completeness again after the push
(`scripts/publish-and-push.ts`, `src/publisher.ts:3-36`).

The steps that reach Shannon or GitHub — the `git fetch`, the watermark block
read, `verify:chain` and both `verify:completeness` scans — retry
`PUBLISH_RETRY_ATTEMPTS` times (three) with `PUBLISH_RETRY_DELAY_MS` (fifteen
seconds) between attempts, logging each failed attempt. They are read-only
scans or idempotent rewrites of generated files, so a repeat cannot publish
twice. The local steps — the exporters, `npm run check`, `verify:log` — still
fail on the first error, and a genuine verification failure still fails the
run after its attempts are spent. The retry buys back hours lost to a single
connect timeout; it does not make a broken uplink safe to ignore.

A change to the publisher itself lands one run later than it looks. The
service loads `scripts/publish-and-push.ts`, and the `src/publisher.ts` it
imports, before that script rebases its own checkout onto `origin/main`. A fix
to either file pushed at hour H is therefore fetched during the H+1 run but
first executes at H+2. The npm scripts it spawns (`publish:evidence`,
`publish:snapshot`, `verify:*`, `render-readme-stats.ts`) are read from disk
after the rebase and apply at H+1. A failed H+1 run after a publisher push is
expected in that window; it is not a reason to edit the live checkout. To
apply a publisher fix immediately, fast-forward the dedicated checkout and
start the oneshot by hand:

```sh
git -C /path/to/publisher-checkout pull --ff-only origin main
systemctl --user start proof-edge-evidence.service
```

When the timer fails, inspect the publisher journal:

```sh
systemctl --user status proof-edge-evidence.service
journalctl --user -u proof-edge-evidence.service -n 100 --no-pager
git status --short
```

A push that cannot reach GitHub is the one failure that leaves work behind:
the snapshot is already committed locally, so the checkout ends one commit
ahead of `origin/main`. That is intended. The next hourly run finds a clean
checkout, rebases the commit onto `origin/main`, publishes again and pushes
both. Do not reset, amend or force anything; to restore the public snapshot
sooner, push it by hand between runs (2026-08-31, a four-minute GitHub outage
at 11:05):

```sh
git -C /path/to/publisher-checkout fetch origin
git -C /path/to/publisher-checkout rebase origin/main
git -C /path/to/publisher-checkout push origin HEAD:main
```

A dirty publisher checkout is a refusal, not something to stash automatically.
Do not force-push and do not add unrelated paths to the publication commit.
Resolve the checkout or network failure, then start the oneshot again. The live
private ledger may lead the repository by roughly one timer interval; the
publication watermark prevents roots mined after its captured block from being
misreported as missing.

### `publisher checkout is dirty before sync: published/forecast-events.jsonl.writer.lock`

One failure mode is the publisher locking itself out. A run that dies after
`publish:snapshot` — an RPC timeout inside `verify:completeness` is enough —
leaves the published copy's writer lock on disk. That file is untracked and is
not a publication path, so the failure handler does not remove it, and every
later run then refuses to start on a dirty checkout. On 2026-08-29 this turned
two network timeouts into four lost publication hours; the recorder kept
writing throughout, so nothing was lost but freshness
(`incidents/2026-08-29/README.md`).

Since 2026-08-29 the publisher sweeps such a lock itself: at the start of a run
it deletes any `*.writer.lock` in the checkout whose recorded pid is no longer
running and logs the removal, while a lock held by a live process still counts
as dirt (`scripts/publish-and-push.ts`). To clear one by hand, confirm the
writer is gone before deleting the file:

```sh
cat /path/to/publisher-checkout/published/forecast-events.jsonl.writer.lock
ps -p <pid>                      # no output: the writer exited
rm /path/to/publisher-checkout/published/forecast-events.jsonl.writer.lock
```

Never delete the live store's lock (`data/forecast-events.jsonl.writer.lock`)
while the recorder unit is active — that one is held by the running recorder
and is filtered from the dirty check by `publisherWriterLockPath()`.

### `root anchored multiple times`

The completeness scan found the same root in two transactions from the declared
submitter. The usual cause is a lost receipt: the anchoring transaction landed,
the recorder did not see it, and after a crash the recovery path resubmitted
the fsynced batch under the next nonce. Establish that before anything else:

```sh
cast tx <first-tx> nonce from status      # or the block explorer
cast tx <second-tx> nonce from status
rg '"root": "<root>"' data/forecast-events.jsonl   # one prepared, one anchored
```

Both transactions must come from the declared submitter, both must succeed,
the leaf counts must agree, and the ledger's `batch_anchored` for that root
must name one of them. When all of that holds, the run accepts the duplicate,
lists it under `accepted_duplicate_anchors`, and publishes it in the dashboard
data; nothing needs to be done except recording the episode. When any part
fails, the run stops and the finding is a real one: a root anchored by our
wallet that the ledger does not disclose is the case this scan exists for.

`COMPLETENESS_STRICT_DUPLICATES=1` restores the original gate, in which every
duplicate fails. Use it when auditing, and expect the publisher to fail while
it is set (`scripts/completeness-policy.ts`,
[threat model § the same root was anchored twice](../THREAT_MODEL.md#the-same-root-was-anchored-twice)).

Evidence pruning is non-destructive. Invalid JSON, a failed canonical preimage
or a failed Merkle proof moves the original bytes under `evidence/_rejected/`
with a `reason.json`; locally valid stale files are kept for review, and an
existing quarantine entry is not overwritten (`test/evidence.test.ts:114-177`).

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

## Rescore against another baseline

Every published score compares the sealed model probability against `p_market`,
the midpoint of the YES book's best bid and ask. That baseline is checkable
rather than convenient: each evidence file seals the whole book snapshot in
`evidence.yes_book`, three levels of bids and asks with sizes, and the
`p_market` it produced is inside the keccak commitment
(`src/live-recorder.ts:226,247,262-263`, [`RECORD_FORMAT.md`](RECORD_FORMAT.md)
sections 1 and 2). The same unforgeable bytes can therefore be scored against a
different baseline:

```sh
npx tsx scripts/rescore-baseline.ts --baseline=midpoint
npx tsx scripts/rescore-baseline.ts --baseline=depth_weighted
npx tsx scripts/rescore-baseline.ts --baseline=min_size --min-size=200
```

Run it as written. An npm alias would change `package.json`, which is
inventoried into `model_hash` (see the frozen inputs above); `rescore:baseline`
will be added after the collection window closes on 2026-09-08. The command is
read-only: it reads `evidence/` (`--dir` points elsewhere), loads no key and
makes no RPC call. `--baseline=all` prints all three rows, `--json` prints the
result objects, `--published` points the reconciliation below at another
snapshot.

| Baseline | Formula over the sealed `yes_book` |
| --- | --- |
| `midpoint` | `(best_bid + best_ask) / 2` |
| `depth_weighted` | `bid_vwap = sum(price_i × size_i) / sum(size_i)` over every disclosed bid level, the same for asks, then `(bid_vwap + ask_vwap) / 2` |
| `min_size` | `(best_bid + best_ask) / 2` over the best level per side whose size is at least `--min-size` |

Each result is put back on the frozen 1e-4 grid before scoring, exactly as the
recorder did (`src/canonical.ts:140-143`, `src/live-recorder.ts:247`), then
aggregated by the published estimator with its bootstrap interval
(`src/scoring.ts:76-160`). Windows are selected by the published rule: an
on-time anchor and a YES/NO outcome (`src/scoring.ts:189-193`).

`depth_weighted` weights inside each side and never across the spread; the
sealed baseline averages the two sides evenly, so weighting them against each
other would move two questions at once. A side with zero total size prices
nothing. `min_size` demotes an undersized quote to the next qualifying level,
and a side with no qualifying level removes the record from the sample instead
of falling back to the quote the threshold excluded. Both cases are reported as
`skipped_by_baseline`, never as a smaller `N` with no explanation.

The `--min-size` default of 200 comes from the disclosed sizes. Measured over
the archive as it stood on 2026-08-31, 3,828 of 3,926 best-level quotes were
exactly 200 and none was larger: the venue quotes a 200/330/460 ladder, and the
remaining 98 top-level quotes are remnants of the 200 rung (1 to 6, or 100 to
199.999). 200 is therefore the largest threshold that still admits a fully
quoted top of book, and it demotes only the remnants. At 201 the top rung is
evicted from every book that still has both sides, which measures the ladder
rather than the market. Re-measure before changing the default; the counts move
with every hour of collection, the ladder does not.

### What a midpoint divergence would mean

`midpoint` is not a new baseline. It is the sealed one, recomputed with the
recorder's own `marketImpliedUp` over the disclosed book
(`vendor/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.ts:311-317`).
The run therefore checks every record, whichever baseline was requested, and
stops on the first file whose recomputed midpoint is not bit-for-bit the
`p_market` inside that record's commitment.

A divergence is not a rounding nuisance. It means the disclosed order book and
the disclosed probability no longer describe the same observation, so one of
them is wrong and every published Brier and skill figure rests on the second.
Treat it as an incident: preserve the named file, record it, and do not loosen
the comparison or re-round either side to make the run pass. Every run since
2026-08-31 has passed on every record it read.

The run also reconciles its `N` against `dashboard/app/forecast-data.json`, key
`resolve_score.all_evaluated_windows.n`, and prints the gap. The archive grows
every hour, so read the gap and not the totals: the expected gap is exactly six
windows, the first smoke batch, whose commitments verify but whose evidence
bodies were never retained, so they disclose no order book to rescore
(`deployments/shannon.json:39-43`, [`RECORD_FORMAT.md`](RECORD_FORMAT.md)
section 6). Any larger gap is a finding, not a rounding difference.

## The emitter migration is complete

The active emitter is `0xf700bde4cbe7000a4ce075ea093e6a835974b95f`.
It was deployed in transaction `0x0c246c…a1e0` at block `471812148`; the first
`RootAnchoredWithLedgerHead` root was mined at block `471834978`. The legacy
emitter `0x3020c7ea249b6be98d0e9acf911eaeeb766ace4f` remains part of verification
through block `471834977`, but it is inactive and its root-only history cannot
be retrofitted
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
