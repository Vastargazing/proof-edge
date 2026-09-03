/**
 * Static export of the dashboard: `npm run export` writes `out/`, a directory
 * any static host can serve as-is.
 *
 * vinext has no `output: 'export'`; its build produces client assets plus a
 * Node server. The single route is a client component whose RSC payload is
 * inlined in the HTML, so the served page is complete once rendered: this
 * script builds, starts the production server on a spare port, fetches `/`
 * once, and copies that HTML next to the client assets. `/evidence/*.json`
 * and the fonts are already static files, and § 4 talks to Somnia JSON-RPC
 * straight from the browser, so nothing in `out/` needs a server.
 *
 * The figures in `out/` are frozen at build time — the README re-renders
 * every hour, the exported page does not until it is exported again.
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
// The package bin, not `npx`: killing npx leaves its child server alive on the
// port, and the next export would then fetch HTML from the previous build.
const vinext = fileURLToPath(new URL('./node_modules/.bin/vinext', import.meta.url));
const port = Number(process.env.EXPORT_PORT ?? 3199);
const origin = `http://127.0.0.1:${port}`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
  });
}

async function fetchWhenUp(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('unreachable');
}

await run(vinext, ['build']);

const server = spawn(vinext, ['start', '-p', String(port)], { cwd: root, stdio: 'ignore', detached: true });
try {
  const html = await (await fetchWhenUp(`${origin}/`)).text();
  for (const chunk of html.matchAll(/"(\/_next\/static\/[^"]+)"/g)) {
    const asset = await fetch(`${origin}${chunk[1]}`);
    if (!asset.ok) throw new Error(`${chunk[1]} referenced by the page is missing from the build`);
  }
  if (!html.includes('VERIFY THIS FORECAST')) throw new Error('rendered page is missing the § 4 panel');
  const index = await (await fetchWhenUp(`${origin}/evidence/index.json`)).json();
  if (!Array.isArray(index.entries) || index.entries.length === 0) throw new Error('evidence mirror is empty');

  const out = new URL('./out/', import.meta.url);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(new URL('./dist/client/', import.meta.url), out, { recursive: true });
  await rm(new URL('./out/vinext-client-entry-manifest.json', import.meta.url), { force: true });
  await rm(new URL('./out/.vite/', import.meta.url), { recursive: true, force: true });
  await writeFile(new URL('./out/index.html', import.meta.url), html);
  // GitHub Pages runs Jekyll by default, which drops `_next/`; this opts out.
  await writeFile(new URL('./out/.nojekyll', import.meta.url), '');
  console.log(`exported ${index.entries.length} evidence files and index.html to dashboard/out/`);
} finally {
  // Negative pid: the whole process group, so no server outlives the export.
  process.kill(-server.pid, 'SIGTERM');
}
