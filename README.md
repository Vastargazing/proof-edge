# ProofEdge

Our estimator's Brier loss was 34.3% worse than the market's. We know because we
committed every probability before the answer existed, and the verifier gives
us no way to edit that number into a win.

**234 forecasts · 104 on-chain anchors · 220 public proofs · 0 undisclosed
production roots · Brier skill −0.343 across seven model versions at N=226.** The
skill figure is the mixed historical total, not the result of the current model
version; its two samples are reported separately below. Eight newer forecasts
were still waiting for resolution in the published snapshot. None was
unanchored or anchored late
(`dashboard/app/forecast-data.json:27-39,41-75,338-345`).

ProofEdge records probabilities for DreamDEX BTC and ETH Event Contracts, seals
the estimator version and market midpoint with each observation, and puts Merkle
roots on Somnia Shannon before expiry. After resolution, it reveals the
preimages and scores both probabilities against the same outcome. The current
build is recorder-only: the risk gate records whether we would trade, but it
never sends an order (`src/live-recorder.ts:155-167,288-307`).

The point was not to ship another probability formula. The upstream
`ec-oracle-follow` strategy already had opening-price lookup, spot, measured
volatility, time scaling and a normal-CDF-style estimate
(`SPIKE_REPORT.md:110-124`). We built the part that makes a forecasting claim
expensive to revise after the fact.

## Verify one forecast

This is the shortest path through the project:

```bash
git clone --recurse-submodules https://github.com/Vastargazing/proof-edge.git
cd proof-edge && npm ci
RPC_URL=https://api.infra.testnet.somnia.network npm run verify -- \
  evidence/0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json
```

The checked-in evidence produces five checks:

```text
PASS 1/5 canonical preimage -> 0xe34a1f9e4e57dbd2c6afe7ddf18e061039a035246c1e603f88e70e69c4109adf
PASS 2/5 Merkle proof -> 0x5361b3cc07f7adcd943cea288f75f97b8d565bd6d47922ddaf02b158ae8fb48d
PASS 3/5 agent 0x2624F4553d622f0310c4a47D36aCFC1388dac365 emitted root with leafCount 4 at block timestamp 1787677629
PASS 4/5 on-chain market 0x0000000000000000000000000000000000000000000000000000000000009617 expiry_ns 1787680800000000000 outcome YES
PASS 5/5 anchor_ns 1787677629000000000 < on-chain expiry_ns 1787680800000000000
```

