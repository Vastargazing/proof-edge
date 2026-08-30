# ProofEdge

<!-- The blocks between generated markers are rewritten from
     dashboard/app/forecast-data.json by scripts/render-readme-stats.ts on
     every publisher run. Edit the surrounding prose, not these numbers. -->
<!-- generated:hook -->
Our estimator's Brier loss was 21.0% worse than the market's. We know
because every probability in that result was committed before the answer
existed; once anchored, those bytes cannot be edited after the fact.
<!-- /generated:hook -->

Here, a forecast is one sealed probability, an anchor is one Merkle-root
transaction, a proof is one disclosed forecast checked against that root, and
`N` is the resolved sample size; negative Brier skill means the estimator lost
to the market midpoint.

<!-- generated:headline -->
**1294 forecasts · 562 on-chain anchors · 1272 public proofs · 0 undisclosed
production roots · Brier skill −0.210 across 7 model versions at N=1278.** The
skill figure is the mixed historical total, not the result of the current model
version; its two samples are reported separately below. 16 newer forecasts were still waiting for resolution in the published snapshot.
None was unanchored or anchored late
(`dashboard/app/forecast-data.json`, keys `totals` and `resolve_score`).
<!-- /generated:headline -->

ProofEdge records probabilities for DreamDEX BTC and ETH Event Contracts, seals
the estimator version and market midpoint with each observation, and puts Merkle
roots on Somnia Shannon before expiry. After resolution, it reveals the
preimages and scores both probabilities against the same outcome. ProofEdge is
a live Somnia Shannon testnet recorder; order execution is intentionally
disabled. The risk gate records whether we would trade, but never sends an
order (`src/live-recorder.ts:155-167,288-307`).

The point was not to ship another probability formula. The upstream
`ec-oracle-follow` strategy already had opening-price lookup, spot, measured
volatility, time scaling and a normal-CDF-style estimate
(`docs/SPIKE_REPORT.md:110-124`). We built the part that makes a forecasting claim
expensive to revise after the fact.

## Verify one forecast

This is the shortest path through the project:

```bash
git clone --recurse-submodules https://github.com/Vastargazing/proof-edge.git
cd proof-edge && npm ci
RPC_URL=https://api.infra.testnet.somnia.network npm run verify -- \
  evidence/0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json
```

The checked-in evidence produces two ledger notices and five checks:

```text
LEDGER_ALERT orphan_count=1 accepted_events=4159 total_events=4160
LEDGER_ALERT orphan line=621 seq=620 type=publication_watermark event_hash=0xcca3b62213ce751fdad6d261fb1e10000b1004784c460625825ac0f81cef12c3 prev_event_hash=0x2381fdb6570c1d1b7453c0f8f08bb8f4e034b1fbe1c01ebc65725ea13a97f711

PASS 1/5 canonical preimage -> 0xe34a1f9e4e57dbd2c6afe7ddf18e061039a035246c1e603f88e70e69c4109adf
PASS 2/5 Merkle proof -> 0x5361b3cc07f7adcd943cea288f75f97b8d565bd6d47922ddaf02b158ae8fb48d
PASS 3/5 agent 0x2624F4553d622f0310c4a47D36aCFC1388dac365 emitted root with leafCount 4 at block timestamp 1787677629
PASS 4/5 on-chain market 0x0000000000000000000000000000000000000000000000000000000000009617 expiry_ns 1787680800000000000 outcome YES
PASS 5/5 anchor_ns 1787677629000000000 < on-chain expiry_ns 1787680800000000000
```

