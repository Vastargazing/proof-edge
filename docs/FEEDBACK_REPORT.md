# DreamDEX Event Contracts developer feedback

Date observed: 2026-08-25

Network: Somnia Shannon testnet (`50312`)

Upstream commit: `dccd2fdbf5e59316a5e9209546707b91b5f4cd7d`

This report contains two reproducible developer-experience issues encountered
while validating the complete Event Contracts lifecycle. Neither issue blocked
the final mint, IOC fill, resolution, or redemption flow, but both make the
read-only preflight harder to use as the first debugging tool.

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

## Validation context

After applying the workarounds, the same environment completed:

```text
tUSDC faucet -> approve -> mintSet -> IOC fill -> on-chain resolution -> redeem
```

The full transaction evidence and timings are documented in
[`../SPIKE_REPORT.md`](../SPIKE_REPORT.md).
