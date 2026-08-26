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
  [`live-recorder.ts:52`](src/live-recorder.ts#L52).

- The indexer status lagged the state that accepted orders on-chain. We kept the
  actual write gate as `onchain.status === Trading` at
  [`markets.ts:145`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L145),
  and the recorder also waited for `isResolved` or `isVoided` at
  [`live-recorder.ts:272`](src/live-recorder.ts#L272). We fetched the on-chain
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

## Reproducible public ledger

The repository includes the append-only ledger snapshot at
[`published/forecast-events.jsonl`](published/forecast-events.jsonl). At the
2026-08-26 audit-fix snapshot it contains 69 forecasts, 27 anchored roots, 61
scores, and 8 outcomes still pending. Fifty-five resolved, on-time forecasts
with complete evidence are exported under [`evidence/`](evidence/).

The first production-v1 batch contained four forecasts with complete evidence:

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
PASS 1/5 canonical preimage -> 0xe34a1f9e4e57dbd2c6afe7ddf18e061039a035246c1e603f88e70e69c4109adf
PASS 2/5 Merkle proof -> 0x5361b3cc07f7adcd943cea288f75f97b8d565bd6d47922ddaf02b158ae8fb48d
PASS 3/5 anchor tx emitted root at block timestamp 1787677629
PASS 4/5 on-chain market 0x…9617 expiry_ns 1787680800000000000 outcome YES
PASS 5/5 anchor_ns 1787677629000000000 < on-chain expiry_ns 1787680800000000000
PASS evidence/0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json
```

The command uses only the evidence file, public RPC, and public DreamDEX
configuration (both legacy and ledger-head emitters are accepted by default;
override them with `EMITTER_ADDRESSES`). Run
`npm run verify:all` for the complete folder. A structurally valid record whose
anchor was mined at or after expiry is reported as `NOT PROVABLE`, not `FAIL`.
`verify` reads the market by `market_id` from chain and rejects a file whose
expiry or outcome differs. `verify:log`, `verify:chain`, and
`verify:completeness` audit the full published ledger and every production
`RootAnchored` event from the configured submitter.

The sealed probabilities can be checked for a YES/NO mapping regression from
the same public ledger:

```bash
npm run diagnose:mapping
```

It reports mean `p_agent`, mean sealed `p_market`, the observed YES rate, and
the Brier score both as recorded and after the diagnostic `1 - p_agent`
inversion. Results are split between all resolved history, production-v1, and
each sealed `model_hash`; the command never rewrites a forecast.

## Scoring

For every resolved non-void market with an on-time anchor, the recorder stores
the Brier score of the agent and the market snapshot captured in the sealed
record. It never refreshes either probability. Late, unanchored, unresolved,
and void forecasts remain visible but are excluded from scoring. Aggregate
skill is:

```text
Brier Skill Score = 1 - mean(BS_agent) / mean(BS_market)
```

A positive value means the estimator beat the market baseline. The dashboard
shows two samples together: all eligible evaluated windows, and the subset whose
first recorded risk decision allowed execution. Each agent Brier, market Brier,
and skill value carries its own `N`; mean `p_agent` and mean sealed `p_market`
are shown together. Skill also includes a deterministic 95% bootstrap interval
(1,000 resamples). The historical total is explicitly marked as mixed-model,
and both samples are repeated for every `model_hash` found in the sealed
payloads. Resolution events update the report automatically. The grouping reads
existing immutable fields; it does not backfill, reprice, or rewrite a record.

### What versioning caught

The first conclusion our own record destroyed was ours.

The first ten-record review produced a plausible but wrong conclusion. The
mixed historical total showed worse skill for risk-gate PASS windows than for
all evaluated windows, so we initially read the gate as amplifying model bias.
That conclusion did not survive a split by the `model_hash` already sealed in
each immutable record. No forecast or outcome was changed to obtain the split.

The combined number remains available as history, but it is labelled mixed and
is never used to compare model behavior across a code change. With fewer than
100 resolved windows, every displayed estimate is diagnostic only; it is not
presented as evidence of performance.

## Safety and completeness boundary

- Discovery reads at most the first 50 `activeMarkets` rows per poll. A row is
  recorded only if it is a binary BTC/ETH market not seen before, spot and
  momentum are available, the on-chain market and expiry can be read, interval
  and time-to-expiry are positive, the YES book has both sides needed for a
  midpoint, the opening/fixed reference answers, and (in current production)
  measured volatility has warmed up. Risk gating never filters forecasts that
  have already passed those input filters.
- `p_market` is captured once at commitment time and never refreshed.
- A restart is idempotent by `market_id`.
- A prepared batch is fsynced before submission and recovered on restart,
  including after a SIGKILL between observation and anchoring.
- Anchor submission retries with exponential backoff without stopping new
  observations. A root mined at or after expiry is marked `anchored_late` and
  excluded from the provable and scored sets.
- A new risk configuration creates a separately hashed decision; it does not
  rewrite an old one.
- The first four production evidence files have `volatility.measured = null`,
  used the `0.0015` fallback, and sealed the legacy SDK label `0.28.x`. Current
  production requires measured volatility and seals the installed exact SDK
  version (`0.28.1` in this snapshot); historical manifests are not rewritten.
- An on-time proof means the root block timestamp is strictly before the
  on-chain expiry while the outcome is not yet available. There is no enforced
  minimum lead time before expiry.
- The ledger does not attest recorder uptime. A market missed during downtime or
  before the estimator has valid inputs leaves no on-chain completeness proof.

## Completeness audit

`npm run verify:completeness` scans every `RootAnchored` event for the production
submitter from block `471035786` onward and requires every root and leaf count to
appear in the published ledger. The preceding blocks `471035563..471035785` are
excluded explicitly: they contain ten synthetic emitter gas-benchmark roots with
`leafCount` 1 through 10. Override `COMPLETENESS_FROM_BLOCK` to audit that range
too; those roots intentionally have no forecast preimages. The v1 event reveals
only a hidden root's leaf count, so overlap with a window can be diagnosed only
after that batch's leaf list is disclosed.

## Run the recorder

```bash
cp .env.example .env
# add only a dedicated funded Shannon PRIVATE_KEY
npm run recorder:live
```

See [record format](docs/RECORD_FORMAT.md), [gas budget](docs/GAS_BUDGET.md),
[threat model](THREAT_MODEL.md), [operations runbook](docs/RUNBOOK.md), and the original
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
