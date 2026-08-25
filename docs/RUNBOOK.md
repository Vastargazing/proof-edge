# Recorder runbook

## Required secrets and addresses

Keep `PRIVATE_KEY` outside the repository. The current smoke wallet key remains
only in the temporary spike checkout; it is intentionally not copied here.

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
- A void market is revealed but excluded from Brier scoring.
