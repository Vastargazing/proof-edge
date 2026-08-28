# How we built ProofEdge

Our estimator's Brier loss was 34.3% worse than the market's. We know because we
committed every probability before the answer existed, and the verifier gives
us no way to edit that number into a win.

**234 forecasts · 104 on-chain anchors · 220 public proofs · 0 undisclosed
production roots · Brier skill −0.343 across seven model versions at N=226.**
That skill figure was the mixed historical total; the current version's two
samples appear below. Eight newer forecasts were still waiting for resolution
in the published snapshot. None was unanchored or anchored late
(`dashboard/app/forecast-data.json:27-39,41-75,338-345`).

ProofEdge recorded probabilities for DreamDEX BTC and ETH Event Contracts,
sealed the estimator version and the market midpoint with each observation, and
put Merkle roots on Somnia Shannon before expiry. After resolution, it revealed
the preimages and scored both probabilities against the same outcome. The build
stayed recorder-only: the risk gate recorded whether we would have traded, but
it never sent an order (`src/live-recorder.ts:155-167,288-307`).

The point was not to ship another probability formula. The upstream
`ec-oracle-follow` strategy already had opening-price lookup, spot, measured
volatility, time scaling and a normal-CDF-style estimate
(`SPIKE_REPORT.md:110-124`). We built the part that made a forecasting claim
expensive to revise after the fact.

## Verify one forecast

This was the shortest path through the project:

```bash
git clone --recurse-submodules https://github.com/Vastargazing/proof-edge.git
cd proof-edge && npm ci
RPC_URL=https://api.infra.testnet.somnia.network npm run verify -- \
  evidence/0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json
```

The checked-in evidence produced five checks:

```text
PASS 1/5 canonical preimage -> 0xe34a1f9e4e57dbd2c6afe7ddf18e061039a035246c1e603f88e70e69c4109adf
PASS 2/5 Merkle proof -> 0x5361b3cc07f7adcd943cea288f75f97b8d565bd6d47922ddaf02b158ae8fb48d
PASS 3/5 agent 0x2624F4553d622f0310c4a47D36aCFC1388dac365 emitted root with leafCount 4 at block timestamp 1787677629
PASS 4/5 on-chain market 0x0000000000000000000000000000000000000000000000000000000000009617 expiry_ns 1787680800000000000 outcome YES
PASS 5/5 anchor_ns 1787677629000000000 < on-chain expiry_ns 1787680800000000000
```

The verifier rebuilt the canonical JSON and commitment, walked the ordered
Merkle proof, decoded the root event, fetched the market by `market_id`, and
compared the block timestamp with the on-chain expiry. A late but otherwise
valid anchor returned `NOT PROVABLE`; a changed probability, expiry, outcome,
root, submitter or leaf count returned `FAIL`
(`src/evidence-verifier.ts:120-193`, `test/evidence-verifier.test.ts:68-282`).
The proof above belonged to the first four-leaf production batch, anchored in
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

For a resolved YES/NO market we computed the Brier score, `(p - outcome)^2`,
once for the sealed estimator probability and once for the sealed market
midpoint. Aggregate skill was:

```text
Brier Skill Score = 1 - mean(BS_agent) / mean(BS_market)
```

Across the mixed historical record, the estimator's mean Brier score was
`0.3080`; the market's was `0.2294`. Skill was `−0.3426`, with a deterministic
1,000-resample 95% interval from `−0.4806` to `−0.2104` at `N=226`
(`dashboard/app/forecast-data.json:41-58`). That was a loss. We displayed it.

The risk-gate subset looked less bad: `−0.0234` at `N=54`, with an interval from
`−0.1045` to `0.0535` (`dashboard/app/forecast-data.json:60-75`). We did not call
that an edge. The interval crossed zero, and the aggregate mixed seven sealed
`model_hash` values.

The current seventh version had only nine evaluated windows. Its all-window
skill was `−0.9117`, with an interval from `−1.4401` to `−0.1253`; its risk-gate
subset was `−7.5837` at `N=2`, with an interval from `−9.4058` to `−6.3046`
(`dashboard/app/forecast-data.json:300-336`). We kept the numbers visible and
treated both samples as diagnostic.

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
but we had not retained its evidence bodies. Its commitments still verified;
its observations could not support calibration. We kept the batch as smoke
evidence and excluded all six forecasts from the public proof count
(`deployments/shannon.json:39-43`, `test/evidence.test.ts:29-52`).

