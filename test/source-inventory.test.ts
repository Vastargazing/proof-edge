import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSourceInventory } from "../src/source-inventory.js";

test("source inventory binds exact bytes and reports a dirty source tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forecast-source-inventory-"));
  await mkdir(join(directory, "src"));
  const file = join(directory, "src", "model.ts");
  await writeFile(file, "export const model = 1;\n", "utf8");
  const clean = await buildSourceInventory(["src"], directory, false);
  assert.equal(clean.dirty, false);
  assert.match(clean.files["src/model.ts"]!, /^sha256:[0-9a-f]{64}$/);

  await writeFile(file, "export const model = 2;\n", "utf8");
  const dirty = await buildSourceInventory(["src"], directory, true);
  assert.equal(dirty.dirty, true);
  assert.notEqual(dirty.aggregate, clean.aggregate);
  assert.notEqual(dirty.files["src/model.ts"], clean.files["src/model.ts"]);
});
