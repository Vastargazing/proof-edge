# DreamDEX Event Contracts spike

Date: 2026-08-25  
Decision: **GO**

## Scope

Validate the minimum live Shannon testnet lifecycle before committing the
hackathon schedule:

1. discover an active DreamDEX Event Contract;
2. obtain test collateral and mint a complete set;
3. submit an IOC order through `ec-core/placeLimit`;
4. confirm a real fill and no stranded order;
5. observe on-chain resolution;
6. redeem the winning outcome.

The spike used upstream `somnia-chain/dreamdex-bot-kit` at commit
`dccd2fdbf5e59316a5e9209546707b91b5f4cd7d` in an isolated temporary checkout.
No private key was copied into this workspace.

## Environment

- Chain: Somnia Shannon testnet (`50312`)
- DreamDEX venue:
  `0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c`
- Test wallet: `0x2624F4553d622f0310c4a47D36aCFC1388dac365`
- Market: `BTC-0-25AUG26-1630/tUSDC`
- Instrument: binary BTC above/below its opening price
- Window: 15 minutes

## Result

The complete path succeeded.

| Event | UTC time | Result |
| --- | --- | --- |
| tUSDC faucet | 16:15:10 | Success |
| ERC-20 approval | 16:15:14 | Success |
| `mintSet(1)` | 16:15:15 | Success |
| IOC order/fill | 16:15:19 | Bought 1 YES; submitted near 0.421, filled at 0.419 |
| Market expiry | 16:30:00 | Scheduled expiry |
| On-chain resolution observed | 16:30:05.877 | NO won; about 5.9 s after expiry |
| Winning outcome redeemed | 16:30:10.676 | 1 NO -> approximately 1 tUSDC |

The write path from the first collateral faucet transaction to the confirmed
fill took 9 seconds. Resolution was visible about 5.9 seconds after expiry, and
redeem completed about 4.8 seconds later.

Final checks:

- open orders: `0`;
- collateral immediately after the fill: `9998.581 tUSDC`;
- collateral after redeem: `9999.581 tUSDC`;
- remaining gas balance: `0.985226152 STT`;
- realized result of the deliberately non-predictive test trade: `-0.419 tUSDC`;
- no mainnet funds were used.

The loss is expected and useful evidence: the spike tested plumbing, not edge.

## Transaction evidence

| Operation | Transaction | Gas used | Fee (STT) |
| --- | --- | ---: | ---: |
| tUSDC faucet | [`0x58b3...5889`](https://shannon-explorer.somnia.network/tx/0x58b3e72fecc285ea065a51c9d80eb17e35b330fb4da0dfd08d4693d06ad55889) | 253,138 | 0.001518828 |
| approve | [`0x178f...14c2`](https://shannon-explorer.somnia.network/tx/0x178fec78854f0b9dbf1076961f8b964280a2f4ee9036ff50001bf005a71f14c2) | 259,745 | 0.001558470 |
| mint set | [`0x1687...60f0`](https://shannon-explorer.somnia.network/tx/0x16870715ac63830e38e6d9827492263062775ec0f783400ff8e17bcd529860f0) | 587,605 | 0.003525630 |
| IOC fill | [`0x8e95...9298`](https://shannon-explorer.somnia.network/tx/0x8e9510080005ad75b2cabc54baf019ca6139931ef277d369842696a313529298) | 628,682 | 0.003772092 |
| set redeem operator | [`0x9724...d75`](https://shannon-explorer.somnia.network/tx/0x97243108ba493d91369391aed81e138021a1a25c5fd03ce2325afbfddd985d75) | 260,419 | 0.001562514 |
| redeem | [`0x2674...7b9`](https://shannon-explorer.somnia.network/tx/0x2674d74c10432436b4374bbbb23aa9f839a3912a97302284d1a43726968337b9) | 472,719 | 0.002836314 |

The IOC transaction transferred `0.421 tUSDC` into the pool, returned
`0.002 tUSDC`, and settled at the resting price of `0.419 tUSDC`.

## Observed cadence

The live venue exposed BTC and ETH markets at four cadences:

| Interval | Resolutions/day for BTC + ETH |
| --- | ---: |
| 15 minutes | 192 |
| 1 hour | 48 |
| 4 hours | 12 |
| 1 day | 2 |
| **Maximum total** | **254/day** |

A read of the 200 newest finalized rows confirmed repeated 15-minute and hourly
respawns. At continuous availability, the theoretical 14-day ceiling is about
3,556 resolved observations. Real sample size must be reported from collected
records rather than assumed from this ceiling.

Some rows reported `intervalSec=898` or `3598`, so code must use the actual
field and exact timestamps rather than infer cadence from labels.

## Important protocol findings

1. Event Contracts use the separate `ec-core` / `@somnia-chain/markets-sdk`
   path. The spot `placeOrder` migration is not the relevant integration path.
2. `assertTxOk` remains mandatory because an SDK write may resolve even if the
   receipt reverted.
3. Order sizes must use `quantize`; every order needs `expireTimestampNs`.
4. Trading decisions must gate on on-chain status, not the lagging indexer.
5. `VENUE_ID` must be explicit while multiple venues share the deployment.
6. Finalized markets must be queried through `listBinaryMarkets` and cannot be
   recovered from the live market list.
7. `strike=0` is intentional for the active up/down series. The settlement
   reference is the market's opening price, retrievable through
   `getOpeningPrices`; it is not a literal zero strike.

## Upstream implementation overlap

The upstream `ec-oracle-follow` strategy already implements much of the proposed
analytical estimator:

- opening-price reference resolution;
- underlying spot feed;
- measured volatility;
- time-to-expiry scaling;
- normal-CDF-style fair probability;
- edge and maximum-disagreement gates;
- position/exposure limits.

Therefore the probability formula alone is not a differentiated hackathon
project. It should be treated as baseline infrastructure. The original layer is:

- salted on-chain forecast commitments before resolution;
- versioned `model_hash` covering parameters and prompt/configuration;
- reveal and deterministic scoring after resolution;
- Brier score and skill score against a timestamped market baseline;
- all-event and risk-selected calibration views;
- risk-gated execution with an explicit kill-switch demonstration;
- PnL and adverse-selection metrics alongside calibration.

## Candidate feedback report items

Two reproducible developer-experience defects appeared during the spike:

1. With no `VENUE_ID`, `ec:doctor` first reports an inferred venue and then
   fails because active binary markets span two venues. The tool should either
   preserve the inferred scope or fail once with a single actionable message.
2. With `PRIVATE_KEY` present, `ec:doctor` creates the exchange with
   `withSigner: false` and then attempts `publicClient.getBalance`, but the
   observed client shape had no `publicClient`; the doctor crashed with
   `Cannot read properties of undefined (reading 'getBalance')`.

These belong in the optional hackathon feedback report.

## Go/no-go conclusion

**GO.** The testnet, SDK path, live books, fill lifecycle, settlement, and claim
all work within hackathon tolerances. The remaining schedule risk is no longer
DreamDEX plumbing. It is collecting an immutable forecast record early enough
and keeping the product scope constrained.

The first production task should be a 24/7 recorder, not the dashboard:

`market snapshot -> estimator -> salted commitment -> risk decision -> optional execution -> resolution -> reveal -> score`
