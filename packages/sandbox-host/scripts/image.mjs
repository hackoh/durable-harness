#!/usr/bin/env node
// Build (and push) the sandbox lane's VCR image (P6): Node 24 +
// the daemon bundle + its compile cache under /opt/harness-image, tagged
// `<repo>:<bundle version>`. The deployment uses it when HARNESS_SANDBOX_IMAGE
// names the repo and a tag for its own bundle version exists (otherwise VMs
// fall back to the default image and the classic install).
//
//   node --experimental-strip-types scripts/image.mjs [--bundle <dir>] [--repo harness-host] [--push] [--scope vercel-labs] [--cwd <linked project dir>]
//
// --bundle defaults to a fresh `build.mjs` into dist/ (the same bundle the
// demo's build:sandbox-host produces: the version is content-addressed, so
// both sides agree as long as they build the same tree). Needs Docker (buildx,
// linux/amd64) and `vercel vcr login docker` for --push.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_IMAGE_REPO, dockerfile, imageLaunchScript, imageRef } from '../src/image.ts';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    bundle: { type: 'string' },
    repo: { type: 'string' },
    push: { type: 'boolean' },
    scope: { type: 'string' },
    cwd: { type: 'string' },
    'node-version': { type: 'string' },
  },
});

let bundle = args.bundle ? resolve(args.bundle) : undefined;
if (!bundle) {
  bundle = join(here, 'dist');
  execFileSync(process.execPath, [join(here, 'scripts/build.mjs')], { stdio: 'inherit' });
}
const { version } = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
const ctx = mkdtempSync(join(tmpdir(), 'harness-host-image-'));
mkdirSync(join(ctx, 'bundle'));
cpSync(bundle, join(ctx, 'bundle'), { recursive: true });
writeFileSync(join(ctx, 'launch.sh'), imageLaunchScript());
chmodSync(join(ctx, 'launch.sh'), 0o755);
writeFileSync(join(ctx, 'Dockerfile'), dockerfile());
// Node 24 for linux-x64, unpacked here rather than in the (emulated) build.
const nodeVersion = args['node-version'] ?? '24.19.0';
const tarball = join(tmpdir(), `node-v${nodeVersion}-linux-x64.tar.xz`);
if (!existsSync(tarball)) {
  const res = await fetch(`https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz`);
  if (!res.ok) throw new Error(`node ${nodeVersion}: ${res.status}`);
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
}
mkdirSync(join(ctx, 'node'));
execFileSync('tar', ['-xJf', tarball, '--strip-components=1', '-C', join(ctx, 'node')]);
for (const f of ['CHANGELOG.md', 'LICENSE', 'README.md']) rmSync(join(ctx, 'node', f), { force: true });
const ref = imageRef(args.repo ?? DEFAULT_IMAGE_REPO, version);
console.log(`image ${ref}: context ${ctx}`);

const vercel = ['vcr', 'build', 'docker', ctx, ref, ...(args.push ? ['--push'] : []), ...(args.scope ? ['--scope', args.scope] : [])];
execFileSync('vercel', vercel, { stdio: 'inherit', cwd: args.cwd ? resolve(args.cwd) : resolve(here, '../../apps/demo') });
console.log(`${args.push ? 'pushed' : 'built'} ${ref}`);
