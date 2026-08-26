import { execFileSync } from "node:child_process";

const capture = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string =>
  execFileSync(command, args, { cwd: process.cwd(), env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string => {
  const output = capture(command, args, env);
  if (output !== "") console.log(output);
  return output;
};

const initialStatus = capture("git", ["status", "--porcelain", "--untracked-files=no"]);
if (initialStatus !== "") {
  throw new Error(`publisher checkout is dirty before sync; refusing to mix changes:\n${initialStatus}`);
}

run("git", ["fetch", "origin"]);
run("git", ["rebase", "origin/main"], { ...process.env, GIT_EDITOR: "true" });
run("npm", ["run", "publish:evidence"]);
run("npm", ["run", "publish:snapshot"]);
run("npm", ["run", "check"]);
run("git", ["add", "--", "published/forecast-events.jsonl", "dashboard/app/forecast-data.json", "evidence"]);

const staged = capture("git", ["diff", "--cached", "--name-only"]);
if (staged === "") {
  console.log("publisher: no public snapshot changes");
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
run("git", ["commit", "-m", `Publish recorder snapshot ${timestamp}`]);
try {
  run("git", ["push", "origin", "HEAD:main"]);
} catch {
  // A concurrent non-force update gets one ordinary fetch/rebase/push retry.
  run("git", ["fetch", "origin"]);
  run("git", ["rebase", "origin/main"], { ...process.env, GIT_EDITOR: "true" });
  run("git", ["push", "origin", "HEAD:main"]);
}
console.log(`publisher: committed and pushed ${capture("git", ["rev-parse", "HEAD"])}`);
