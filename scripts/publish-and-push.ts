import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createPublicClient, defineChain, http } from "viem";
import {
  assertPublicationPaths,
  isPublicationPath,
  publisherCheckoutChanges,
  publisherWriterLockPath,
  publicationVerificationEnv,
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
// README statistics blocks are regenerated from the snapshot by this run, so
// README.md is allowed and staged alongside the publication paths without
// widening the src/publisher.ts allowlist (that file is sealed into the
// running recorder's model manifest).
const README_PATH = "README.md";
const withoutReadme = (paths: string[]): string[] => paths.filter((path) => path !== README_PATH);
const untrackedPaths = (): string[] => lines(capture("git", ["ls-files", "--others", "--exclude-standard"]));
const changedPaths = (): string[] => publisherCheckoutChanges(
  [
    ...lines(capture("git", ["diff", "--name-only"])),
    ...lines(capture("git", ["diff", "--cached", "--name-only"])),
  ],
  untrackedPaths(),
  publisherWriterLockPath(),
);

// A run that dies between opening the published copy and finishing (one RPC
// timeout inside a verification step is enough) leaves that copy's writer lock
// behind. The lock is untracked and is not a publication path, so cleanup never
// removes it and the dirty check below refuses to start every later run until
// someone deletes the file by hand — one flaky hour otherwise stops publishing
// indefinitely. A lock whose writer is gone is swept here; a lock held by a
// live process still counts as dirt.
const staleWriterLocks = (paths: readonly string[]): string[] => paths.filter((path) => {
  if (!path.endsWith(".writer.lock")) return false;
  try {
    const { pid } = JSON.parse(readFileSync(resolve(path), "utf8")) as { pid?: unknown };
    if (typeof pid !== "number") return true;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // ESRCH: the writer exited. EPERM: it is alive under another user.
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
});

function sweepStaleWriterLocks(changes: readonly string[]): string[] {
  const stale = new Set(staleWriterLocks(changes));
  for (const path of stale) {
    console.error(`publisher: removing stale writer lock left by an earlier run: ${path}`);
    unlinkSync(resolve(path));
  }
  return changes.filter((path) => !stale.has(path));
}

async function cleanupGeneratedChanges(): Promise<void> {
  run("git", ["restore", "--staged", "--", ...PUBLICATION_PATHS, README_PATH]);
  const generatedUntracked = untrackedPaths().filter(isPublicationPath);
  run("git", ["restore", "--worktree", "--", ...PUBLICATION_PATHS, README_PATH]);
  for (const path of generatedUntracked) {
    await rm(resolve(path), { recursive: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

// Every step that reads Shannon or GitHub runs over the operator's VPN, where
// a single connect timeout is routine. A timeout used to cost the whole hour,
// so the network-dependent steps get a bounded retry; local steps (`check`,
// `verify:log`, the exporters) still fail on the first error. The retried
// steps are read-only scans or idempotent rewrites of generated files.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const retryAttempts = Number(process.env.PUBLISH_RETRY_ATTEMPTS ?? 3);
const retryDelayMs = Number(process.env.PUBLISH_RETRY_DELAY_MS ?? 15_000);
for (const [name, value] of Object.entries({ retryAttempts, retryDelayMs })) {
  // A misspelled value must not turn the bounded retry into an endless one.
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

async function withRetry<T>(label: string, action: () => T | Promise<T>, attempts = retryAttempts): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const reason = (error as Error).message.split("\n")[0];
      console.error(`publisher: ${label} failed (attempt ${attempt}/${attempts}): ${reason}`);
      console.error(`publisher: retrying ${label} in ${retryDelayMs} ms`);
      await sleep(retryDelayMs);
    }
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
  const initialChanges = sweepStaleWriterLocks(changedPaths());
  if (initialChanges.length > 0) {
    throw new Error(`publisher checkout is dirty before sync; refusing to mix changes:\n${initialChanges.join("\n")}`);
  }

  await withRetry("git fetch", () => run("git", ["fetch", "origin"]));
  run("git", ["rebase", "origin/main"], { ...process.env, GIT_EDITOR: "true" });
  const rpcUrl = process.env.RPC_URL ?? "https://api.infra.testnet.somnia.network";
  const chain = defineChain({
    id: 50312,
    name: "Somnia Shannon",
    nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const watermark = await withRetry(
    "completeness watermark block",
    () => createPublicClient({ chain, transport: http(rpcUrl) }).getBlockNumber(),
  );
  // The dashboard evidence mirror is a build-time asset, not a publication
  // path: src/publisher.ts is frozen into the recorder's model_hash and its
  // PUBLICATION_PATHS allowlist cannot gain dashboard/public/evidence yet, so
  // an hourly rewrite there would fail assertPublicationPaths below. Refresh it
  // by hand with `npx tsx scripts/publish-evidence.ts` instead.
  const publicationEnv = {
    ...process.env,
    PUBLICATION_WATERMARK_BLOCK: watermark.toString(),
    EVIDENCE_MIRROR: "0",
  };
  const verificationEnv = publicationVerificationEnv(publicationEnv);
  console.log(`publisher: captured completeness watermark block ${watermark}`);
  run("npm", ["run", "publish:evidence"], publicationEnv);
  run("npm", ["run", "publish:snapshot"], publicationEnv);
  await withRetry(
    "verify:completeness --publish-watermark",
    () => run("npm", ["run", "verify:completeness", "--", "--publish-watermark"], verificationEnv),
  );
  // The watermark scan above is what writes the `completeness` block into the
  // dashboard JSON; the README renderer reads that block, so it must run last.
  run("npx", ["tsx", "scripts/render-readme-stats.ts"]);

  assertPublicationPaths(withoutReadme(changedPaths()), "publisher output");
  run("npm", ["run", "check"]);
  run("npm", ["run", "verify:log"], verificationEnv);
  await withRetry("verify:chain", () => run("npm", ["run", "verify:chain"], verificationEnv));
  await withRetry("verify:completeness", () => run("npm", ["run", "verify:completeness"], verificationEnv));

  run("git", ["add", "--", ...PUBLICATION_PATHS, README_PATH]);
  const stagedPaths = lines(capture("git", ["diff", "--cached", "--name-only"]));
  assertPublicationPaths(withoutReadme(stagedPaths), "publisher commit");
  if (stagedPaths.length > 0) {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    run("git", ["commit", "-m", `Publish recorder snapshot ${timestamp}`]);
    committed = true;
  } else {
    console.log("publisher: no public snapshot changes");
  }

  const ahead = Number(capture("git", ["rev-list", "--count", "origin/main..HEAD"]));
  // Each `pushWithOneRetry` already fetches, rebases and pushes again on a
  // race. One more bounded round covers a GitHub outage of a few minutes:
  // git's own connect timeout is around two minutes per attempt, so this caps
  // the push at roughly nine minutes rather than losing the publication hour.
  if (ahead > 0) await withRetry("git push", () => { pushWithOneRetry(); }, 2);

  // Re-scan after the public push. A root created during generation or push is
  // an explicit service failure and triggers the systemd OnFailure alert.
  await withRetry("verify:completeness after push", () => run("npm", ["run", "verify:completeness"], verificationEnv));
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
