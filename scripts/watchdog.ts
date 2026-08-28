import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AppendOnlyStore } from "../src/store.js";
import { evaluateWatchdogTick, type WatchdogState } from "../src/watchdog.js";

const run = promisify(execFile);
const storePath = resolve(process.env.RECORDER_STORE ?? "data/forecast-events.jsonl");
const statePath = resolve(process.env.WATCHDOG_STATE ?? join(homedir(), ".local/state/proof-edge/watchdog.json"));
const threshold = Number(process.env.WATCHDOG_STALE_TICKS ?? 2);
// The recorder writes a heartbeat from inside its poll loop, so a stale
// heartbeat on an active unit means the loop itself stopped. A stale spot with
// a fresh heartbeat means the upstream feed stopped; a restart cannot fix that.
const heartbeatStaleMs = Number(process.env.WATCHDOG_HEARTBEAT_STALE_MS ?? 15 * 60_000);
const spotStaleMs = Number(process.env.WATCHDOG_SPOT_STALE_MS ?? 15 * 60_000);
// Automatic restarts go through the recorder unit, so ExecStartPre still
// refuses a tree that hashes differently. 0 disables them.
const restartLimit = Number(process.env.WATCHDOG_MAX_AUTO_RESTARTS ?? 2);
const restartGraceTicks = Number(process.env.WATCHDOG_RESTART_GRACE_TICKS ?? 3);
const recorderUnit = "proof-edge-recorder.service";

interface AutoRestartState {
  count: number;
  last_at_ns: string | null;
  ticks_since_last: number;
  last_reason: string | null;
}

interface PersistedState extends WatchdogState {
  auto_restart?: AutoRestartState;
}

for (const [name, value] of Object.entries({ heartbeatStaleMs, spotStaleMs, restartLimit, restartGraceTicks })) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

async function recorderIsActive(): Promise<boolean> {
  try {
    await run("systemctl", ["--user", "is-active", "--quiet", recorderUnit]);
    return true;
  } catch {
    return false;
  }
}

async function readState(): Promise<PersistedState | null> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as PersistedState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(state: PersistedState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const candidate = `${statePath}.${process.pid}.candidate`;
  await writeFile(candidate, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(candidate, statePath);
  } finally {
    await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const ageSeconds = (ns: string, nowMs: number): number => Math.round((nowMs - Number(BigInt(ns) / 1_000_000n)) / 1000);

const store = await AppendOnlyStore.open(storePath);
const previous = await readState();
const recorderActive = await recorderIsActive();
const previousCounters: WatchdogState | null = previous === null
  ? null
  : {
    forecasts: previous.forecasts,
    anchors: previous.anchors,
    consecutive_ticks_without_forecast: previous.consecutive_ticks_without_forecast,
    consecutive_ticks_without_anchor: previous.consecutive_ticks_without_anchor,
  };
const result = evaluateWatchdogTick(previousCounters, {
  forecasts: store.allForecasts().length,
  anchors: store.anchoredBatches().length,
  recorder_active: recorderActive,
}, threshold);
const alerts = [...result.alerts];

const nowMs = Date.now();
const heartbeat = store.latestHeartbeat();
const heartbeatAgeS = heartbeat === undefined ? null : ageSeconds(heartbeat.at_ns, nowMs);
const lastSpot = store.spotObservations(nowMs - 24 * 60 * 60_000).at(-1);
const spotAgeS = lastSpot === undefined ? null : ageSeconds(lastSpot.recorded_at_ns, nowMs);
const loopStalled = recorderActive && heartbeatAgeS !== null && heartbeatAgeS * 1000 > heartbeatStaleMs;
const inputsStale = recorderActive && !loopStalled && spotAgeS !== null && spotAgeS * 1000 > spotStaleMs;
if (loopStalled) alerts.push(`recorder_stalled heartbeat_age_s=${heartbeatAgeS}`);
if (inputsStale) alerts.push(`inputs_stale last_spot_age_s=${spotAgeS} (upstream feed; a restart does not help)`);

const auto: AutoRestartState = previous?.auto_restart ?? { count: 0, last_at_ns: null, ticks_since_last: 0, last_reason: null };
if (auto.last_at_ns !== null) auto.ticks_since_last += 1;
// A tick that observed new forecasts closes the episode and restores the budget.
if (result.state.consecutive_ticks_without_forecast === 0) auto.count = 0;

if (loopStalled && restartLimit > 0) {
  const reason = `recorder_stalled heartbeat_age_s=${heartbeatAgeS}`;
  if (auto.count >= restartLimit) {
    alerts.push(`auto_restart_limit_reached count=${auto.count} limit=${restartLimit}; operator intervention required`);
  } else if (auto.last_at_ns !== null && auto.ticks_since_last < restartGraceTicks) {
    alerts.push(`auto_restart_deferred ticks_since_last=${auto.ticks_since_last} grace=${restartGraceTicks}`);
  } else {
    auto.count += 1;
    auto.last_at_ns = (BigInt(nowMs) * 1_000_000n).toString();
    auto.ticks_since_last = 0;
    auto.last_reason = reason;
    try {
      await run("systemctl", ["--user", "restart", recorderUnit]);
      console.error(`WATCHDOG_RESTART ${recorderUnit} restarted automatically: ${reason} restart=${auto.count}/${restartLimit}`);
    } catch (error) {
      // ExecStartPre refusing a drifted tree lands here; the recorder unit's
      // own OnFailure alert fires as well, and nothing is retried silently.
      alerts.push(`auto_restart_failed ${(error as Error).message.split("\n")[0]}`);
    }
  }
}

await writeState({ ...result.state, auto_restart: auto });

console.log(`WATCHDOG tick ${JSON.stringify({
  store: storePath,
  recorder_active: recorderActive,
  ...result.state,
  heartbeat_age_s: heartbeatAgeS,
  last_spot_age_s: spotAgeS,
  auto_restart: auto,
  ledger_integrity: store.readReport(),
})}`);
for (const alert of alerts) console.error(`WATCHDOG_ALERT ${alert}`);
if (alerts.length > 0) process.exitCode = 1;
