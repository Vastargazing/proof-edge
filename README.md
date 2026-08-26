# ProofEdge

ProofEdge is an estimator-agnostic measurement layer for DreamDEX Event
Contracts. It freezes an estimator probability and the contemporaneous market
baseline before expiry, anchors commitments on Somnia Shannon, and scores both
after resolution.

The current build is **recorder-only**: the risk gate records whether a forecast
would be execution-eligible, but order execution is intentionally disabled.

## What surprised us in the DreamDEX SDK

- An SDK write could resolve even when its receipt said `reverted`. We hit this
  in the EC path and kept the guard at
  [`exchange.ts:69`](vendor/dreamdex-bot-kit/packages/ec-core/src/exchange.ts#L69),
  then called it after order placement at
  [`orders.ts:146`](vendor/dreamdex-bot-kit/packages/ec-core/src/orders.ts#L146).
  We kept the same check on mint
  ([`inventory.ts:62`](vendor/dreamdex-bot-kit/packages/ec-core/src/inventory.ts#L62)),
  cancel ([`orders.ts:332`](vendor/dreamdex-bot-kit/packages/ec-core/src/orders.ts#L332)),
  and redeem
  ([`settlement.ts:153`](vendor/dreamdex-bot-kit/packages/ec-core/src/settlement.ts#L153));
  the guarded IOC completed in
  [`0x8e95…9298`](https://shannon-explorer.somnia.network/tx/0x8e9510080005ad75b2cabc54baf019ca6139931ef277d369842696a313529298).

- `amountToPrecision` rounded binary sizes to whole shares, and an order also
  needed a future `expireTimestampNs`. We recorded the size failure and the
  replacement at
  [`markets.ts:173`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L173),
  while our order path capped the expiry to the market and sent nanoseconds at
  [`orders.ts:118`](vendor/dreamdex-bot-kit/packages/ec-core/src/orders.ts#L118).
  We used `quantize` for sizes and built the expiry for every order.

- The deployment manifest was not a safe source for `venueId`; live markets could
  span more than one venue. Our first doctor run inferred one venue and then met
  the multi-venue guard at
  [`markets.ts:85`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L85).
  We read the ID from the intended live market row and required it explicitly in
  [`live-recorder.ts:28`](src/live-recorder.ts#L28).

- The indexer status lagged the state that accepted orders on-chain. We kept the
  actual write gate as `onchain.status === Trading` at
  [`markets.ts:145`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L145),
  and the recorder also waited for `isResolved` or `isVoided` at
  [`live-recorder.ts:232`](src/live-recorder.ts#L232). We fetched the on-chain
  snapshot before acting instead of trusting the indexed row.

- Finalized binary markets disappeared from `loadMarkets()`, so that list could
  not drive claims. Our claim sweep went through
  `listBinaryMarkets({ status: "Finalized" })` at
  [`markets.ts:247`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L247),
  then checked balances and resolution before redeeming. We kept this separate
  claim path; it redeemed the spike position in
  [`0x2674…37b9`](https://shannon-explorer.somnia.network/tx/0x2674d74c10432436b4374bbbb23aa9f839a3912a97302284d1a43726968337b9).

- `ec:doctor` printed an inferred venue, then called `activeMarkets` without
  preserving that scope and failed on the same multi-venue set. The two calls were
  separate at
  [`ec-doctor.ts:85`](vendor/dreamdex-bot-kit/scripts/ec-doctor.ts#L85) and
  [`ec-doctor.ts:101`](vendor/dreamdex-bot-kit/scripts/ec-doctor.ts#L101); the
  observed sequence is recorded in [`SPIKE_REPORT.md:138`](SPIKE_REPORT.md#L138).
  We bypassed the inference and set `VENUE_ID` from a live row. Reported upstream
  as [somnia-chain/dreamdex-bot-kit#22](https://github.com/somnia-chain/dreamdex-bot-kit/issues/22).

- `ec:doctor` created a read-only exchange but tried to read the native balance
  from `client.publicClient`, which was missing on the observed client shape. It
  failed at [`ec-doctor.ts:57`](vendor/dreamdex-bot-kit/scripts/ec-doctor.ts#L57) with
  `Cannot read properties of undefined (reading 'getBalance')`, recorded at
  [`SPIKE_REPORT.md:141`](SPIKE_REPORT.md#L141). We ran the doctor without wallet
  keys and checked the balance through the supported viem client separately.
  Reported upstream as
  [somnia-chain/dreamdex-bot-kit#20](https://github.com/somnia-chain/dreamdex-bot-kit/issues/20);
  the one-line fix is
  [PR #21](https://github.com/somnia-chain/dreamdex-bot-kit/pull/21).

## Reproducible production batch

The repository includes the append-only ledger snapshot at
[`published/forecast-events.jsonl`](published/forecast-events.jsonl). Its first
production-v1 batch contains four forecasts with complete evidence bodies:

- root: `0x5361b3cc07f7adcd943cea288f75f97b8d565bd6d47922ddaf02b158ae8fb48d`;
- leaves: 4;
- transaction: [0xce29…1613](https://shannon-explorer.somnia.network/tx/0xce296f66cd53a98ad45c6853f79dd4adb5f7412886e2a4af58fa9fb75ced1613).

The earlier six-leaf root `0x5e759f…ef094` is retained only as an integration
smoke batch. Its commitments and proofs verify, but its evidence bodies were not
retained, so it is excluded from production calibration claims and from the
public `evidence/` manifest.

## Verify from a clean clone

```bash
git clone --recurse-submodules https://github.com/Vastargazing/proof-edge.git
cd proof-edge && npm ci
RPC_URL=https://api.infra.testnet.somnia.network npm run verify -- evidence/0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json
```

Actual output from that file:

```text
PASS 1/4 canonical preimage -> 0xe34a1f9e4e57dbd2c6afe7ddf18e061039a035246c1e603f88e70e69c4109adf
PASS 2/4 Merkle proof -> 0x5361b3cc07f7adcd943cea288f75f97b8d565bd6d47922ddaf02b158ae8fb48d
PASS 3/4 anchor tx emitted root at block timestamp 1787677629
PASS 4/4 anchor_ns 1787677629000000000 < expiry_ns 1787680800000000000
PASS evidence/0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json
```

The command uses only the evidence file, public RPC, and emitter address (the
deployed emitter is the default; override it with `EMITTER_ADDRESS`). Run
`npm run verify:all` for the complete folder. A structurally valid record whose
anchor was mined at or after expiry is reported as `NOT PROVABLE`, not `FAIL`.
The older `verify:log` and `verify:chain` commands remain available for the full
published ledger audit.

## Scoring

For every resolved non-void market with an on-time anchor, the recorder stores
the Brier score of the agent and the market snapshot. Late and unanchored
forecasts remain in the ledger but are excluded from scoring. Aggregate skill is:

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
- A prepared batch is fsynced before submission and recovered on restart,
  including after a SIGKILL between observation and anchoring.
- Anchor submission retries with exponential backoff without stopping new
  observations. A root mined at or after expiry is marked `anchored_late` and
  excluded from the provable and scored sets.
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

Submission materials include the [DreamDEX SDK feedback](FEEDBACK.md),
two upstream bug reports —
[dreamdex-bot-kit#20](https://github.com/somnia-chain/dreamdex-bot-kit/issues/20)
with its fix [PR #21](https://github.com/somnia-chain/dreamdex-bot-kit/pull/21),
and [dreamdex-bot-kit#22](https://github.com/somnia-chain/dreamdex-bot-kit/issues/22) — and a timed
[2–3 minute demo script](docs/DEMO_SCRIPT.md).

Licensed under the [MIT License](LICENSE).
