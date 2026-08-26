import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertPublicationPaths,
  isPublicationPath,
  PUBLICATION_PATHS,
} from "../src/publisher.js";

const capture = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string =>
  execFileSync(command, args, { cwd: process.cwd(), env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string => {
  const output = capture(command, args, env);
  if (output !== "") console.log(output);
  return output;
};
const lines = (value: string): string[] => value === "" ? [] : value.split("\n").filter(Boolean);
const untrackedPaths = (): string[] => lines(capture("git", ["ls-files", "--others", "--exclude-standard"]));
const changedPaths = (): string[] => [...new Set([
  ...lines(capture("git", ["diff", "--name-only"])),
  ...lines(capture("git", ["diff", "--cached", "--name-only"])),
  ...untrackedPaths(),
])].sort();

async function cleanupGeneratedChanges(): Promise<void> {
  run("git", ["restore", "--staged", "--", ...PUBLICATION_PATHS]);
  const generatedUntracked = untrackedPaths().filter(isPublicationPath);
  run("git", ["restore", "--worktree", "--", ...PUBLICATION_PATHS]);
  for (const path of generatedUntracked) {
    await rm(resolve(path), { recursive: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function pushWithOneRetry(): void {
  try {
    run("git", ["push", "origin", "HEAD:main"]);
  } catch {
    // A concurrent ordinary update gets one fetch/rebase/ordinary-push retry.
    run("git", ["fetch", "origin"]);
    run("git", ["rebase", "origin/main"], { ...process.env, GIT_EDITOR: "true" });
    run("git", ["push", "origin", "HEAD:main"]);
  }
}

let committed = false;
try {
  const initialChanges = changedPaths();
  if (initialChanges.length > 0) {
    throw new Error(`publisher checkout is dirty before sync; refusing to mix changes:\n${initialChanges.join("\n")}`);
  }

  run("git", ["fetch", "origin"]);
  run("git", ["rebase", "origin/main"], { ...process.env, GIT_EDITOR: "true" });
  run("npm", ["run", "publish:evidence"]);
  run("npm", ["run", "publish:snapshot"]);

  assertPublicationPaths(changedPaths(), "publisher output");
  run("npm", ["run", "check"]);
  run("npm", ["run", "verify:log"]);
  run("npm", ["run", "verify:chain"]);
  run("npm", ["run", "verify:completeness"]);

  run("git", ["add", "--", ...PUBLICATION_PATHS]);
  const stagedPaths = lines(capture("git", ["diff", "--cached", "--name-only"]));
  assertPublicationPaths(stagedPaths, "publisher commit");
  if (stagedPaths.length > 0) {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    run("git", ["commit", "-m", `Publish recorder snapshot ${timestamp}`]);
    committed = true;
  } else {
    console.log("publisher: no public snapshot changes");
  }

  const ahead = Number(capture("git", ["rev-list", "--count", "origin/main..HEAD"]));
  if (ahead > 0) pushWithOneRetry();

  // Re-scan after the public push. A root created during generation or push is
  // an explicit service failure and triggers the systemd OnFailure alert.
  run("npm", ["run", "verify:completeness"]);
  console.log(`publisher: public snapshot verified at ${capture("git", ["rev-parse", "HEAD"])}`);
} catch (error) {
  console.error(`PUBLISHER_ALERT: ${(error as Error).message}`);
  if (!committed) {
    await cleanupGeneratedChanges().catch((cleanupError) => {
      console.error(`PUBLISHER_ALERT: cleanup failed: ${(cleanupError as Error).message}`);
    });
  }
  throw error;
}