The verifier rebuilds the canonical JSON and commitment, walks the ordered
Merkle proof, decodes the root event, fetches the market by `market_id`, and
compares the block timestamp with the on-chain expiry. A late but otherwise
valid anchor returns `NOT PROVABLE`; a changed probability, expiry, outcome,
root, submitter or leaf count returns `FAIL`
(`src/evidence-verifier.ts:120-193`, `test/evidence-verifier.test.ts:68-282`).
The proof above belongs to the first four-leaf production batch, anchored in
transaction
[`0xce29…1613`](https://shannon-explorer.somnia.network/tx/0xce296f66cd53a98ad45c6853f79dd4adb5f7412886e2a4af58fa9fb75ced1613)
(`evidence/index.json:3-29`).

We also ran `npm run check` on the repository snapshot. It compiled the
TypeScript and passed 63 tests. Those tests included one-digit probability
tampering, a foreign anchor transaction, an on-chain outcome mismatch, late
anchoring, deletion and rechaining of an earlier batch, restart recovery after
`SIGKILL`, and the retained ledger incident (`test/evidence-verifier.test.ts`,
`test/chain-verifier.test.ts:23-36`, `test/store-lock.test.ts:10-46`,
`test/store.test.ts:47-112`).

## The result we could not tune away

For a resolved YES/NO market we compute the Brier score, `(p - outcome)^2`, once
for the sealed estimator probability and once for the sealed market midpoint.
Aggregate skill is:

```text
Brier Skill Score = 1 - mean(BS_agent) / mean(BS_market)
```

Across the mixed historical record, the estimator's mean Brier score is
`0.3080`; the market's is `0.2294`. Skill is `−0.3426`, with a deterministic
1,000-resample 95% interval from `−0.4806` to `−0.2104` at `N=226`
(`dashboard/app/forecast-data.json:41-58`). That is a loss. We display it.

The mixed-history risk-gate subset is `−0.0234` at `N=54`, with an interval from
`−0.1045` to `0.0535` (`dashboard/app/forecast-data.json:60-75`). We do not call
that an edge. The interval crosses zero, and the aggregate mixes seven sealed
`model_hash` values.

The current seventh version is reported on its own. Across all evaluated
windows, skill is `−0.9117` at `N=9`, with a 95% interval from `−1.4401` to
`−0.1253`. Its risk-gate subset is `−7.5837` at `N=2`, with an interval from
`−9.4058` to `−6.3046` (`dashboard/app/forecast-data.json:300-336`). Those sample
sizes are too small for a performance claim; the figures are diagnostic.

Our first ten-record reading had been more confident. The combined table made
risk-gate PASS windows look worse than all evaluated windows, and we initially
read that as the gate amplifying model bias. Splitting the same immutable rows by
their already-sealed `model_hash` destroyed that conclusion. Commit
`b2904c4686c0934c5952567dd67d7e13cfa2dc80` added the split and the regression
test that keeps the mixed total unchanged while separating model versions
(`test/scoring.test.ts:81-102`). We did not know enough from ten records. The
ledger made that visible before the README did.

## The obvious root was not enough

We first treated an on-chain Merkle root as the proof boundary. The first root
contained six leaves and landed in transaction
[`0xaf9a…1f1e`](https://shannon-explorer.somnia.network/tx/0xaf9a9b6e7faa6283e8e6a1dcf195b6e21885c2747181206ed76d83f355111f1e),
but we had not retained its evidence bodies. Its commitments still verify; its
observations cannot support calibration. We keep the batch as smoke evidence
and exclude all six forecasts from the public proof count
(`deployments/shannon.json:39-43`, `test/evidence.test.ts:29-52`).

Then we found the larger mistake. A root proved that disclosed leaves belonged
to a batch. It did not prove that we had disclosed every root sent by our wallet,
and a local `prev_event_hash` chain could be rebuilt after deleting history. We
added a completeness scan over production `RootAnchored` events, then changed
the forward contract event to bind each Merkle root to the exact preceding
ledger head. The first ledger-head root was mined at block `471834978`; older
roots remain verifiable under the legacy event and cannot be upgraded
(`THREAT_MODEL.md:121-139`, commits `329b2f5b7ae970f7dde46a6025ffa799bdc43b3e`
and `80d036c3203a43af0f3e8b7bb4ae2e4433d18b61`). At watermark block
`473261030`, the audit sees 104 on-chain roots, 104 disclosed roots and zero
hidden roots (`dashboard/app/forecast-data.json:374-381`).

We had already deployed a different contract and abandoned it. The stateful
registry stored an anchor struct and cost a mean `270,524` gas per root. The
event-only emitter cost `55,938`, or 79.3% less, across ten transactions per
variant. We paid the stateful deployment cost, marked it `production: false`,
and moved production to emitted events (`docs/GAS_BUDGET.md:3-16,22-25`,
`deployments/shannon.json:4-22`). The tradeoff is direct: independent checking
now needs receipts and logs instead of one contract mapping read.

## The ledger forked

On 27 August the append-only file stopped being a line. The retained byte image
had a publication watermark at line 621 and another event at line 622 with the
same parent; lines 622 through 1051 continued only the second branch. That is
what the bytes establish. We do not know which process-level action started the
second writer, so we did not invent a cleaner cause
(`THREAT_MODEL.md:141-149`; incident SHA-256
`274642299ee63bf97b4b1bb28b181beba8960961afec0af532a5006a3d894475`).

We did not delete the losing line. The reader now reports a terminal losing tip
as an orphan, chooses the sole continued chain, and fails closed if both sides
have descendants or if any event hash is invalid (`src/store.ts:166-211`,
`test/store.test.ts:47-112`). The published snapshot therefore still says
`orphan_count: 1`. A writable store also takes an atomic sidecar lock containing
the PID and Linux process-start token; a live second writer is refused, while a
lock left by `SIGKILL` is recovered (`src/store.ts:83-164`). This ties writer
recovery to Linux `/proc`. We accept that platform cost for the recorder host.

The incident also exposed an availability gap: systemd could restart a dead
process, but we had no checked-in test that observations were still advancing.
The watchdog now samples service state plus forecast and anchor counts every ten
minutes. An inactive service alerts immediately; either count staying flat for
two ticks alerts on the second tick (`THREAT_MODEL.md:166-173`, commit
`4e7cec44891dd0c51ab568c28719e9c27bff1f58`). It still does not prove uptime.

## Three DreamDEX traps we kept

- A resolved SDK promise did not imply a successful receipt. We kept
  `assertTxOk` after mint, place, cancel and redeem; the guarded IOC bought one
  YES at `0.419 tUSDC` in
  [`0x8e95…9298`](https://shannon-explorer.somnia.network/tx/0x8e9510080005ad75b2cabc54baf019ca6139931ef277d369842696a313529298)
  (`FEEDBACK.md:10-24`, `SPIKE_REPORT.md:36-48`).

- Binary sizes needed `quantize`, not `amountToPrecision`, and every order needed
  a future `expireTimestampNs`. The working path capped expiry to the market and
  sent nanoseconds (`FEEDBACK.md:26-34`).

- Indexed status was not the trading or settlement authority. We gated writes
  on the on-chain status and swept finalized markets through
  `listBinaryMarkets({ status: "Finalized" })`; the separate path redeemed one NO
  in
  [`0x2674…37b9`](https://shannon-explorer.somnia.network/tx/0x2674d74c10432436b4374bbbb23aa9f839a3912a97302284d1a43726968337b9)
  (`FEEDBACK.md:46-63`).

The full list, including two `ec:doctor` failures, is in
[`FEEDBACK.md`](FEEDBACK.md). We filed them as
[dreamdex-bot-kit#20](https://github.com/somnia-chain/dreamdex-bot-kit/issues/20)
and [#22](https://github.com/somnia-chain/dreamdex-bot-kit/issues/22); the client
access fix became [PR #21](https://github.com/somnia-chain/dreamdex-bot-kit/pull/21)
(`FEEDBACK.md:65-88`).

## What the record still does not prove

ProofEdge proves that a disclosed forecast matches its anchored bytes and that
the anchor precedes the market's on-chain expiry. It does not prove that the
oracle, order book or spot input is correct. It does not attest recorder uptime,
and discovery still reads at most 50 active markets per poll. A market missed
during downtime, before measured volatility warms up, or because a required
input is absent leaves no commitment (`src/live-recorder.ts:204-246,373-380`,
`THREAT_MODEL.md:196-208`).

There is also no minimum lead-time rule: one block before expiry counts as on
time. Six smoke forecasts have no retained evidence. Eight forecasts in the
published snapshot were unresolved. One orphan stays public. Order execution
stays off. Those are boundaries, not footnotes.

## Run and audit

The recorder requires Node.js 22+, the pinned submodule, public Shannon
configuration, and a dedicated funded Shannon key. `.env.example` contains the
non-secret defaults; the key must never be committed (`package.json:28-40`,
`.env.example:1-21`).

```bash
git submodule update --init --recursive
npm ci
cp .env.example .env
# add only a dedicated funded Shannon PRIVATE_KEY
npm run check
node --env-file=.env --import tsx src/live-recorder.ts
```

To resolve and score already-recorded expired markets without loading a wallet
or submitting a transaction, stop the live recorder first. Two processes must
never write the same JSONL file concurrently (`docs/RUNBOOK.md:76-88`).

```bash
RECORDER_STORE=data/forecast-events.jsonl npm run recorder:reconcile
```

The complete public audit path is:

```bash
npm run check
npm run verify:log
npm run verify:chain
npm run verify:completeness
npm run verify:all
```

`verify:completeness` scans the legacy production emitter from block
`471035786` and the ledger-head emitter from its deployment block `471812148`.
The earlier range `471035563..471035785` contains ten synthetic gas-benchmark
roots with leaf counts 1 through 10; no forecast preimages were created for
them, so the default production audit excludes that closed range. Set
`COMPLETENESS_FROM_BLOCK=471035563` to inspect it explicitly
(`docs/RUNBOOK.md:147-157`, `scripts/verify-completeness.ts:27-50,129-175`).

The command compares every production root and leaf count from the declared
submitter with the published ledger and reports undisclosed roots, duplicates,
leaf-count mismatches, overlapping disclosed windows and ledger roots missing
on-chain. A hidden legacy root exposes its leaf count but not its market IDs
(`scripts/verify-completeness.ts:136-175`).

The frozen bytes are documented in the
[`record format`](docs/RECORD_FORMAT.md). Recovery, watchdog and publisher
procedures live in the [`operations runbook`](docs/RUNBOOK.md). The measured
registry/emitter comparison is in the [`gas budget`](docs/GAS_BUDGET.md), and
the remaining trust assumptions are in the [`threat model`](THREAT_MODEL.md).
The full Shannon trading lifecycle remains in the
[`testnet spike`](SPIKE_REPORT.md); that file is still in the repository root.

## Sources

- Snapshot: `3feae9081e85c79536f7dd8fbc8b81cb46a5d5ed`;
  [`dashboard/app/forecast-data.json`](dashboard/app/forecast-data.json),
  [`evidence/index.json`](evidence/index.json), and
  [`published/forecast-events.jsonl`](published/forecast-events.jsonl).
- Initial implementation and smoke batch:
  `b62aed290031f01816421f1f8fc7f6e89d3f8077`;
  [`deployments/shannon.json`](deployments/shannon.json); transaction
  `0xaf9a9b6e7faa6283e8e6a1dcf195b6e21885c2747181206ed76d83f355111f1e`.
- Versioned scoring: `b2904c4686c0934c5952567dd67d7e13cfa2dc80`;
  [`src/scoring.ts`](src/scoring.ts); [`test/scoring.test.ts`](test/scoring.test.ts).
- Ledger-head repair: `329b2f5b7ae970f7dde46a6025ffa799bdc43b3e`,
  `80d036c3203a43af0f3e8b7bb4ae2e4433d18b61`;
  [`contracts/ForecastRootEmitter.sol`](contracts/ForecastRootEmitter.sol);
  [`test/chain-verifier.test.ts`](test/chain-verifier.test.ts).
- Concurrent-writer incident: `4e7cec44891dd0c51ab568c28719e9c27bff1f58`;
  [`incidents/2026-08-27/forecast-events.jsonl.corrupted`](incidents/2026-08-27/forecast-events.jsonl.corrupted);
  [`src/store.ts`](src/store.ts); [`test/store.test.ts`](test/store.test.ts);
  [`test/store-lock.test.ts`](test/store-lock.test.ts).
- Live trading spike: [`SPIKE_REPORT.md`](SPIKE_REPORT.md); transactions
  `0x8e9510080005ad75b2cabc54baf019ca6139931ef277d369842696a313529298`
  and `0x2674d74c10432436b4374bbbb23aa9f839a3912a97302284d1a43726968337b9`.
- DreamDEX SDK findings: pinned upstream commit
  `dccd2fdbf5e59316a5e9209546707b91b5f4cd7d`;
  [`FEEDBACK.md`](FEEDBACK.md); issues #20/#22; PR #21.

Licensed under the [MIT License](LICENSE).
