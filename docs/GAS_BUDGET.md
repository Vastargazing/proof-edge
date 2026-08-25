# Shannon anchor gas budget

Measured 2026-08-25 at 6 gwei effective gas price, ten transactions per variant.

| Variant | Mean gas | Mean STT/root | 14-day cost at 96 roots/day |
| --- | ---: | ---: | ---: |
| Stateful registry | 270,524 | 0.001623144 | 2.181505536 |
| Event-only emitter | 55,938 | 0.000335628 | 0.451084032 |

All ten samples in each set had identical gas. The event-only emitter is the
production choice. Its root transaction is about 79.3% cheaper than the
stateful registry and fits the funded wallet without another faucet request.

The upper bound assumes one root every 15 minutes for 14 complete days (1,344
roots). Actual roots may be lower, but the recorder must not delay a 15-minute
forecast past expiry merely to improve packing.

Merkle batching reduces the theoretical 3,556 individual observations to at
most 1,344 anchors. At one forecast per market ID, the average batch is about
2.65 leaves, so claiming a thousand-fold reduction would be incorrect.

Deployment gas is a one-time cost and excluded from the run budget:

- stateful registry: 5,165,207 gas;
- event-only emitter: 2,993,700 gas.
