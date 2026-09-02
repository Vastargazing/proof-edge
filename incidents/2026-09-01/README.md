# 2026-09-01: a crash, a missing VPN, and a suspended host left a fifteen-hour gap

The ledger stayed intact, and `model_hash` did not change. Collection did not.
Markets opened and expired during the gap without a commitment, so there is
nothing honest to backfill.

## Timeline (UTC; the host journal is UTC+3)

- 12:50:22 — last anchored batch of the day; last `spot_observed` at 12:50:47.
  Collection had been running at about 33 forecasts an hour.
- 12:53:18 — the host went down. The journal's previous boot ends here with no
  shutdown sequence. I treated it as a crash. The new boot starts fourteen
  seconds later, at 12:53:32.
- 12:53–14:15 — the recorder restarted automatically, and `ExecStartPre`
  printed `MODEL_HASH_OK` for `0x253a60a7…`. For the next eighty-two minutes it
  wrote heartbeats but no observations. The VPN tunnel had not recovered after
  the reboot, so the indexer and price feed were unreachable. The 13:00 and
  14:00 publisher runs also failed, on `git fetch`.
- 13:54, 14:04, 14:15 — the watchdog reported `inputs_stale` with the last spot
  ageing from 3,834 to 5,058 seconds, alongside `no_new_forecast_windows` and
  `no_new_anchors`. It did not restart the recorder. In this case, restarting
  the process would not have restored the missing network path.
- 14:15:28 — I suspended the machine. `systemd-logind` records "The
  system will suspend now!"; nothing in the recorder's own state requested it.
- 14:15 → 04:27 — suspended. No timers ran while the host slept, so this part
  of the outage has no watchdog ticks or publisher runs.
- 04:27:25 — resume. Data resumes at 04:28:13, one poll later.

## What the bytes establish

- The recorded gap runs from 12:50:47 to 04:28:13 — **fifteen hours and
  thirty-seven minutes**. Using the two preceding days as a baseline (804 and
  808 forecasts a day, or 33.5 an hour), I estimate that the gap missed roughly
  **520 forecasts and 230 anchors**.
- This single night cost more forecasts than every network crash of the
  previous four days combined.
- Heartbeats stop at 14:15:10, ninety seconds before the suspend, and resume at
  04:27:37. The eighty-two minutes between the reboot and the suspend split the
  outage into two parts: first a running recorder with stale inputs,
  then a stopped host.
- The ledger is intact across the gap: one hash chain, one known orphan from
  27 August, no new one. Every restart in the window passed the model check.
- I did not backfill the gap. Markets that expired while the host slept remain
  absent from the dataset.

## What I changed

No code changed. The useful follow-ups were operational:

- **Keep the recorder host awake during a collection window.** Suspending it
  turned a recoverable VPN problem into an overnight blind spot.
- **Treat VPN recovery as a manual post-reboot check.** The client started with
  the session, but the tunnel carried no traffic for eighty-two minutes. After
  a reboot, check that inputs and forecast counts are advancing. An `active`
  unit only shows that the process started
  ([runbook § What healthy means](../../docs/RUNBOOK.md#what-healthy-means)).

## What I did not change

- The recorder still fails fast on an unreachable feed, and the watchdog still
  avoids restarting for `inputs_stale`. Restarting the process would not restore
  the missing network path or recover observations.
- The published record remains unchanged. The gap is visible as elapsed time
  with no new windows in the ledger and a flat stretch in the dashboard totals.
