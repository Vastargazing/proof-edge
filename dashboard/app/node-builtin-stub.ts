/**
 * Browser stand-in for the two Node built-ins the verifier drags in.
 *
 * `src/evidence-verifier.ts` reaches `validatePublishedEvidence` through
 * `src/evidence.ts`, whose *writer* half (`writeJsonAtomic`,
 * `writeEvidenceDirectory`) imports `node:fs/promises` and `node:path`. The
 * browser panel never calls that half, but the bundler still has to resolve the
 * specifiers. `src/` is sealed into the running recorder's `model_hash` and
 * cannot be split into read/write modules, so `dashboard/vite.config.ts` aliases
 * both builtins here instead. Every export throws: if the bundle ever does reach
 * the writer half, it says so loudly rather than corrupting a verification.
 */
const unavailable = (name: string) => (): never => {
  throw new Error(`${name} is not available in the browser; the verifier must not call it`);
};

export const mkdir = unavailable('mkdir');
export const readFile = unavailable('readFile');
export const readdir = unavailable('readdir');
export const rename = unavailable('rename');
export const writeFile = unavailable('writeFile');
export const join = unavailable('join');
