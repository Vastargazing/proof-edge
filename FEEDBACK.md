# What I learned integrating DreamDEX Event Contracts

I expected the hard part to be the trading lifecycle. It was not. On Somnia
Shannon I could fund a wallet, mint a complete set, place and fill an IOC order,
wait for resolution, and redeem the winning outcome. The full path worked.

What cost me time was working out which DreamDEX surface to trust at each step.
The doctor could contradict itself, an SDK write could resolve with a reverted
receipt, indexed state could lag the contract, and the live-market endpoint
could not find markets that were ready to claim.

I did not keep a stopwatch. The transaction and commit trail brackets about six
hours of work across two sessions. That is elapsed integration time, not six
hours of pure debugging. I cannot honestly separate normal implementation from
avoidable delay after the fact; the detours cost hours, not minutes, mostly in
venue discovery, doctor failures, and separating indexer state from on-chain
authority.

The pattern that got me unstuck was simple: reproduce one lifecycle step on
testnet, pin the exact dependency versions, compare the indexed row with the
contract state, and then read the SDK call site. I kept the successful
transaction hashes and filed the two doctor bugs upstream.

| Component | Version |
| --- | --- |
| Network | Somnia Shannon testnet, chain ID `50312` |
| `dreamdex-bot-kit` | `dccd2fdbf5e59316a5e9209546707b91b5f4cd7d` |
| `@somnia-chain/markets-sdk` | `0.28.1` |
| Node.js | `v22.22.1` |
| Host | Ubuntu 26.04, Linux `7.0.0-30-generic` x86_64 |
| Initial lifecycle run | 2026-08-25 |

I used testnet funds only. The complete lifecycle and transaction hashes are in
[`docs/SPIKE_REPORT.md`](docs/SPIKE_REPORT.md).

## 1. Adding a key made `ec:doctor` crash

This was my first avoidable detour. On `NETWORK=testnet`, I gave `ec:doctor` an
explicit `VENUE_ID` and a syntactically valid `PRIVATE_KEY`, then ran
`npm run ec:doctor`. I expected the same read-only checks plus a wallet balance.
Instead it stopped before the balance RPC call:

```text
TypeError: Cannot read properties of undefined (reading 'getBalance')
    at printWallet (.../scripts/ec-doctor.ts:58:27)
```

I reduced it to a dummy key, which proved that funds and signing were not
involved. Then I followed the failing access. The pinned doctor reads
`ctx.exchange.client.publicClient` at
[`ec-doctor.ts:57-58`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/scripts/ec-doctor.ts#L57-L58),
but the observed client exposes the viem client through `getViemClient()`. The
order path already uses that accessor at
[`orders.ts:219`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/orders.ts#L219).

My workaround was to run the doctor without a key and check the balance
separately. I filed [issue #20](https://github.com/somnia-chain/dreamdex-bot-kit/issues/20)
and submitted [PR #21](https://github.com/somnia-chain/dreamdex-bot-kit/pull/21),
which switches the doctor to `getViemClient()`. The PR reported a passing
typecheck, ten tests, and a Shannon run that printed the balance and continued
market discovery. As checked on 2026-08-28, it was still awaiting review, so I
treat this as a proposed fix, not a released one.

## 2. The doctor inferred a venue, then forgot it

With `VENUE_ID` and `OPERATOR_ID` unset, the doctor first told me it had found a
venue with 12 active markets:

```text
venue     : 0x1a1e6821… · source=inferred · scoped active=12
```

It then stopped because live markets spanned two venues and asked me to set the
scope it had just inferred. That contradiction was the clue. The later
`activeMarkets` call at
[`ec-doctor.ts:101`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/scripts/ec-doctor.ts#L101)
does not reuse the inferred venue; the multi-venue guard is in
[`markets.ts:82-96`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/markets.ts#L82-L96).

I copied the venue ID from the intended live market row and made an explicit
lowercase bytes32 `VENUE_ID` mandatory for the recorder. I filed
[issue #22](https://github.com/somnia-chain/dreamdex-bot-kit/issues/22). I did
not propose a patch because I do not know whether maintainers want the doctor
to preserve the inferred scope or stop earlier with a copy-ready list of venue
IDs. As checked on 2026-08-28, the issue had no maintainer response.

## 3. A resolved write promise was not enough

The most dangerous surprise was that a write helper could resolve with
`{ hash, receipt }` even when `receipt.status === "reverted"`. If I had treated
promise resolution as success, the integration could have recorded a trade
that never happened.

I found the intended guard in `assertTxOk` at
[`exchange.ts:60-73`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/exchange.ts#L60-L73)
and kept it after place, mint, cancel, and redeem. The guarded IOC path completed
in [`0x8e95…9298`](https://shannon-explorer.somnia.network/tx/0x8e9510080005ad75b2cabc54baf019ca6139931ef277d369842696a313529298).
I did not retain the earlier reverted transaction hash, so I am not presenting
that earlier event as independently reproducible evidence.

I would make SDK writes reject on a reverted receipt, or expose one checked
write primitive that callers cannot accidentally skip.

## 4. Binary size and order expiry were two separate traps

I first treated order construction as one problem. It was really two.
`amountToPrecision(0.5)` became `0` because there was no binary `lotSize` to
read, even though the venue accepted an order down to one raw unit. I traced
that behavior through
[`markets.ts:165-205`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/markets.ts#L165-L205)
and used the binary `quantize` path instead.

Separately, every order needs a future `expireTimestampNs`. My wrapper snaps
size to the configured grid, caps expiry at the market expiry, skips an already
expired order, and converts seconds to nanoseconds
([`orders.ts:100-139`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/orders.ts#L100-L139)).

A binary-size helper and a typed expiry builder would remove both traps. Fixing
rounding alone does not make an order without a valid expiry safe.

## 5. The indexer was useful, but it was not write authority

During the live run I saw indexed activity lag the on-chain state that actually
accepted orders. I found this by comparing the same market across both paths,
not by retrying the indexed query. From then on I used
`onchain.status === Trading` as the write gate
([`markets.ts:130-147`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/markets.ts#L130-L147)).
In the recorder, I likewise check on-chain `isResolved` and `isVoided` before
reveal or scoring (`src/live-recorder.ts:310-319`).

I would expose this as an API named around authoritative on-chain tradability.
Making callers interpret indexed `active` beside contract `status` is easy to
get wrong.

## 6. Finalized markets disappeared from the live list

My first claim sweep filtered `loadMarkets()` for inactive rows. It found
nothing useful because finalized binary markets are omitted from that list. I
only found the complete path after following the registry behavior into
`listBinaryMarkets({ venueId, status: "Finalized" })`
([`markets.ts:208-255`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/markets.ts#L208-L255)).

I kept claims as a separate scan: query finalized markets, confirm on-chain
resolution, check outcome-token balances, then redeem. That path redeemed one
NO outcome in
[`0x2674…37b9`](https://shannon-explorer.somnia.network/tx/0x2674d74c10432436b4374bbbb23aa9f839a3912a97302284d1a43726968337b9).

A first-class `listClaimableMarkets(account, venueId)` would make the complete
lifecycle visible from one API.

## Bottom line

DreamDEX Event Contracts worked end to end. The integration cost came from the
gaps between surfaces: inferred versus applied scope, resolved promise versus
successful receipt, indexer state versus contract state, and live discovery
versus finalized discovery. Once I tested those boundaries directly, the
plumbing became predictable.
