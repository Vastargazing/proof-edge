import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

async function filesBelow(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [path];
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

export interface SourceInventory {
  aggregate: string;
  files: Record<string, string>;
  dirty: boolean;
}

/** Binds exact bytes, stable repo-relative paths, and explicit Git dirtiness. */
export async function buildSourceInventory(
  scopes: readonly string[],
  cwd = process.cwd(),
  dirtyOverride?: boolean,
): Promise<SourceInventory> {
  const absoluteFiles = (await Promise.all(scopes.map((path) => filesBelow(resolve(cwd, path))))).flat().sort();
  const files: Record<string, string> = {};
  const aggregate = createHash("sha256");
  for (const file of absoluteFiles) {
    const path = relative(cwd, file).replaceAll("\\", "/");
    const bytes = await readFile(file);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    files[path] = digest;
    aggregate.update(path);
    aggregate.update("\0");
    aggregate.update(bytes);
    aggregate.update("\0");
  }
  const dirty = dirtyOverride ?? execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all", "--", ...scopes],
      { cwd, encoding: "utf8" },
    ).trim() !== "";
  return { aggregate: `sha256:${aggregate.digest("hex")}`, files, dirty };
}
