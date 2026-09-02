# 2026-09-01: a host crash, then a night of sleep, cost fifteen hours of collection

Status: no ledger byte was altered, no forecast was backfilled, `model_hash` did
not change. What was lost is observation time, and it is lost for good: the
markets that opened and expired during the gap left no commitment.

## Timeline (UTC; the host journal is UTC+3)

- 12:50:22 — last anchored batch of the day; last `spot_observed` at 12:50:47.
  Collection had been running at about 33 forecasts an hour.
- 12:53:18 — the host went down. The journal's previous boot ends here with no
  shutdown sequence; the operator reports a crash. The new boot starts fourteen
  seconds later, at 12:53:32.
- 12:53–14:15 — the recorder unit came back by itself, as it is enabled to, and
  `ExecStartPre` printed `MODEL_HASH_OK` for `0x253a60a7…`. It wrote heartbeats
  and nothing else for eighty-two minutes: the VPN tunnel that carries every
  Somnia request was not up after the reboot, so the indexer and the price feed
  were unreachable. The publisher runs at 13:00 and 14:00 failed the same way,
  on `git fetch`.
- 13:54, 14:04, 14:15 — the watchdog reported `inputs_stale` with the last spot
  ageing from 3,834 to 5,058 seconds, alongside `no_new_forecast_windows` and
  `no_new_anchors`. It did not restart the recorder, which is correct: a
  restart cannot reach a network that is not there.
- 14:15:28 — the operator suspended the machine. `systemd-logind` records "The
  system will suspend now!"; nothing in the recorder's own state requested it.
- 14:15 → 04:27 — suspended. No timer fires while the host sleeps, so there are
  no watchdog ticks and no publisher runs to read afterwards.
- 04:27:25 — resume. Data resumes at 04:28:13, one poll later.

## What the bytes establish

- The recorded gap runs from 12:50:47 to 04:28:13 — **fifteen hours and
  thirty-seven minutes**. At the rate of the two preceding days (804 and 808
  forecasts a day, 33.5 an hour) that is roughly **520 forecasts and 230
  anchors that were never made**.
- Heartbeats stop at 14:15:10, ninety seconds before the suspend, and resume at
  04:27:37. The eighty-two minutes between the reboot and the suspend are
  therefore visible as a live recorder with frozen inputs — the 28 August
  signature — and the rest as a stopped host.
- The ledger is intact across the gap: one hash chain, one known orphan from
  27 August, no new one. Every restart in the window passed the model check.
- Nothing was backfilled. A market that expired while the host slept has no
  commitment and never will.

## What we changed

Nothing in the code. The failure is operational, and the two levers are:

- **Do not suspend the recorder host during a collection window.** This single
  night cost more forecasts than every network crash of the previous four days
  combined.
- **The VPN does not return on its own after a reboot.** `Happ.desktop` is in
  `~/.config/autostart`, so the client starts with the session, but the tunnel
  was not carrying traffic for eighty-two minutes. After any reboot, confirm
  the tunnel before trusting the recorder: the unit being `active` proves only
  that the process started (docs/RUNBOOK.md § "What healthy means").

## What we did not change

- The recorder's fail-fast on an unreachable feed, and the watchdog's refusal
  to restart for `inputs_stale`. Both behaved as designed; neither can invent
  data that was never observed.
- The published record. The gap stays visible as missing windows in the ledger
  and as a flat stretch in the dashboard's totals.
