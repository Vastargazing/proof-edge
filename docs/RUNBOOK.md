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
EMITTER_ADDRESS=0x3020c7ea249b6be98d0e9acf911eaeeb766ace4f
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
```

Expected invariant: `failures` is empty. The local verifier checks canonical
commitments, ordered Merkle inclusion, and anchor block time before expiry. The
chain verifier independently fetches the receipt and block and matches emitter
address, root, leaf count, status, block metadata, gas, and `RootAnchored` log.
Both commands verify `published/forecast-events.jsonl` by default. To inspect a
live private ledger, set `RECORDER_STORE=data/forecast-events.jsonl` explicitly.
An anchor mined at or after a leaf expiry is reported as `anchored_late`, remains
visible in the ledger and dashboard, and is excluded from proof and scoring.

To reconcile already-recorded expired markets without loading the wallet and
without submitting a transaction:

```sh
RECORDER_STORE=data/forecast-events.jsonl npm run recorder:reconcile
npm run publish:snapshot
```

Reconcile-only mode reads final market status from Shannon, appends missing
reveals and scores idempotently, then exits. It never evaluates new markets or
anchors a root.

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
