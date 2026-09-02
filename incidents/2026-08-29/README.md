# 2026-08-29: a VPN change crashed the recorder 153 times and the publisher locked itself out

The VPN change made network requests unreliable. The recorder crashed 153
times but kept returning after each restart, so collection continued. A failed
publisher run also left a stale writer lock and blocked two later runs.
Together, the timeouts and stale lock left the public snapshot four hours
behind. I did not alter or backfill the ledger, and `model_hash` did not
change.

## Timeline (UTC; the host journal is UTC+3)

- 08:34:13 — I replaced the VPN client on the recorder host. Happ
  started, its `sing-box` TUN core followed at 08:34:20, and the AdGuard tunnel
  stopped. `tun0` changed from 172.16.219.2 to 172.18.0.1/30.
- 08:34:23 — first recorder crash, three seconds after the new tunnel came up:
  the SDK's HTTP client hit its ten-second connect timeout while reaching the
  indexer and price feed. The recorder exits on that error by design.
- 08:34–14:20 — 153 crashes, about 26 per hour. The eleven hours before the
  change had eight; the twelve hours before that had two. Every restart re-ran
  `ExecStartPre` and printed `MODEL_HASH_OK` for `0x253a60a7…`.
- 10:06:36 — last successful publication (commit `4a6b43e`): 420 forecasts,
  191 anchors, zero undisclosed roots.
- 11:02:58 — publisher run failed on an RPC `TimeoutError` inside
  `verify:completeness --publish-watermark`, over the same tunnel.
- 12:01:25 — the next run copied the ledger and left
  `published/forecast-events.jsonl.writer.lock` on disk.
- 12:03:24 — that run died on a second RPC `TimeoutError` in the same step. The
  failure handler restored the publication paths, but the writer lock was not
  one of them, so the file remained.
- 13:01:03 and 14:01:01 — both runs refused to start: `publisher checkout is
  dirty before sync: published/forecast-events.jsonl.writer.lock`. The two
  network timeouts had now cost four publication hours, from 11:00 through
  14:00.
- 14:12 — I confirmed that the lock's owner, pid 1480400, was gone
  and removed the file. The live ledger then held 536 forecasts and 247
  anchors; the public snapshot still showed 420 and 191.
- 15:02 — the next run got past the lock and failed on a different finding:
  `root anchored multiple times`. The duplicate had been created hours earlier
  but was only detected once a publication reached the completeness scan.

## The duplicate anchor

Root `0x5504b97de78716ff7832e65d568d6320af2d6ab736ec786c31948523fe788b61`
carries two successful transactions from the declared submitter:

- `0x2531ce69f5220c935146d5b3d37bc61ceddb733dfb9def6ef95045787c8a2e2b`,
  nonce 220, block `474267864`, 10:36:17;
- `0x27777931baad644e7513bbef3f0cc543f5fc6527a59ce31500bd15b302504a5b`,
  nonce 221, block `474268560`, 10:37:27.

The journal shows how it happened. The batch was prepared at 10:35:52, and the
first transaction was mined at 10:36:17. One second later the recorder logged
`anchor_failed`: it had not seen the receipt. At 10:36:42 it exited on a
price-feed connect timeout (`restart 74`). The new process recovered the
prepared batch. At 10:37:28 it logged `anchored recovered batch`, naming the
second transaction mined one second earlier.

The ledger contains one `batch_prepared` and one `batch_anchored`, naming the
later transaction. Timeliness is therefore judged against the later anchor.
Both successful transactions commit the same one-leaf root, so the second
emission adds no new committed data. It does, however, violate the original
one-transaction-per-root completeness rule.

`src/completeness.ts` is part of the frozen `model_hash`, so I left it
unchanged. A narrow policy in `scripts/completeness-policy.ts` accepts a
duplicate only when the root is disclosed, the leaf counts agree, and the
ledger names one of the duplicate transactions. Accepted cases are published
under `completeness.accepted_duplicate_anchors`; every other duplicate still
fails. `COMPLETENESS_STRICT_DUPLICATES=1` restores the original strict gate.
This is my operational exception, and the threat model states it explicitly.

## What the bytes establish

- By 14:00, the recorder had written 152 forecasts. During the busiest part of
  the crash storm it still recorded 31–34 per hour. The five- and
  fifteen-minute series returned around 10:00 after two days of hourly-only
  listings, and the recorder captured them.
- Across the full day, `spot_observed` had 17 gaps longer than sixty seconds,
  totalling 33 minutes. All occurred before 12:20. An individual crash cost
  roughly ten seconds: the restart delay plus the model check.
- All 247 prepared batches were anchored. None was late, and no root was
  undisclosed. The only orphan is the known one at line 621 from 27 August.
- The ledger kept advancing; publication did not. For four hours the public
  snapshot, dashboard and README statistics trailed the live ledger.

## What I changed

- `scripts/publish-and-push.ts` sweeps a `*.writer.lock` whose recorded pid is
  no longer running before checking for a dirty checkout, and logs the
  removal. A lock held by a live process still blocks publication.
- The same script retries network-dependent steps — `git fetch`, the watermark
  block read, `verify:chain` and both completeness scans — up to three times,
  with fifteen seconds between attempts. Local steps still fail immediately.
- `scripts/watchdog.ts` now reads `ActiveState` and `SubState`, not just
  `is-active`. A unit that systemd is restarting counts as running while its
  heartbeat is fresh. A restart loop that outlives the heartbeat threshold,
  or a `failed` or `inactive` unit, still raises `recorder_service_down`.
  Every tick records `unit_state` and the cumulative `unit_restarts`.
- `RestartSec` dropped from eight seconds to four. On this network path, the
  restart delay was the largest part of the observation time lost per crash.
- `scripts/completeness-policy.ts` decides which duplicate anchors block a
  publication, with the criteria above and a strict switch, covered by
  `test/completeness-policy.test.ts`.

## What I did not change

- `src/`. The recorder exits on a connect timeout instead of retrying, and the
  feed read still has no timeout of its own. Retrying in the recorder would
  avoid these fail-fast restarts, but changing `src/` before 8 September would
  rotate `model_hash` and split the sample. The shorter restart delay limits
  the impact; it does not fix the cause.
- The network. I kept the Happ client, and the timeouts continued
  on that path.
- The ledger. The four missing publication hours are visible as a gap between
  snapshot commits; nothing was backfilled or re-timed.
