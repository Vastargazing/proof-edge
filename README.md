# Somnia verifiable forecast recorder

An estimator-agnostic measurement layer for DreamDEX Event Contracts. It records
every market an estimator evaluates, commits the forecast before expiry, anchors
new commitments as a Merkle root, and later reveals and scores the forecast
against the market snapshot captured at commitment time.

The first live root is already anchored on Shannon:

- root: `0x5e759f913317c47f705c2df93b88c317872422d633471dcb7a1d642a512ef094`;
- leaves: 6;
- transaction: [0xaf9a…1f1e](https://shannon-explorer.somnia.network/tx/0xaf9a9b6e7faa6283e8e6a1dcf195b6e21885c2747181206ed76d83f355111f1e).

This root is an integration smoke batch. Production calibration starts with
records whose model hash includes the final upstream estimator configuration
and whose append-only event stores the full evidence body.

## Safety boundary

The recorder evaluates all eligible windows. Risk gating may control later
execution, but never controls whether an evaluated forecast enters the full
calibration sample. `p_market` is immutable after observation. Restart is
idempotent by market ID.

## Setup

```bash
git submodule update --init --recursive
npm install
cp .env.example .env
# put only a dedicated funded Shannon PRIVATE_KEY in .env
npm run check
```

Run continuously:

```bash
npm run recorder:live
```

Run until the first successfully anchored batch:

```bash
RECORDER_RUN_ONCE=true npm run recorder:live
```

Verify the local hash chain, every reveal commitment, Merkle proof, and anchor
timestamp:

```bash
node --import tsx scripts/verify-log.ts
```

See [record format](docs/RECORD_FORMAT.md), [gas budget](docs/GAS_BUDGET.md),
[operations runbook](docs/RUNBOOK.md), and the original
[testnet spike](SPIKE_REPORT.md).
