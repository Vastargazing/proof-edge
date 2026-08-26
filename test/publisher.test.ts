import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicationPaths, isPublicationPath } from "../src/publisher.js";

test("publisher path allowlist accepts only public snapshot and evidence outputs", () => {
  assert.equal(isPublicationPath("published/forecast-events.jsonl"), true);
  assert.equal(isPublicationPath("dashboard/app/forecast-data.json"), true);
  assert.equal(isPublicationPath("evidence/index.json"), true);
  assert.equal(isPublicationPath("src/live-recorder.ts"), false);
  assert.throws(
    () => assertPublicationPaths(["evidence/index.json", "README.md"], "test"),
    /non-publication paths:\nREADME\.md/,
  );
});
