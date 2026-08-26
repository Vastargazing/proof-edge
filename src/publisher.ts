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

export function publicationVerificationEnv(
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): NodeJS.ProcessEnv {
  return { ...env, RECORDER_STORE: resolve(cwd, "published/forecast-events.jsonl") };
}
import { resolve } from "node:path";