Then we found the larger mistake. A root proved that disclosed leaves belonged
to a batch. It did not prove that we had disclosed every root sent by our wallet,
and a local `prev_event_hash` chain could be rebuilt after deleting history. We
added a completeness scan over production `RootAnchored` events, then changed
the forward contract event to bind each Merkle root to the exact preceding
ledger head. The first ledger-head root was mined at block `471834978`; older
roots remained verifiable under the legacy event and could not be upgraded
(`THREAT_MODEL.md:121-139`, commits `329b2f5b7ae970f7dde46a6025ffa799bdc43b3e`
and `80d036c3203a43af0f3e8b7bb4ae2e4433d18b61`). At watermark block
`473261030`, the audit saw 104 on-chain roots, 104 disclosed roots and zero
hidden roots (`dashboard/app/forecast-data.json:374-381`).

We had already deployed a different contract and abandoned it. The stateful
registry stored an anchor struct and cost a mean `270,524` gas per root. The
event-only emitter cost `55,938`, or 79.3% less, across ten transactions per
variant. We paid the stateful deployment cost, marked it `production: false`,
and moved production to emitted events (`docs/GAS_BUDGET.md:3-16,22-25`,
`deployments/shannon.json:4-22`). The tradeoff was direct: independent checking
now needed receipts and logs instead of one contract mapping read.

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
lock left by `SIGKILL` is recovered (`src/store.ts:83-164`). This tied writer
recovery to Linux `/proc`. We accepted that platform cost for the recorder host.

The incident also exposed an availability gap: systemd could restart a dead
process, but we had no checked-in test that observations were still advancing.
The watchdog now sampled service state plus forecast and anchor counts every ten
minutes. An inactive service alerted immediately; either count staying flat for
two ticks alerted on the second tick (`THREAT_MODEL.md:166-173`, commit
`4e7cec44891dd0c51ab568c28719e9c27bff1f58`). It still did not prove uptime.

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
[`FEEDBACK.md`](../../FEEDBACK.md). We filed them as
[dreamdex-bot-kit#20](https://github.com/somnia-chain/dreamdex-bot-kit/issues/20)
and [#22](https://github.com/somnia-chain/dreamdex-bot-kit/issues/22); the client
access fix became [PR #21](https://github.com/somnia-chain/dreamdex-bot-kit/pull/21)
(`FEEDBACK.md:65-88`).

## What the record still does not prove

ProofEdge proved that a disclosed forecast matched its anchored bytes and that
the anchor preceded the market's on-chain expiry. It did not prove that the
oracle, order book or spot input was correct. It did not attest recorder uptime,
and discovery still read at most 50 active markets per poll. A market missed
during downtime, before measured volatility warmed up, or because a required
input was absent left no commitment (`src/live-recorder.ts:204-246,373-380`,
`THREAT_MODEL.md:184-200`).

There was also no minimum lead-time rule: one block before expiry counted as on
time. Six smoke forecasts had no retained evidence. Eight forecasts in the latest
snapshot were unresolved. One orphan stayed public. Order execution stayed off.
Those are boundaries, not footnotes.

For the full audit path, run:

```bash
npm run check
npm run verify:log
npm run verify:chain
npm run verify:completeness
npm run verify:all
```

The record format is in [`docs/RECORD_FORMAT.md`](../../docs/RECORD_FORMAT.md),
the operational recovery steps in [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md),
and the remaining assumptions in [`THREAT_MODEL.md`](../../THREAT_MODEL.md).

## Sources

- Snapshot: `3feae9081e85c79536f7dd8fbc8b81cb46a5d5ed`;
  `dashboard/app/forecast-data.json`; `evidence/index.json`;
  `published/forecast-events.jsonl`.
- Initial implementation and smoke batch:
  `b62aed290031f01816421f1f8fc7f6e89d3f8077`; `deployments/shannon.json`;
  transaction `0xaf9a9b6e7faa6283e8e6a1dcf195b6e21885c2747181206ed76d83f355111f1e`.
- Versioned scoring: `b2904c4686c0934c5952567dd67d7e13cfa2dc80`;
  `src/scoring.ts`; `test/scoring.test.ts`.
- Ledger-head repair: `329b2f5b7ae970f7dde46a6025ffa799bdc43b3e`,
  `80d036c3203a43af0f3e8b7bb4ae2e4433d18b61`; `contracts/ForecastRootEmitter.sol`;
  `test/chain-verifier.test.ts`.
- Concurrent-writer incident: `4e7cec44891dd0c51ab568c28719e9c27bff1f58`;
  `incidents/2026-08-27/forecast-events.jsonl.corrupted`; `src/store.ts`;
  `test/store.test.ts`; `test/store-lock.test.ts`.
- Live trading spike: `SPIKE_REPORT.md`; transactions
  `0x8e9510080005ad75b2cabc54baf019ca6139931ef277d369842696a313529298`
  and `0x2674d74c10432436b4374bbbb23aa9f839a3912a97302284d1a43726968337b9`.
- DreamDEX SDK findings: pinned upstream commit
  `dccd2fdbf5e59316a5e9209546707b91b5f4cd7d`; `FEEDBACK.md`; issues #20/#22;
  PR #21.

Licensed under the [MIT License](../../LICENSE).
