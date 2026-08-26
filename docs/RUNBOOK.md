# Recorder runbook

## Required secrets and addresses

Keep `PRIVATE_KEY` outside the repository. On this workstation the dedicated
Shannon wallet environment is stored at `~/.config/proof-edge/wallet.env` with
mode `0600`. The temporary spike checkout also contains key material and must
never be published.

Required environment:

```text
PRIVATE_KEY=0x…
VENUE_ID=0x…
EMITTER_ADDRESS=0xf700bde4cbe7000a4ce075ea093e6a835974b95f
```

Copy the non-secret defaults from `.env.example`. Run continuously with:

```sh
node --env-file=/secure/path/recorder.env --import tsx src/live-recorder.ts
```

The process handles SIGINT/SIGTERM, fsyncs every event, reconstructs all indices
on startup, recovers unanchored prepared batches, fills missing risk/reveal/score
stages, and never evaluates one `market_id` twice.

Anchor submission failures do not terminate the observation loop. The recorder
retries with exponential backoff from 5 seconds to 5 minutes and continues
preparing new batches. On restart, every fsynced prepared-but-unanchored batch is
submitted before a new pending batch. A SIGKILL can interrupt the current
in-memory poll, but cannot orphan a batch already recorded as `batch_prepared`.

On this workstation it is installed as the user service
`proof-edge-recorder.service`. Its wallet environment is mode `0600` under the
user config directory and is not part of the repository.

## Health checks

```sh
npm run check
npm run verify:log
npm run verify:chain
npm run verify:completeness
npm run verify:all
```

Expected invariant: `failures` is empty and completeness reports zero
undisclosed production roots. The local verifier checks canonical
commitments, ordered Merkle inclusion, and anchor block time before expiry. The
chain verifier independently fetches the receipt and block and matches emitter
address, root, leaf count, status, block metadata, gas, and `RootAnchored` log.
Both commands verify `published/forecast-events.jsonl` by default. To inspect a
live private ledger, set `RECORDER_STORE=data/forecast-events.jsonl` explicitly.
An anchor mined at or after a leaf expiry is reported as `anchored_late`, remains
visible in the ledger and dashboard, and is excluded from proof and scoring.

To reconcile already-recorded expired markets without loading the wallet and
without submitting a transaction, first stop the live recorder deliberately;
two processes must never append to the JSONL file concurrently:

```sh
RECORDER_STORE=data/forecast-events.jsonl npm run recorder:reconcile
npm run publish:evidence
npm run publish:snapshot
```

Reconcile-only mode reads final market status from Shannon, appends missing
reveals and scores idempotently, then exits. It never evaluates new markets or
anchors a root.

`proof-edge-evidence.timer` runs the evidence and snapshot exporters once per
hour. The live recorder performs reconciliation in its normal loop; the timer is
read-only with respect to the live ledger and runs `publish:auto`. That command
requires a clean dedicated checkout, fetches and rebases on `origin/main`, runs
both exporters and the full test suite, stages only `published/`, dashboard data,
and `evidence/`, then commits and pushes without force. A rejected push gets one
ordinary fetch/rebase/push retry. The snapshot is atomically validated even when
outcomes remain pending; the pending count appears on the dashboard. The
evidence exporter writes only forecasts that already have a reveal and an
anchor and retain the full observation body. Unresolved preimages and legacy
smoke commitments without complete evidence are skipped. Install the units
from `ops/` only after the forward-emitter migration below, configure normal
GitHub push credentials for that dedicated checkout, then enable the timer with
`systemctl --user enable --now proof-edge-evidence.timer`.
Evidence pruning is fail-closed and non-destructive. Invalid JSON, a failed
canonical preimage, or a failed Merkle proof moves the original bytes under
`evidence/_rejected/` with a `reason.json` sidecar. Locally verifiable stale
files are kept for manual review, and existing quarantine entries are never
overwritten. Every `QUARANTINE` and `KEEP` decision includes a reason in the job
log.

## Batch policy

The current implementation anchors all newly observed markets discovered in a
poll as one root. For 15-minute scheduled operation, run one persistent process
and add a timer boundary only after venue cadence is confirmed; do not split an
already prepared batch. Event-only anchoring costs `0.000335628 STT` per root at
the measured Shannon gas price.

## Incident policy

- Do not edit or truncate `data/forecast-events.jsonl`.
- A partial final line is a hard failure; preserve the file for forensic repair.
- Never backfill missed forecasts or refresh `p_market` after observation.
- A model/config change creates a new `model_hash`; old records stay immutable.
- A risk-config change creates a new decision under a new `risk_config_hash`.
- A void market is revealed but excluded from Brier scoring.
- A late anchor is never relabelled on-time or scored; investigate the RPC
  outage and report the explicit `anchored_late` count.
- Refresh the published snapshot deliberately; never expose the wallet env.

## Completeness period

The default completeness period begins at block `471035786`. Blocks
`471035563..471035785` are excluded as a closed synthetic emitter benchmark:
ten roots from the deployment wallet with leaf counts 1 through 10. To inspect
them, set `COMPLETENESS_FROM_BLOCK=471035563`; they will correctly appear as
undisclosed because no forecast preimages were created for that benchmark.
By default the command scans the legacy emitter from block `471035786` and the
ledger-head emitter from its deployment block `471812148`. `SUBMITTER_ADDRESS`,
`EMITTER_ADDRESSES`, `COMPLETENESS_TO_BLOCK`, the RPC-safe chunk size (maximum
1000), and scan concurrency are configurable.

## Forward ledger-head migration

Emitter `0xf700bde4cbe7000a4ce075ea093e6a835974b95f` was deployed in
transaction `0x0c246c…a1e0` at block `471812148` and supports
`anchorRootWithLedgerHead`. New
`batch_prepared` events bind the preceding JSONL `event_hash`, and `verify:chain`
requires that exact value in the on-chain event. The active legacy emitter at
`0x3020…e4f` does not expose this method; existing anchors remain valid root-only
history and are not retrofitted.

Activation order is strict:

1. deploy the updated `ForecastRootEmitter` and record its address, deployment
   transaction, and starting block (complete);
2. update `EMITTER_ADDRESS` in the protected recorder environment and in public
   defaults/deployment metadata;
3. run build/tests and a read-only contract call/ABI check;
4. obtain explicit approval for the one recorder restart, then restart once;
5. confirm the first new transaction emitted `RootAnchoredWithLedgerHead`, run
   `verify:chain`, publish the snapshot, and set the completeness period for the
   new emitter.

Do not restart against the old emitter after this code is installed: new batches
will call the new method and anchoring will safely fail/retry until the address is
correct.
