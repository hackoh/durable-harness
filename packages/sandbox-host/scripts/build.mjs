#!/usr/bin/env node
// Bundle the sandbox-lane daemon:
//   dist/daemon.mjs                       everything but libfx, one ESM file for node24
//   dist/node_modules/libfx/*             the libfx the daemon loads: node.js and its imports, plus the linux-x64 native addon (no Wasm)
//   dist/manifest.json                    { version, files } — version = sha256 of every file
// `--out <dir>` writes there instead (apps/demo copies it next to the routes that start VMs).
// `--platform-addon` keeps this machine's addon too (a laptop daemon for local e2e).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({ options: { out: { type: 'string' }, 'platform-addon': { type: 'boolean' } } });
const out = resolve(args.out ?? join(here, 'dist'));
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'node_modules/libfx'), { recursive: true });

await build({
  entryPoints: [join(here, 'src/daemon.ts')],
  // The bundle's module comments carry paths relative to this: pin it so the
  // content-addressed version does not depend on the caller's cwd (the demo
  // build and scripts/image.mjs must agree on it to find the VCR image, P6).
  absWorkingDir: here,
  outfile: join(out, 'daemon.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['libfx', 'cbor-extract', '@cbor-extract/*'],
  banner: { js: "import { createRequire as __hostRequire } from 'node:module'; const require = __hostRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

const libfxDir = realpathSync(join(here, 'node_modules/libfx'));
const addons = new Set(['libfx.linux-x64.node', ...(args['platform-addon'] ? [`libfx.${process.platform}-${process.arch}.node`] : [])]);
// What the daemon never loads. It imports `libfx` (ESM, so node.js) and calls
// only createFxEngine. node.js imports core-output, wasm-module,
// fetch-cleanup, durable, fx-harness and fx-sdk at load (so those stay),
// and loads durable/ (libfx's bundled Worlds, 1.9 MB) only for
// createFxAgent's default durability. node.cjs is the require() entry;
// browser.js, mcp.js and the skills modules are other subpath exports.
const unused = new Set(['durable', 'node.cjs', 'browser.js', 'mcp.js', 'skills.js', 'skills-node.js']);
for (const f of readdirSync(libfxDir)) {
  if (/\.(wasm|md)$/.test(f) || f === 'LICENSE' || unused.has(f)) continue;
  if (/\.node$/.test(f) && !addons.has(f)) continue;
  cpSync(join(libfxDir, f), join(out, 'node_modules/libfx', f), { recursive: true });
}
// The copy must still load: import it in a child process (loading the
// module does no I/O and opens no addon), so a libfx that grows a new import
// fails the build instead of the daemon.
execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(out, 'node_modules/libfx/node.js')).href)})`], { stdio: 'inherit' });
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'harness-sandbox-host-bundle', private: true, type: 'module' }));

const files = [];
const walk = (dir, rel = '') => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(join(dir, e.name), r);
    else if (r !== 'manifest.json') files.push(r);
  }
};
walk(out);
files.sort();
const hash = createHash('sha256');
for (const f of files) hash.update(f).update(readFileSync(join(out, f)));
const version = hash.digest('hex').slice(0, 16);
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ version, files }, null, 2));
const bytes = files.reduce((n, f) => n + readFileSync(join(out, f)).length, 0);
console.log(`sandbox-host ${version}: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB -> ${out}`);
