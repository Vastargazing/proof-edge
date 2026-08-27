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

async function recorderIsActive(): Promise<boolean> {
  try {
    await run("systemctl", ["--user", "is-active", "--quiet", "proof-edge-recorder.service"]);
    return true;
  } catch {
    return false;
  }
}

async function readState(): Promise<WatchdogState | null> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as WatchdogState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(state: WatchdogState): Promise<void> {
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

const store = await AppendOnlyStore.open(storePath);
const previous = await readState();
const recorderActive = await recorderIsActive();
const result = evaluateWatchdogTick(previous, {
  forecasts: store.allForecasts().length,
  anchors: store.anchoredBatches().length,
  recorder_active: recorderActive,
}, threshold);
await writeState(result.state);

console.log(`WATCHDOG tick ${JSON.stringify({
  store: storePath,
  recorder_active: recorderActive,
  ...result.state,
  ledger_integrity: store.readReport(),
})}`);
for (const alert of result.alerts) console.error(`WATCHDOG_ALERT ${alert}`);
if (result.alerts.length > 0) process.exitCode = 1;
