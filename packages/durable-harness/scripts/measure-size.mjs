#!/usr/bin/env node
// What durable-harness costs an app: the tarball, the install it brings, what each subpath loads cold, and
// the size of a Next.js function that serves a Pi agent (docs/package-size.md).
//
//   node scripts/measure-size.mjs             # tarball, dist, and each subpath's cold import
//   node scripts/measure-size.mjs --install   # and a fresh `npm i <tarball> --omit=peer` (needs the network)
//   node scripts/measure-size.mjs --next      # and `next build` of a one-agent app, as on Vercel: its chat route's traced files
//   node scripts/measure-size.mjs --runs 9    # processes per subpath (default 7; the median is shown)
//   node scripts/measure-size.mjs --before 2026-10-16   # resolve the installs as npm saw them then
//
// The tarball is `pnpm pack` (what the release publishes: publishConfig's exports; it builds first). The
// imports load this package's dist with the workspace's node_modules, where every peer is installed, so a
// subpath that imports its harness's SDK at module load pays for it here as it does in an app.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values: args } = parseArgs({
  options: {
    install: { type: 'boolean', default: false },
    next: { type: 'boolean', default: false },
    runs: { type: 'string', default: '7' },
    before: { type: 'string' },
  },
});
const runs = Number(args.runs);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const npmFlags = ['--registry', 'https://registry.npmjs.org', '--no-audit', '--no-fund', '--ignore-scripts', ...(args.before ? [`--before=${args.before}`] : [])];
const du = (p) => Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split('\t')[0]) * 1024;

