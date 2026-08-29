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
  // The journal alert above is the record; the desktop popup is optional.
  // Set PROOF_EDGE_DESKTOP_NOTIFY=0 in the unit when a flapping uplink turns
  // every fail-fast restart into a critical notification.
  if (process.env.PROOF_EDGE_DESKTOP_NOTIFY !== "0") {
    spawnSync("/usr/bin/notify-send", ["--urgency=critical", "ProofEdge recorder stopped", message], {
      stdio: "ignore",
    });
  }
}
