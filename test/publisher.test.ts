import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicationPaths,
  completenessStoreOptions,
  isPublicationPath,
  publisherCheckoutChanges,
  publisherWriterLockPath,
  publicationVerificationEnv,
} from "../src/publisher.js";

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

test("publisher verifiers always read the public copy, never a configured live source", () => {
  const env = publicationVerificationEnv({ RECORDER_STORE: "/live/private.jsonl" }, "/checkout");
  assert.equal(env.RECORDER_STORE, "/checkout/published/forecast-events.jsonl");
});

test("publisher ignores only the live store's untracked writer lock", () => {
  const lockPath = publisherWriterLockPath({ RECORDER_STORE: "data/forecast-events.jsonl" }, "/checkout");
  assert.equal(lockPath, "data/forecast-events.jsonl.writer.lock");
  assert.deepEqual(
    publisherCheckoutChanges(
      [],
      ["data/forecast-events.jsonl.writer.lock", "notes.txt"],
      lockPath,
    ),
    ["notes.txt"],
  );
  assert.deepEqual(
    publisherCheckoutChanges(["data/forecast-events.jsonl.writer.lock"], [], lockPath),
    ["data/forecast-events.jsonl.writer.lock"],
  );
  assert.deepEqual(
    publisherCheckoutChanges([], ["data/other.jsonl.writer.lock"], lockPath),
    ["data/other.jsonl.writer.lock"],
  );
});

test("completeness takes a writer lock only when it appends the publication watermark", () => {
  assert.deepEqual(completenessStoreOptions(false), {});
  assert.deepEqual(completenessStoreOptions(true), { writable: true });
});
