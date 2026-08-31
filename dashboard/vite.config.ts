import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, type Plugin } from 'vite';

const nodeBuiltinStub = fileURLToPath(new URL('./app/node-builtin-stub.ts', import.meta.url));

/**
 * § 4's verifier imports src/evidence-verifier.ts unchanged so the browser and
 * the CLI cannot drift. That module reaches validatePublishedEvidence through
 * src/evidence.ts, whose writer half imports node:fs/promises and node:path.
 * src/ is frozen into the recorder's model_hash and cannot be split, so those
 * two specifiers — and only those two, from that one file — resolve to a stub
 * that throws if anything ever calls them. A blanket alias is not an option:
 * vinext's own server code reads path.win32 and dies on a stubbed node:path.
 */
function stubNodeBuiltinsForEvidenceReader(): Plugin {
  const stubbed = new Set(['node:fs/promises', 'node:path']);
  return {
    name: 'proof-edge:stub-node-builtins-for-evidence-reader',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!stubbed.has(source) || importer === undefined) return null;
      return importer.replace(/\\/g, '/').endsWith('/src/evidence.ts') ? nodeBuiltinStub : null;
    },
  };
}

export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [stubNodeBuiltinsForEvidenceReader(), vinext()],
});
