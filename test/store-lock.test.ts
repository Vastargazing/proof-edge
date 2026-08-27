import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { AppendOnlyStore } from "../src/store.js";

test("a second process is rejected and a SIGKILL-stale writer lock is recovered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-lock-"));
  const file = join(dir, "events.jsonl");
  const storeModule = pathToFileURL(resolve("src/store.ts")).href;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `import { AppendOnlyStore } from ${JSON.stringify(storeModule)}; await AppendOnlyStore.open(${JSON.stringify(file)}, { writable: true }); console.log("READY"); setInterval(() => undefined, 1000);`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      child.stdout.on("data", (chunk: string) => {
        if (chunk.includes("READY")) resolveReady();
      });
      child.once("exit", (code) => rejectReady(new Error(`lock holder exited early (${code}): ${stderr}`)));
    });

    await assert.rejects(
      () => AppendOnlyStore.open(file, { writable: true }),
      new RegExp(`writer lock is held.*pid ${child.pid}`),
    );

    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

    const recovered = await AppendOnlyStore.open(file, { writable: true });
    await recovered.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