The two `LEDGER_ALERT` lines are expected. They re-report our retained
27 August fork incident on every read: the ledger keeps the losing line as a
visible orphan instead of deleting it, and the event counts advance with each
hourly snapshot (see [The ledger forked](#the-ledger-forked)).

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

### One forecast, end to end

The command above follows BTC market `0x…9617` through every layer:

1. **Observe.** At `1787677626.189` Unix seconds, spot was `79032.675`, the
   opening reference was `79154.21`, one-minute momentum was
   `−0.0009717537`, and the fallback volatility was `0.0015`. The YES book was
   `[(0.309, 200), (0.299, 330), (0.289, 460)]` bid and
   `[(0.338, 200), (0.348, 330), (0.358, 460)]` ask. Its best-price midpoint
   became `p_market = (0.309 + 0.338) / 2 = 0.3235`; the estimator produced
   `p_agent = 0.2213`.
2. **Seal.** The recorder put those probabilities, the market identity, expiry,
   model hash and nonce into these canonical UTF-8 bytes:

   ```json
   {"evidence_digest":"0x33ecd7b71caf4855252f491374a712aa1f96cb75c159615b7ddff5f323015d97","expiry_ns":"1787680800000000000","interval_sec":3600,"market_id":"0x0000000000000000000000000000000000000000000000000000000000009617","model_hash":"0x6a7015d65b03718c6eb5df4fafbc835398db3b1e8aedd714091ddb1d99257755","nonce":"0xa6a65cd469864f44d83ac0e9fab40440cd11fb13023621e8fb40edd0986a07d2","p_agent":0.2213,"p_market":0.3235,"side":"NO","symbol":"BTC","v":1,"venue_id":"0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c"}
   ```

   Their Keccak-256 commitment is
   `0xe34a1f9e4e57dbd2c6afe7ddf18e061039a035246c1e603f88e70e69c4109adf`.
3. **Batch and anchor.** That commitment was leaf `0` of a four-leaf batch. Its
   two proof siblings reconstruct root
   `0x5361b3cc07f7adcd943cea288f75f97b8d565bd6d47922ddaf02b158ae8fb48d`,
   emitted in [`0xce29…1613`](https://shannon-explorer.somnia.network/tx/0xce296f66cd53a98ad45c6853f79dd4adb5f7412886e2a4af58fa9fb75ced1613)
   at `1787677629`, 3,171 seconds before expiry.
4. **Resolve and score.** DreamDEX resolved the market YES, so the numeric
   outcome is `1`. The sealed estimator score is
   `(0.2213 − 1)² = 0.60637369`; the sealed market-midpoint score is
   `(0.3235 − 1)² = 0.45765225`. This forecast therefore made the estimator's
   aggregate result worse, not better.

Every value above comes from the checked-in
[`0x…9617` evidence file](evidence/0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json); the verifier independently reloads the transaction,
expiry and outcome instead of trusting the prose.

We also ran `npm run check` on the repository snapshot. It compiled the
TypeScript and passed 68 tests. Those tests included one-digit probability
tampering, a foreign anchor transaction, an on-chain outcome mismatch, late
anchoring, deletion and rechaining of an earlier batch, restart recovery after
`SIGKILL`, and the retained ledger incident (`test/evidence-verifier.test.ts`,
`test/chain-verifier.test.ts:23-36`, `test/store-lock.test.ts:10-46`,
`test/store.test.ts:47-112`).

Two more terms and two conventions: **Somnia Shannon** is the public Somnia
testnet and **DreamDEX Event Contracts** are its binary YES/NO markets; the
**risk gate** is a recorded PASS/VETO ruling that never places orders, and the
**Brier score** `(p − outcome)²` measures a probability against the resolved
outcome. Parenthetical references like (`src/store.ts:83-164`) name the file
and lines that implement or freeze a claim. The repository republishes its
data hourly; the statistics above are rewritten by the same publisher run
that commits the data they cite.

![ProofEdge flow from market observation to independent verification](docs/proof-flow.svg)

The arrows show what is carried forward. Hashes prove that disclosed bytes match
an earlier anchor; they do not prove that the input feeds were true or that the
recorder observed every market.

## The result we could not tune away

For a resolved YES/NO market we compute the Brier score, `(p - outcome)^2`, once
for the sealed estimator probability and once for the sealed market midpoint.
Aggregate skill is:

```text
Brier Skill Score = 1 - mean(BS_agent) / mean(BS_market)
```

<!-- generated:skill-mixed -->
Across the mixed historical record, the estimator's mean Brier score is
`0.2879`; the market's is `0.2379`. Skill is `−0.2103`, with a deterministic
1,000-resample 95% interval from `−0.2594` to `−0.1615` at `N=1278`
(`dashboard/app/forecast-data.json`, key `resolve_score.all_evaluated_windows`).
That is a loss. We display it.
<!-- /generated:skill-mixed -->

<!-- generated:skill-gate -->
The mixed-history risk-gate subset is `−0.0392` at `N=299`, with an interval from
`−0.0687` to `−0.0081`
(`dashboard/app/forecast-data.json`, key `resolve_score.risk_gate_passed`). We
do not call that an edge. The interval does not cross zero, but the aggregate mixes
7 sealed `model_hash` values.
<!-- /generated:skill-gate -->

<!-- generated:skill-current -->
The current seventh version is reported on its own. Across all evaluated
windows, skill is `−0.1865` at `N=1061`, with a 95% interval from `−0.2435` to
`−0.1309`. Its risk-gate subset is `−0.0424` at `N=247`, with an interval from
`−0.0745` to `−0.0113`
(`dashboard/app/forecast-data.json`, key `resolve_score.by_model_hash[6]`).
<!-- /generated:skill-current -->

The live recorder is pinned to commit `9756f2c`, the commit whose source
inventory reproduces the current `model_hash` `0x253a60a7…`. `main` has moved
on deliberately, publisher and documentation only, so recomputing the hash
from `HEAD` will not match, and the recorder unit refuses to start from a tree
that hashes differently
([threat model § the recorder and the repository diverged](THREAT_MODEL.md#the-recorder-and-the-repository-diverged)).

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
(`deployments/shannon.json:39-43`, `test/evidence.test.ts:104-112`).

Then we found the larger mistake. A root proved that disclosed leaves belonged
to a batch. It did not prove that we had disclosed every root sent by our wallet,
and a local `prev_event_hash` chain could be rebuilt after deleting history. We
added a completeness scan over production `RootAnchored` events, then changed
the forward contract event to bind each Merkle root to the exact preceding
ledger head. The first ledger-head root was mined at block `471834978`; older
roots remain verifiable under the legacy event and cannot be upgraded
([threat model § binding the local history](THREAT_MODEL.md#5-bind-the-local-history-not-only-the-merkle-tree),
commits `329b2f5b7ae970f7dde46a6025ffa799bdc43b3e`
and `80d036c3203a43af0f3e8b7bb4ae2e4433d18b61`).

<!-- generated:completeness -->
At watermark block `475182503`, the audit sees 563 on-chain
roots, 562 disclosed roots and zero hidden roots
inside the scope selected by repository defaults: submitter
`0x2624F4553d622f0310c4a47D36aCFC1388dac365`; `0x3020C7eA249b6Be98D0e9aCF911EAeeb766ACe4F` from block `471035786`,
`0xF700bde4cbE7000A4Ce075EA093E6a835974b95F` from block `471812148`. The exact values used for
this snapshot are stored at `dashboard/app/forecast-data.json`, key
`completeness.scope`; a different invocation can select a different scope.
<!-- /generated:completeness -->

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
([threat model § the hash chain forked](THREAT_MODEL.md#the-hash-chain-forked);
incident SHA-256
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
a configured number of ticks alerts, two while five-minute markets ran and
seven since DreamDEX moved to hourly windows. Since 29 August a unit systemd is
actively restarting counts as running while its heartbeat is fresh: on the
operator's VPN the recorder fails fast around twenty-six times an hour, and a
tick landing in a four-second restart gap was reporting an outage that did not
exist. The tradeoff is stated in the threat model
([threat model § restart was not the same as liveness](THREAT_MODEL.md#restart-was-not-the-same-as-liveness),
commit `4e7cec44891dd0c51ab568c28719e9c27bff1f58`). It still does not prove uptime.
On 28 August it caught its first real case: the upstream price feed froze for
54 minutes while the recorder kept heartbeating, four windows left no
commitment, and no restart could have helped. The watchdog now separates a
stalled loop, which it restarts through the hash-checked unit, from stale
inputs, which it only reports
([threat model § the feed froze while the heartbeat continued](THREAT_MODEL.md#the-feed-froze-while-the-heartbeat-continued)).

## Three DreamDEX traps we kept

- A resolved SDK promise did not imply a successful receipt. We kept
  `assertTxOk` after mint, place, cancel and redeem; the guarded IOC bought one
  YES at `0.419 tUSDC` in
  [`0x8e95…9298`](https://shannon-explorer.somnia.network/tx/0x8e9510080005ad75b2cabc54baf019ca6139931ef277d369842696a313529298)
  (`FEEDBACK.md:10-24`, `docs/SPIKE_REPORT.md:36-48`).

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
[threat model § what remains trusted](THREAT_MODEL.md#what-remains-trusted)).

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
never write the same JSONL file concurrently
([runbook § reconcile without a wallet](docs/RUNBOOK.md#reconcile-without-a-wallet)).

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

Budget roughly ten minutes on the public RPC: `verify:chain` and
`verify:completeness` take one to two minutes each, and `verify:all` re-checks
every evidence file in five to six.

`verify:completeness` scans the legacy production emitter from block
`471035786` and the ledger-head emitter from its deployment block `471812148`.
The earlier range `471035563..471035785` contains ten synthetic gas-benchmark
roots with leaf counts 1 through 10; no forecast preimages were created for
them, so the default production audit excludes that closed range. Set
`COMPLETENESS_FROM_BLOCK=471035563` to inspect it explicitly
([runbook § completeness scope](docs/RUNBOOK.md#completeness-scope),
`scripts/verify-completeness.ts:27-54,156-194`).

The command compares every production root and leaf count from the declared
submitter with the published ledger and reports undisclosed roots, duplicates,
leaf-count mismatches, overlapping disclosed windows and ledger roots missing
on-chain. A hidden legacy root exposes its leaf count but not its market IDs
(`scripts/verify-completeness.ts:136-194`).

One of those findings stopped being fatal on 29 August. A root anchored twice
by our own submitter, disclosed once in the ledger, with agreeing leaf counts
and with the ledger's own anchor among those transactions, is a resend after a
lost receipt, not a hidden root; it is published under
`completeness.accepted_duplicate_anchors` with both transaction hashes instead
of blocking the hourly publication. Every other duplicate still fails, and
`COMPLETENESS_STRICT_DUPLICATES=1` restores the original gate for an auditor
who disagrees ([threat model § the same root was anchored
twice](THREAT_MODEL.md#the-same-root-was-anchored-twice),
`scripts/completeness-policy.ts`).

To see the scored record rendered, run the dashboard. It is a static page over
the same `dashboard/app/forecast-data.json` snapshot that the verifiers audit:

```bash
cd dashboard
npm ci
npm run dev   # serves the dashboard on http://localhost:3000
```

The frozen bytes are documented in the
[`record format`](docs/RECORD_FORMAT.md). Recovery, watchdog and publisher
procedures live in the [`operations runbook`](docs/RUNBOOK.md). The measured
registry/emitter comparison is in the [`gas budget`](docs/GAS_BUDGET.md), and
the remaining trust assumptions are in the [`threat model`](THREAT_MODEL.md).
The full Shannon trading lifecycle remains in the
[`testnet spike`](docs/SPIKE_REPORT.md).

## Sources

- Snapshot: the newest `Publish recorder snapshot` commit on `main` (the
  publisher pushes hourly);
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
- Live trading spike: [`docs/SPIKE_REPORT.md`](docs/SPIKE_REPORT.md); transactions
  `0x8e9510080005ad75b2cabc54baf019ca6139931ef277d369842696a313529298`
  and `0x2674d74c10432436b4374bbbb23aa9f839a3912a97302284d1a43726968337b9`.
- DreamDEX SDK findings: pinned upstream commit
  `dccd2fdbf5e59316a5e9209546707b91b5f4cd7d`;
  [`FEEDBACK.md`](FEEDBACK.md); issues #20/#22; PR #21.

Licensed under the [MIT License](LICENSE).
