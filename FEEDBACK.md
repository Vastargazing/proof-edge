# What surprised us in the DreamDEX SDK

Observed on Somnia Shannon testnet (`50312`) on 2026-08-25. The pinned
`dreamdex-bot-kit` commit was
`dccd2fdbf5e59316a5e9209546707b91b5f4cd7d`.

Markets SDK: `@somnia-chain/markets-sdk@0.28.1`. Runtime: Node.js `v22.22.1`.
OS: Ubuntu 26.04 (`Linux 7.0.0-30-generic x86_64`).

- An SDK write could resolve even when its receipt said `reverted`. We hit this
  in the EC path and kept the guard at
  [`exchange.ts:69`](vendor/dreamdex-bot-kit/packages/ec-core/src/exchange.ts#L69),
  then called it after order placement
  ([`orders.ts:146`](vendor/dreamdex-bot-kit/packages/ec-core/src/orders.ts#L146)),
  mint
  ([`inventory.ts:62`](vendor/dreamdex-bot-kit/packages/ec-core/src/inventory.ts#L62)),
  cancel
  ([`orders.ts:332`](vendor/dreamdex-bot-kit/packages/ec-core/src/orders.ts#L332)),
  and redeem
  ([`settlement.ts:153`](vendor/dreamdex-bot-kit/packages/ec-core/src/settlement.ts#L153)).
  We wrapped these writes with `assertTxOk`; the guarded IOC path completed in
  [`0x8e95…9298`](https://shannon-explorer.somnia.network/tx/0x8e9510080005ad75b2cabc54baf019ca6139931ef277d369842696a313529298).
  DX would be clearer if every SDK write rejected its promise when
  `receipt.status === "reverted"`, or exposed one checked write wrapper.

- `amountToPrecision` rounded binary sizes to whole shares, and an order also
  needed a future `expireTimestampNs`. We recorded the binary-size behavior and
  the `quantize` replacement at
  [`markets.ts:173`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L173).
  Our order wrapper capped expiry to the market, skipped an already expired
  order, and sent the timestamp in nanoseconds at
  [`orders.ts:118`](vendor/dreamdex-bot-kit/packages/ec-core/src/orders.ts#L118).
  We used `quantize` and built expiry for every order. A binary-aware precision
  helper plus a required typed expiry builder would remove both traps.

- The deployment manifest was not a safe source for `venueId`; live markets could
  span more than one venue. The kit itself documented this at
  [`markets.ts:55`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L55),
  and our first doctor run reached the multi-venue guard at
  [`markets.ts:85`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L85).
  We read the ID from the intended live row and made it mandatory at startup in
    [`live-recorder.ts:52`](src/live-recorder.ts#L52). A venue discovery command
  that printed copy-ready IDs with market counts would make this setup less
  guessy.

- The indexer status lagged the state that accepted orders on-chain. We kept the
  actual write gate as `onchain.status === Trading` at
  [`markets.ts:145`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L145),
  and the recorder waited for the on-chain `isResolved` or `isVoided` flags at
    [`live-recorder.ts:272`](src/live-recorder.ts#L272). We fetched one on-chain
  snapshot before acting. An SDK method named around authoritative tradability
  would be harder to misuse than mixing indexed `active` and on-chain `status`.

- Finalized binary markets disappeared from `loadMarkets()`, so that list could
  not drive claims. The exact reason and terminal status are in
  [`markets.ts:208`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L208),
  and our sweep used `listBinaryMarkets({ status: "Finalized" })` at
  [`markets.ts:247`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L247).
  We kept a separate claim scan, checked on-chain resolution and balances, then
  redeemed in
  [`0x2674…37b9`](https://shannon-explorer.somnia.network/tx/0x2674d74c10432436b4374bbbb23aa9f839a3912a97302284d1a43726968337b9).
  A first-class `listClaimableMarkets(account, venueId)` would make this lifecycle
  visible from one API.

- `ec:doctor` printed an inferred venue, then called `activeMarkets` without
  preserving that scope and failed on the same multi-venue set. `resolveVenue`
  returned the first live venue at
  [`markets.ts:107`](vendor/dreamdex-bot-kit/packages/ec-core/src/markets.ts#L107),
  while the later call was still unscoped at
  [`ec-doctor.ts:101`](vendor/dreamdex-bot-kit/scripts/ec-doctor.ts#L101). The
  observed sequence is recorded in [`SPIKE_REPORT.md:138`](SPIKE_REPORT.md#L138).
  We set `VENUE_ID` from a live row. The doctor should either reuse its resolved
  scope for every read or fail once before printing a selected venue. Filed as
  [somnia-chain/dreamdex-bot-kit#22](https://github.com/somnia-chain/dreamdex-bot-kit/issues/22).

- `ec:doctor` created a read-only exchange but tried to read native balance from
  `client.publicClient`, which was missing on the observed client shape. The
  access was at
  [`ec-doctor.ts:57`](vendor/dreamdex-bot-kit/scripts/ec-doctor.ts#L57), and our
  recorded error was `Cannot read properties of undefined (reading
  'getBalance')` at [`SPIKE_REPORT.md:141`](SPIKE_REPORT.md#L141). We ran the
  doctor without keys and read balances through the supported viem client. The
  doctor could use `client.getViemClient()` as the order path already did at
  [`orders.ts:219`](vendor/dreamdex-bot-kit/packages/ec-core/src/orders.ts#L219).
  Filed as
  [somnia-chain/dreamdex-bot-kit#20](https://github.com/somnia-chain/dreamdex-bot-kit/issues/20)
  and fixed in [PR #21](https://github.com/somnia-chain/dreamdex-bot-kit/pull/21),
  verified on Shannon with `markets-sdk@0.28.1`.
