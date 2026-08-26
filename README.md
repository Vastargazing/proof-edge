# ProofEdge

ProofEdge is an estimator-agnostic measurement layer for DreamDEX Event
Contracts. It freezes an estimator probability and the contemporaneous market
baseline before expiry, anchors commitments on Somnia Shannon, and scores both
after resolution.

The current build is **recorder-only**: the risk gate records whether a forecast
would be execution-eligible, but order execution is intentionally disabled.

## Reproducible production batch

The repository includes the append-only ledger snapshot at
[`published/forecast-events.jsonl`](published/forecast-events.jsonl). Its first
production-v1 batch contains four forecasts with complete evidence bodies:

- root: `0x5361b3cc07f7adcd943cea288f75f97b8d565bd6d47922ddaf02b158ae8fb48d`;
- leaves: 4;
- transaction: [0xce29…1613](https://shannon-explorer.somnia.network/tx/0xce296f66cd53a98ad45c6853f79dd4adb5f7412886e2a4af58fa9fb75ced1613).

The earlier six-leaf root `0x5e759f…ef094` is retained only as an integration
smoke batch. Its commitments and proofs verify, but its evidence bodies were not
retained, so it is excluded from production calibration claims.

## Verify from a clean clone

```bash
git clone --recurse-submodules https://github.com/Vastargazing/proof-edge.git
cd proof-edge
npm install
npm run check
npm run verify:log
npm run verify:chain
```

`verify:log` rejects empty ledgers, verifies the hash chain and every Merkle
proof, and reports Brier scores. `verify:chain` independently fetches Shannon
receipts and blocks and matches the emitter, root, leaf count, timestamp, gas,
and `RootAnchored` event.

## Scoring

For every resolved non-void market, the recorder stores the Brier score of the
agent and the market snapshot. Aggregate skill is:

```text
Brier Skill Score = 1 - mean(BS_agent) / mean(BS_market)
```

A positive value means the estimator beat the market baseline. Production-v1
and pre-v1 smoke samples are reported separately. Until production-v1 markets
resolve, its skill score is `null`, not an inferred claim.

## Safety and completeness boundary

- Every market that reaches the estimator while the recorder is running enters
  the ledger; risk gating never filters the calibration sample.
- `p_market` is captured once at commitment time and never refreshed.
- A restart is idempotent by `market_id`.
- A new risk configuration creates a separately hashed decision; it does not
  rewrite an old one.
- Production mode waits for measured volatility after startup instead of
  freezing fallback-only warm-up estimates.
- The ledger does not attest recorder uptime. A market missed during downtime or
  before the estimator has valid inputs leaves no on-chain completeness proof.

## Run the recorder

```bash
cp .env.example .env
# add only a dedicated funded Shannon PRIVATE_KEY
npm run recorder:live
```

See [record format](docs/RECORD_FORMAT.md), [gas budget](docs/GAS_BUDGET.md),
[operations runbook](docs/RUNBOOK.md), and the original
[testnet spike](SPIKE_REPORT.md).

To resolve and score already-recorded expired markets without a wallet or any
new transaction, run:

```bash
npm run recorder:reconcile
```

Submission materials include the [DreamDEX feedback report](docs/FEEDBACK_REPORT.md)
and a timed [2–3 minute demo script](docs/DEMO_SCRIPT.md).

Licensed under the [MIT License](LICENSE).
