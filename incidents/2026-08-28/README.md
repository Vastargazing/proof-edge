# 2026-08-28: the price feed froze while the recorder kept heartbeating

Status: recovered upstream without any action on our side. No ledger byte was
altered, no forecast was backfilled, `model_hash` did not change.

## Timeline (UTC; the host journal is UTC+3)

- 14:45:15–14:45:22 — last normal window. Four forecasts recorded (ETH and
  BTC 300 s and 900 s markets `…c06a`, `…c069`, `…c068`, `…c067`), a
  four-leaf batch prepared and anchored at 14:45:26 in
  `0x7618e68849ed29660050f5b2090c45bcd5f196f72cc02c94cf2d912b6b234696`.
- 14:49:55 — last `spot_observed` before the gap. From here every poll got the
  same oracle sample from the Somnia price feed; the store deduplicates spots
  by `oracle_observed_at_ms`, so nothing was appended.
- 15:00:17 — the hourly markets expiring at 16:00, `…c090` and `…c08f`, were
  skipped with `momentum_unavailable` (spot older than the fifteen-second
  freshness rule). Skips are deduplicated per market and reason, so no further
  skip line was written although every poll re-evaluated the same markets.
- 15:00–15:45 — four consecutive fifteen-minute buckets with zero
  `forecast_observed`, against 8–10 per bucket earlier that day: about 34
  forecasts left no commitment. Heartbeats continued every minute; the unit
  stayed `active`; PID 1263732 had been running since 05:47:17.
- 15:14–15:35 — watchdog ticks two to four reported `no_new_forecast_windows`
  and `no_new_anchors`; `proof-edge-watchdog-alert` fired on each.
- 15:37 — operator checks: price feed, indexer and RPC answered HTTP 200; the
  recorder held three established TLS connections; the journal held nothing
  but heartbeats.
- 15:44:47 — first fresh `spot_observed` after 54 minutes. The feed recovered
  on its own.
- 15:45:59–15:46:00 — the running process re-evaluated `…c090` and `…c08f`
  and skipped them again while measured volatility warmed up.
- 15:51:55 — operator restart, ordered on the wrong diagnosis of a hung loop.
  `ExecStartPre` printed `MODEL_HASH_OK` for `0x253a60a7…`; the new process
  started from the pinned clone and restored 44 spot samples. The feed had
  recovered seven minutes earlier.
- 16:00:23 — first `recorded` after the restart: ETH 14400 s market `…c122`,
  `p_agent=0.1827`, `p_market=0.4945`, zero skips since the restart. By
  16:00:31 the window held four forecasts (hourly and four-hour markets only;
  no five- or fifteen-minute market was listed), and the four-leaf batch was
  anchored at 16:00:40 in
  `0xbdd56f34f74509fc66ff3e21e7dee5b6d6883d63d85ce7d911ce77bcc2c8a616`.

## What the bytes establish

- The recorder did not crash, stop or restart between 05:47 and 15:51. The
  heartbeat is written from inside the poll loop, so the loop was iterating
  the whole time.
- No `spot_observed` between 14:49:55 and 15:44:47. The skip reason was
  `momentum_unavailable`, not `missing_spot`, so the SDK returned a non-null
  spot on every poll; whether the feed served a frozen sample or an error
  mapped to the last value cannot be told from our ledger.
- At 15:55 market discovery listed only hourly, four-hour and daily markets;
  the five- and fifteen-minute series were absent during the gap. We did not
  establish whether that was related to the feed outage.
- The watchdog raised the alert it was built to raise. The heartbeat caveat in
  the threat model held in the other direction: a live heartbeat did not mean
  live inputs.

## What we changed

- `scripts/watchdog.ts` now reads `heartbeat_age_s` and `last_spot_age_s` from
  the ledger and separates `recorder_stalled` (live unit, heartbeat older than
  fifteen minutes) from `inputs_stale` (fresh heartbeat, spot older than
  fifteen minutes). Only a stalled loop is restarted automatically, through
  the recorder unit so `ExecStartPre` still refuses a drifted tree, at most
  twice per episode with a three-tick grace period; every attempt is journaled
  as `WATCHDOG_RESTART` and raises the alert unit.
- `docs/RUNBOOK.md` describes the frozen-feed signature and says not to
  restart for it.

## What we did not change

- `src/` and the pinned upstream. A feed read inside the poll loop that could
  block without a timeout remains possible in principle; this episode did not
  exercise it. Fixing it before 8 September would rotate `model_hash` and split
  the sample. The automatic restart is a compensating control, not a repair.
- The ledger. The gap is visible as missing windows and as `forecast_skipped`
  events; nothing was backfilled.
