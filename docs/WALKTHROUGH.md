# One forecast, end to end

The door-2 command in the README (`npm run verify -- evidence/0x…9617-…json`) follows BTC market `0x…9617` through every layer:

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
[`0x…9617` evidence file](../evidence/0x0000000000000000000000000000000000000000000000000000000000009617-1787677626190000000.json); the verifier independently reloads the transaction,
expiry and outcome instead of trusting the prose.

Each numbered step is a single check in the verifier's output, in the same
order: `PASS 1/5` rebuilds the bytes and commitment of step 2, `PASS 2/5` walks
the proof of step 3, `PASS 3/5` decodes the anchoring transaction, `PASS 4/5`
reads the market and outcome of step 4 from the chain, and `PASS 5/5` compares
the anchor timestamp with the expiry (`src/evidence-verifier.ts:120-193`). The
field-by-field layout of the file is in [`RECORD_FORMAT.md`](RECORD_FORMAT.md).

`npm run check` on the same snapshot compiled the TypeScript and passed the
whole suite. Those tests included one-digit probability
tampering, a foreign anchor transaction, an on-chain outcome mismatch, late
anchoring, deletion and rechaining of an earlier batch, restart recovery after
`SIGKILL`, and the retained ledger incident (`test/evidence-verifier.test.ts`,
`test/chain-verifier.test.ts:23-36`, `test/store-lock.test.ts:10-46`,
`test/store.test.ts:47-112`).