const work = mkdtempSync(join(tmpdir(), 'durable-harness-size-'));
try {
  // The tarball, as published.
  execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const tgz = join(work, readdirSync(work).find((f) => f.endsWith('.tgz')));
  const unpacked = join(work, 'unpacked');
  mkdirSync(unpacked);
  execFileSync('tar', ['-xzf', tgz, '-C', unpacked]);
  const files = readdirSync(unpacked, { recursive: true }).map((f) => join(unpacked, f)).filter((f) => statSync(f).isFile());
  console.log(`tarball: ${kb(statSync(tgz).size)} packed, ${kb(files.reduce((s, f) => s + statSync(f).size, 0))} unpacked, ${files.length} files`);

  // dist, per file.
  const all = readdirSync(join(root, 'dist'), { recursive: true }).map((f) => ({ file: f, size: statSync(join(root, 'dist', f)).size }));
  const js = all.filter((f) => f.file.endsWith('.js')).sort((a, b) => b.size - a.size);
  const types = all.filter((f) => f.file.endsWith('.d.ts'));
  console.log(`dist: ${kb(js.reduce((s, f) => s + f.size, 0))} of JavaScript in ${js.length} files, ${kb(types.reduce((s, f) => s + f.size, 0))} of types in ${types.length}`);
  for (const { file, size } of js) console.log(`  ${file.padEnd(32)} ${kb(size).padStart(10)}`);

  // The install an app gets without any peer.
  if (args.install) {
    const app = join(work, 'install');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'measure', private: true, type: 'module' }));
    execFileSync('npm', ['i', tgz, '--omit=peer', ...npmFlags], { cwd: app, stdio: ['ignore', 'ignore', 'inherit'] });
    const paths = execFileSync('npm', ['ls', '--all', '--parseable'], { cwd: app, encoding: 'utf8' }).trim().split('\n').slice(1);
    const own = (p) => du(p) - (existsSync(join(p, 'node_modules')) ? du(join(p, 'node_modules')) : 0);
    const sizes = paths.map((p) => ({ name: p.slice(p.indexOf('/node_modules/') + 14), size: own(p) })).sort((a, b) => b.size - a.size);
    console.log(`\ninstall (npm, --omit=peer): ${mb(du(join(app, 'node_modules')))} in ${paths.length} packages`);
    for (const { name, size } of sizes.slice(0, 25)) console.log(`  ${name.padEnd(56)} ${mb(size).padStart(9)}`);
  }

  // A Next.js app with one Pi agent and its chat route (the README's quick start): the files `next build`
  // traces into the route's function (its .nft.json), which is what a Vercel Function ships.
  if (args.next) {
    const app = join(work, 'next');
    const write = (file, text) => (mkdirSync(dirname(join(app, file)), { recursive: true }), writeFileSync(join(app, file), text));
    write('package.json', JSON.stringify({ name: 'measure-next', private: true, type: 'module' }));
    write('next.config.ts', "import { withDurableHarness } from 'durable-harness/next';\n\nexport default withDurableHarness({});\n");
    write('lib/agent.ts', "import { pi } from 'durable-harness/pi';\n\nexport const agent = pi({ model: 'anthropic/claude-sonnet-4.5' });\n");
    write('app/api/chat/route.ts', "import { agent } from '../../../lib/agent';\n\nexport const { GET, POST } = agent.chatRoute();\n");
    write('app/layout.tsx', 'export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n');
    write('app/page.tsx', 'export default function Page() {\n  return <p>/api/chat</p>;\n}\n');
    const peers = pkg.devDependencies;
    execFileSync('npm', ['i', tgz, `next@${peers.next}`, 'react@19', 'react-dom@19', '@types/react@19', '@types/node@22', 'typescript@5', `@earendil-works/pi-agent-core@${peers['@earendil-works/pi-agent-core']}`, `@earendil-works/pi-ai@${peers['@earendil-works/pi-ai']}`, ...npmFlags], { cwd: app, stdio: ['ignore', 'ignore', 'inherit'] });
    // As Vercel builds it: VERCEL and a deployment id, so the World it targets is Vercel's.
    execFileSync(join(app, 'node_modules/.bin/next'), ['build'], { cwd: app, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', VERCEL: '1', VERCEL_DEPLOYMENT_ID: 'dpl_measure' } });
    const nft = join(app, '.next/server/app/api/chat/route.js.nft.json');
    const seen = new Set();
    const byPackage = {};
    for (const file of JSON.parse(readFileSync(nft, 'utf8')).files.map((f) => resolve(dirname(nft), f))) {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile() || seen.has(realpathSync(file))) continue;
      seen.add(realpathSync(file));
      const name = /node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules\/)/.exec(file)?.[1] ?? 'the app and Next.js output';
      byPackage[name] = (byPackage[name] ?? 0) + stat.size;
    }
    const total = Object.values(byPackage).reduce((s, n) => s + n, 0);
    console.log(`\nNext.js ${peers.next}, one pi() agent, built as on Vercel: /api/chat traces ${seen.size} files, ${mb(total)}`);
    for (const [name, size] of Object.entries(byPackage).sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${name.padEnd(40)} ${mb(size).padStart(9)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Each subpath, cold: the median import time of fresh processes, and the modules and bytes it loads.
const hooks = join(mkdtempSync(join(tmpdir(), 'durable-harness-hooks-')), 'hooks.mjs');
writeFileSync(
  hooks,
  `import { registerHooks } from 'node:module';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const seen = new Map();
registerHooks({ load(url, context, next) { if (url.startsWith('file:') && !seen.has(url)) seen.set(url, statSync(fileURLToPath(url), { throwIfNoEntry: false })?.size ?? 0); return next(url, context); } });
process.on('exit', () => {
  const byPackage = {};
  for (const [url, size] of seen) { const name = /node_modules\\/((?:@[^/]+\\/)?[^/]+)\\/(?!.*node_modules\\/)/.exec(url)?.[1] ?? 'durable-harness'; byPackage[name] = (byPackage[name] ?? 0) + size; }
  process.stderr.write('\\n@@' + JSON.stringify({ modules: seen.size, bytes: [...seen.values()].reduce((s, n) => s + n, 0), byPackage }) + '\\n');
});
`
);
const entries = Object.entries(pkg.publishConfig.exports)
  .filter(([sub]) => sub !== './package.json')
  .map(([sub, target]) => [sub === '.' ? 'durable-harness' : `durable-harness${sub.slice(1)}`, join(root, typeof target === 'string' ? target : target.default)]);
console.log(`\ncold import, Node ${process.versions.node}, median of ${runs} processes: time, modules, bytes loaded, the heaviest packages`);
for (const [name, file] of entries) {
  const code = `const t = performance.now(); await import(${JSON.stringify(pathToFileURL(file).href)}); process.stdout.write(String(performance.now() - t));`;
  const run = (extra = []) => spawnSync(process.execPath, [...extra, '--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  const times = [];
  let failed;
  for (let i = 0; i < runs && !failed; i++) {
    const r = run();
    if (r.status === 0) times.push(Number(r.stdout));
    else failed = r.stderr.split('\n').find((l) => /Error/.test(l)) ?? `exit ${r.status}`;
  }
  if (failed) {
    console.log(`  ${name.padEnd(38)} failed: ${failed}`);
    continue;
  }
  const loaded = JSON.parse(run(['--import', pathToFileURL(hooks).href]).stderr.split('\n@@').at(-1));
  const heavy = Object.entries(loaded.byPackage).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p, n]) => `${p} ${kb(n)}`).join(', ');
  console.log(`  ${name.padEnd(38)} ${median(times).toFixed(1).padStart(6)} ms ${String(loaded.modules).padStart(5)} ${kb(loaded.bytes).padStart(10)}   ${heavy}`);
}
rmSync(dirname(hooks), { recursive: true, force: true });
