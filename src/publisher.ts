import { isAbsolute, relative, resolve, sep } from "node:path";

export const PUBLICATION_PATHS = [
  "published/forecast-events.jsonl",
  "dashboard/app/forecast-data.json",
  "evidence",
] as const;

export function isPublicationPath(path: string): boolean {
  return path === PUBLICATION_PATHS[0]
    || path === PUBLICATION_PATHS[1]
    || path.startsWith(`${PUBLICATION_PATHS[2]}/`);
}

export function assertPublicationPaths(paths: readonly string[], context: string): void {
  const unexpected = paths.filter((path) => !isPublicationPath(path));
  if (unexpected.length > 0) {
    throw new Error(`${context} contains non-publication paths:\n${unexpected.join("\n")}`);
  }
}

export function publisherWriterLockPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | null {
  const storePath = resolve(cwd, env.RECORDER_STORE ?? "data/forecast-events.jsonl");
  const lockPath = relative(cwd, `${storePath}.writer.lock`);
  if (lockPath === "" || lockPath === ".." || lockPath.startsWith(`..${sep}`) || isAbsolute(lockPath)) return null;
  return lockPath.split(sep).join("/");
}

export function publisherCheckoutChanges(
  trackedPaths: readonly string[],
  untrackedPaths: readonly string[],
  writerLockPath: string | null,
): string[] {
  const relevantUntracked = writerLockPath === null
    ? untrackedPaths
    : untrackedPaths.filter((path) => path !== writerLockPath);
  return [...new Set([...trackedPaths, ...relevantUntracked])].sort();
}

export function publicationVerificationEnv(
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): NodeJS.ProcessEnv {
  return { ...env, RECORDER_STORE: resolve(cwd, "published/forecast-events.jsonl") };
}

export function completenessStoreOptions(publishWatermark: boolean): { writable?: boolean } {
  return publishWatermark ? { writable: true } : {};
}
