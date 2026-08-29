# 2026-08-29: a VPN change crashed the recorder 153 times and the publisher locked itself out

Status: recording never stopped for longer than a restart; publication stood
still for four hours until an operator removed a stale lock file. No ledger byte
was altered, no forecast was backfilled, `model_hash` did not change.

## Timeline (UTC; the host journal is UTC+3)

- 08:34:13 — the operator replaced the VPN client on the recorder host: the
  Happ client started, its TUN core `sing-box` at 08:34:20, and the AdGuard
  tunnel stopped. `tun0` changed from 172.16.219.2 to 172.18.0.1/30.
- 08:34:23 — first recorder crash, three seconds after the new tunnel came up:
  the SDK's HTTP client hit its ten-second connect timeout reaching the indexer
  and the price feed, and the recorder fails fast on that by design.
- 08:34–14:20 — 153 crashes, about 26 per hour. The eleven hours before the
  change had eight, the twelve hours before that two. Every restart re-ran
  `ExecStartPre` and printed `MODEL_HASH_OK` for `0x253a60a7…`; nothing started
  from an unpinned tree.
- 10:06:36 — last successful publication (commit `4a6b43e`): 420 forecasts,
  191 anchors, zero undisclosed roots.
- 11:02:58 — publisher run failed on an RPC `TimeoutError` inside
  `verify:completeness --publish-watermark`, over the same tunnel.
- 12:01:25 — the next run copied the ledger and left
  `published/forecast-events.jsonl.writer.lock` on disk.
- 12:03:24 — that run died on a second RPC `TimeoutError` in the same step. The
  failure handler restores the publication paths, but the writer lock is not a
  publication path, so the file survived.
- 13:01:03 and 14:01:01 — both runs refused to start: `publisher checkout is
  dirty before sync: published/forecast-events.jsonl.writer.lock`. Two network
  timeouts had turned into four lost publication hours (11:00 through 14:00).
- 14:12 — operator confirmed the lock's owning process (pid 1480400) was gone
  and removed the file. The live ledger then held 536 forecasts and 247 anchors
  against the 420 and 191 published at 10:06.

## What the bytes establish

- The record itself did not suffer. 152 forecasts were written by 14:00, at
  31–34 per hour during the worst of the storm — the five- and fifteen-minute
  series returned around 10:00 after two days of hourly-only listings, and the
  recorder caught them.
- Continuity of observation: 17 gaps longer than sixty seconds in
  `spot_observed` for the whole day, 33 minutes in total, all of them before
  12:20. A single crash costs roughly ten seconds — the restart delay plus the
  model check.
- All 247 prepared batches were anchored, none late, no undisclosed root. The
  only orphan is the known one at line 621 from 27 August.
- What was damaged was freshness, not evidence: for four hours the public
  snapshot, the dashboard and the README statistics described a ledger four
  hours behind the private one.

## What we changed

- `scripts/publish-and-push.ts` sweeps a `*.writer.lock` whose recorded pid is
  no longer running before the dirty check, and journals the removal. A lock
  held by a live process still counts as dirt.
- The same script retries the steps that cross the network — `git fetch`, the
  watermark block read, `verify:chain` and both completeness scans — three
  times with fifteen seconds between attempts. They are read-only scans or
  idempotent rewrites, so a repeat cannot publish twice; the local steps still
  fail on the first error.
- `scripts/watchdog.ts` reads `ActiveState`/`SubState` instead of a single
  `is-active` bit. A unit systemd is actively restarting counts as running
  while the heartbeat is fresh, so a tick landing in a crash gap no longer
  raises `recorder_service_down`; a restart loop outliving the heartbeat
  threshold, or a `failed`/`inactive` unit, still does. Each tick logs
  `unit_state` and the cumulative `unit_restarts`.
- `RestartSec` dropped from eight seconds to four: on this uplink the restart
  delay is the dominant part of the lost observation time.

## What we did not change

- `src/`. The recorder exits on a connect timeout instead of retrying, and the
  feed read still has no timeout of its own. A recorder that retried would not
  crash 26 times an hour, but changing it rotates `model_hash` and splits the
  sample before 8 September. The shortened restart delay is a compensating
  control, not a repair.
- The network. The operator keeps the Happ client; the crash rate is a property
  of that path. It is recorded here so nobody reads the restart counter as a
  defect in the recorder.
- The ledger. The four missing publication hours are visible as a gap between
  snapshot commits; nothing was backfilled or re-timed.
