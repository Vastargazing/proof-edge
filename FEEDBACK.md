# DreamDEX Event Contracts integration findings

These findings were reproduced on Somnia Shannon while integrating the
Event Contracts path. They apply to the pinned checkout below, not necessarily
to a later SDK release.

| Component | Version |
| --- | --- |
| Network | Somnia Shannon testnet, chain ID `50312` |
| `dreamdex-bot-kit` | `dccd2fdbf5e59316a5e9209546707b91b5f4cd7d` |
| `@somnia-chain/markets-sdk` | `0.28.1` |
| Node.js | `v22.22.1` |
| Host | Ubuntu 26.04, Linux `7.0.0-30-generic` x86_64 |
| Initial lifecycle run | 2026-08-25 |

No production or mainnet funds were used. The complete testnet lifecycle and
transaction hashes are retained in
[`docs/SPIKE_REPORT.md`](docs/SPIKE_REPORT.md).

## Filed upstream

### 1. `ec:doctor` reads a missing `publicClient`

Upstream: [issue #20](https://github.com/somnia-chain/dreamdex-bot-kit/issues/20)
and [PR #21](https://github.com/somnia-chain/dreamdex-bot-kit/pull/21).

#### Reproduction

1. Set `NETWORK=testnet`.
2. Set an explicit `VENUE_ID`.
3. Set any syntactically valid dummy `PRIVATE_KEY`. It does not need funds;
   the exception occurs before the balance RPC call.
4. Run `npm run ec:doctor`.

#### Actual

```text
TypeError: Cannot read properties of undefined (reading 'getBalance')
    at printWallet (.../scripts/ec-doctor.ts:58:27)
```

The pinned doctor creates a read-only exchange, then accesses
`ctx.exchange.client.publicClient` at
[`ec-doctor.ts:57-58`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/scripts/ec-doctor.ts#L57-L58).
The observed client exposes the viem client through `getViemClient()`; the
same accessor is already used by the order path at
[`orders.ts:219`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/orders.ts#L219).

#### Expected

Providing a key should add wallet diagnostics without changing the doctor's
read-only behavior or causing it to stop.

#### Workaround and proposed fix

We ran the doctor without a key and checked the balance separately. PR #21
replaces the missing property with:

```ts
const pc = ctx.exchange.client.getViemClient();
const native = await pc.getBalance({ address: addr });
```

The PR reports `npm run typecheck`, `npm run check` with 10 passing tests,
and a Shannon run where the balance printed and scoped market listing
continued. As checked on 2026-08-28, issue #20 and PR #21 were still open; the
PR was awaiting the required review. This repository therefore describes the
change as proposed, not released.

### 2. `ec:doctor` discards its inferred venue on a later read

Upstream: [issue #22](https://github.com/somnia-chain/dreamdex-bot-kit/issues/22).

#### Reproduction

1. Set `NETWORK=testnet`.
2. Leave both `VENUE_ID` and `OPERATOR_ID` unset.
3. Run `npm run ec:doctor` while active binary markets span more than one
   venue.

#### Actual

The observed run first printed an inferred venue with 12 scoped active markets:

```text
venue     : 0x1a1e6821… · source=inferred · scoped active=12
```

It then called `activeMarkets` without the inferred scope and stopped on two
venues:

```text
Live markets span 2 venues:
0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f (operatorId 4),
0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c (operatorId 2).
Set VENUE_ID (or OPERATOR_ID) in .env to scope to the DreamDEX venue.
```

The later call is unscoped at
[`ec-doctor.ts:101`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/scripts/ec-doctor.ts#L101);
the guard that rejects multiple venues is at
[`markets.ts:82-96`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/markets.ts#L82-L96).

#### Expected

Either preserve the inferred scope for every subsequent read, or stop before
printing a selected venue and emit one message containing the available IDs
and the exact configuration field to set. We do not know which behavior the
maintainers intend, so issue #22 proposes no patch.

#### Workaround

We read the venue ID from the intended live market row and set `VENUE_ID`
explicitly. The recorder requires the same explicit lowercase bytes32 at
startup (`src/live-recorder.ts:36-61`).

As checked on 2026-08-28, issue #22 was open with no maintainer comments.

## Additional reproducible integration findings

### 3. A resolved write promise does not imply a successful receipt

The Event Contracts write helpers can resolve with `{ hash, receipt }` when
`receipt.status === "reverted"`. The pinned kit documents the behavior and
provides `assertTxOk` at
[`exchange.ts:60-73`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/exchange.ts#L60-L73).
The EC wrappers invoke it after place, mint, cancel and redeem
([`orders.ts:128-146`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/orders.ts#L128-L146),
[`inventory.ts:49-62`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/inventory.ts#L49-L62),
[`orders.ts:329-333`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/orders.ts#L329-L333),
[`settlement.ts:140-153`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/settlement.ts#L140-L153)).

We encountered this behavior during the spike, but did not retain the reverted
transaction hash or its raw log. The successful guarded IOC transaction
[`0x8e95…9298`](https://shannon-explorer.somnia.network/tx/0x8e9510080005ad75b2cabc54baf019ca6139931ef277d369842696a313529298)
proves the checked write path completed; it does not prove the earlier revert.

Maintainer-facing change: make each SDK write reject when its receipt is
reverted, or expose one checked write primitive so callers cannot accidentally
forget the status test.

### 4. Binary quantity precision and order expiry need separate handling

`amountToPrecision` has no binary `lotSize` to read and can floor a fractional
share to zero. The pinned `quantize` implementation records the concrete
testnet case: `amountToPrecision(0.5)` became `0`, while the venue accepted
orders down to one raw unit
([`markets.ts:165-205`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/markets.ts#L165-L205)).

Every order also needs a future `expireTimestampNs`. Our wrapper snaps size to
the configured lot grid, caps expiry at the market expiry, skips an already
expired order and converts seconds to nanoseconds
([`orders.ts:100-139`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/orders.ts#L100-L139)).

Maintainer-facing change: provide a binary-market size helper and a required
typed expiry builder in the public order API. Those are separate checks; fixing
quantity rounding does not make a missing expiry valid.

### 5. Indexed activity is not the write authority

We observed the indexed status lag the on-chain state that accepted orders. The
pinned helper treats only `onchain.status === Trading` as tradable
([`markets.ts:130-147`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/markets.ts#L130-L147)).
The recorder likewise reads `isResolved` and `isVoided` from the on-chain
market before revealing or scoring (`src/live-recorder.ts:310-319`).

Maintainer-facing change: expose an API named around authoritative on-chain
tradability instead of requiring callers to distinguish indexed `active` from
contract `status`.

### 6. Finalized markets require the binary-market endpoint

`loadMarkets()` omits finalized binary markets, so filtering it for inactive
rows cannot drive a claim sweep. The pinned helper explains the registry
behavior and queries
`listBinaryMarkets({ venueId, status: "Finalized" })`
([`markets.ts:208-255`](https://github.com/somnia-chain/dreamdex-bot-kit/blob/dccd2fdbf5e59316a5e9209546707b91b5f4cd7d/packages/ec-core/src/markets.ts#L208-L255)).
The separate path checked on-chain resolution and balances, then redeemed one
NO outcome in
[`0x2674…37b9`](https://shannon-explorer.somnia.network/tx/0x2674d74c10432436b4374bbbb23aa9f839a3912a97302284d1a43726968337b9).

Maintainer-facing change: a first-class
`listClaimableMarkets(account, venueId)` would expose the full lifecycle
without requiring users to combine indexed finalized rows, on-chain state and
outcome-token balances themselves.
