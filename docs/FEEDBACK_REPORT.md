# DreamDEX Event Contracts developer feedback

Date observed: 2026-08-25

Network: Somnia Shannon testnet (`50312`)

Upstream commit: `dccd2fdbf5e59316a5e9209546707b91b5f4cd7d`

Markets SDK: `@somnia-chain/markets-sdk@0.28.1`

Runtime: Node.js `v22.22.1`

OS: Ubuntu 26.04 (`Linux 7.0.0-30-generic x86_64`)

Two things broke for us during the read-only preflight. Neither blocked the
lifecycle, but both cost us time before we could trust the tool.

## 1. Venue inference produces two different operator messages

### Reproduction

1. Configure `NETWORK=testnet` and leave both `VENUE_ID` and `OPERATOR_ID`
   unset.
2. Run `npm run ec:doctor` while active binary markets span more than one
   venue.
3. Observe venue inference output followed by a multi-venue failure asking for
   an explicit venue.

### Actual result

The preflight first suggests that it can infer a venue, then terminates because
the complete active market set is ambiguous. The two messages describe
different effective scopes, so a new integrator cannot tell whether the tool
has selected a safe venue.

### Expected result

The doctor should make one deterministic choice:

- preserve the inferred scope for every subsequent query; or
- fail before printing an inferred venue, with one actionable message that
  includes the discovered venue IDs and the exact `VENUE_ID` setting to add.

### Workaround

Set `VENUE_ID` explicitly from the intended live market row. ProofEdge uses:

```text
VENUE_ID=0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c
```

## 2. Wallet balance check reads a missing `publicClient`

### Reproduction

1. Configure `NETWORK=testnet`, an explicit `VENUE_ID`, and a valid funded
   `PRIVATE_KEY`.
2. Run `npm run ec:doctor`.
3. The doctor creates the exchange with `createExchange({ withSigner: false })`.
4. `printWallet` reads `ctx.exchange.client.publicClient.getBalance(...)`.

### Actual result

The observed client shape did not expose `publicClient`, and the read-only
doctor crashed with:

```text
Cannot read properties of undefined (reading 'getBalance')
```

### Expected result

Providing a private key should add wallet balance diagnostics without changing
the doctor's read-only behavior or causing it to crash.

### Suggested fix

Use the SDK's supported client accessor, consistent with the order path:

```ts
const native = await ctx.exchange.client.getViemClient().getBalance({ address: addr });
```

Alternatively, expose a stable public client accessor from `createExchange`
and use it consistently across the kit.

### Workaround

Run `ec:doctor` without wallet keys for venue and market diagnostics, then
inspect wallet balances separately through the supported viem client.

## 3. DX suggestion: move the documented guardrails into code

This was not a third bug report. The kit documented all three behaviors:

- an SDK write can resolve with a reverted receipt, so callers need
  `assertTxOk`;
- `amountToPrecision` can collapse a positive binary size to zero, so callers
  need `quantize`;
- `loadMarkets()` does not return finalized binary markets, so claim scans need
  `listBinaryMarkets({ status: "Finalized" })`.

The exact paths are visible in
[`exchange.ts:61`](../vendor/dreamdex-bot-kit/packages/ec-core/src/exchange.ts#L61),
[`markets.ts:173`](../vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L173),
and
[`markets.ts:208`](../vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L208).
We read those notes and still had to carry three separate protections into the
integration.

The safer behavior could be the default:

- write helpers could throw when `receipt.status === "reverted"`, with an
  explicit unchecked variant for callers that need it;
- binary amount precision could use the venue lot grid, or at least reject a
  positive input that becomes zero;
- the SDK could expose a first-class settled/claimable market query instead of
  making claim code know the separate `Finalized` list path.

The docs were enough to recover. Moving these checks into the API would make it
harder to ship an integration that looked healthy while doing nothing.

## Validation context

After applying the workarounds, the same environment completed:

```text
tUSDC faucet -> approve -> mintSet -> IOC fill -> on-chain resolution -> redeem
```

The full transaction evidence and timings are documented in
[`../SPIKE_REPORT.md`](../SPIKE_REPORT.md).
