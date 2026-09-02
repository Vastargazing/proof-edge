# 2026-08-28: the price feed froze while the recorder kept heartbeating

The recorder kept running. The price feed did not: it stopped advancing for
54 minutes, and four consecutive fifteen-minute windows ended without a
commitment. The feed recovered on its own. I did not backfill the gap, alter
the ledger or change `model_hash`.

## Timeline (UTC; the host journal is UTC+3)

- 14:45:15–14:45:22 — last normal window. Four forecasts were recorded for
  the ETH and BTC 300 s and 900 s markets (`…c06a`, `…c069`, `…c068`,
  `…c067`). They were anchored as a four-leaf batch at 14:45:26 in
  `0x7618e68849ed29660050f5b2090c45bcd5f196f72cc02c94cf2d912b6b234696`.
- 14:49:55 — last `spot_observed` before the gap. From here every poll got the
  same oracle sample from the Somnia price feed. The store deduplicates spots
  by `oracle_observed_at_ms`, so it appended nothing new.
- 15:00:17 — the hourly markets expiring at 16:00, `…c090` and `…c08f`, were
  skipped with `momentum_unavailable`: the spot was older than the 15-second
  freshness limit. Later polls reached the same result, but skips are
  deduplicated by market and reason, so the ledger contains only one line per
  market.
- 15:00–15:45 — four consecutive fifteen-minute buckets with zero
  `forecast_observed`, compared with 8–10 per bucket earlier that day. That
  suggests roughly 34 forecasts were missed. Heartbeats continued every
  minute and the unit stayed `active`.
- 15:14–15:35 — watchdog ticks two to four reported `no_new_forecast_windows`
  and `no_new_anchors`; `proof-edge-watchdog-alert` fired on each.
- 15:37 — my checks were inconclusive. The price feed, indexer and RPC all
  returned HTTP 200, and the recorder still held three TLS connections. The
  journal showed only heartbeats.
- 15:44:47 — first fresh `spot_observed` after 54 minutes. The feed recovered
  on its own.
- 15:45:59–15:46:00 — the running process re-evaluated `…c090` and `…c08f`
  and skipped them again while measured volatility warmed up.
- 15:51:55 — I restarted the recorder, assuming the loop had hung.
  That diagnosis was wrong: the feed had recovered seven minutes earlier.
  `ExecStartPre` printed `MODEL_HASH_OK` for `0x253a60a7…`; the new process
  started from the pinned clone and restored 44 spot samples.
- 16:00:23 — first `recorded` after the restart: ETH 14400 s market `…c122`,
  with zero skips since the restart. By 16:00:31 the window held four
  forecasts, all for hourly and four-hour markets. No five- or fifteen-minute
  market was listed. The four-leaf batch was anchored at 16:00:40 in
  `0xbdd56f34f74509fc66ff3e21e7dee5b6d6883d63d85ce7d911ce77bcc2c8a616`.

## What the bytes establish

- The recorder did not crash, stop or restart between 05:47 and 15:51. The
  heartbeat is written from inside the poll loop, so the loop was iterating
  the whole time.
- There is no `spot_observed` between 14:49:55 and 15:44:47. The skip reason
  was `momentum_unavailable`, not `missing_spot`, so the SDK returned a
  non-null spot on every poll. The ledger cannot reveal whether the feed
  served a frozen sample or mapped an error to the last value.
- At 15:55 market discovery listed only hourly, four-hour and daily markets;
  the five- and fifteen-minute series were absent during the gap. I did not
  establish whether that was related to the feed outage.
- The watchdog alerted on missing forecast windows and anchors, while the
  heartbeat remained fresh. That was the limitation that mattered: process
  liveness did not imply fresh inputs.

## What I changed

- `scripts/watchdog.ts` now reads `heartbeat_age_s` and `last_spot_age_s` from
  the ledger. It distinguishes a stalled recorder from a recorder that is
  alive but receiving stale inputs.
- Only `recorder_stalled` triggers an automatic restart. Restarts still go
  through the recorder unit and its `ExecStartPre` hash check, are limited to
  two attempts per episode with a three-tick grace period, and are journaled
  as `WATCHDOG_RESTART`. `inputs_stale` raises an alert without restarting the
  process.
- `docs/RUNBOOK.md` describes the frozen-feed signature and says not to
  restart for it.

## What I did not change

- `src/` and the pinned upstream. A feed read inside the poll loop can still
  block without a timeout, although this episode did not exercise that path.
  Adding the timeout before 8 September would rotate `model_hash` and split
  the sample. The automatic restart mitigates a hung loop; it does not fix the
  underlying limitation.
- The ledger. The gap is visible as missing windows and as `forecast_skipped`
  events; nothing was backfilled.
