import { spawnSync } from "node:child_process";

const result = process.env.SERVICE_RESULT ?? "unknown";
if (result !== "success") {
  const exitCode = process.env.EXIT_CODE ?? "unknown";
  const exitStatus = process.env.EXIT_STATUS ?? "unknown";
  const message = `ProofEdge recorder stopped unexpectedly: result=${result} exit_code=${exitCode} exit_status=${exitStatus}`;
  console.error(`RECORDER_ALERT ${message}`);
  spawnSync("/usr/bin/systemd-cat", ["--priority=alert", "--identifier=proof-edge-recorder", "/usr/bin/printf", message], {
    stdio: "ignore",
  });
  spawnSync("/usr/bin/notify-send", ["--urgency=critical", "ProofEdge recorder stopped", message], {
    stdio: "ignore",
  });
}
