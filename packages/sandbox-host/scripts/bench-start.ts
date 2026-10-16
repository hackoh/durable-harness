// Bench the sandbox lane's start (P6): fresh VM -> daemon /health, with the
// classic install (default image + writeFiles of the bundle) vs the VCR image.
//
//   node --env-file=<demo>/.env.local --experimental-strip-types scripts/bench-start.ts [--n 3] [--repo harness-host] [--modes classic,image]
//
// Needs Sandbox credentials in the environment (VERCEL_OIDC_TOKEN, or
// VERCEL_TEAM_ID/VERCEL_PROJECT_ID/VERCEL_TOKEN) and a built dist/ bundle
// whose version has been pushed as `<repo>:<version>`. Every VM it creates is
// deleted.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sandboxNameFor } from 'harness-world-hybrid';
import { VercelSandboxProvider } from 'harness-world-hybrid/sandbox';
import { imageOptions } from '../src/image.ts';
import { readBundle, startHost } from '../src/start.ts';

const { values: args } = parseArgs({
  options: { n: { type: 'string' }, repo: { type: 'string' }, modes: { type: 'string' }, bundle: { type: 'string' } },
});
const n = Number(args.n ?? 3);
const bundle = readBundle(args.bundle ?? join(import.meta.dirname, '../dist'));
const modes = (args.modes ?? 'classic,image').split(',');
const rows: Record<string, unknown>[] = [];

for (let i = 0; i < n; i++) {
  for (const mode of modes) {
    const provider = new VercelSandboxProvider({
      namePrefix: 'p6bench',
      timeoutMs: 3 * 60_000,
      ...(mode === 'image' ? imageOptions(args.repo ?? '1', bundle.version) : {}),
    });
    const key = `p6-${mode}-${randomUUID().slice(0, 8)}`;
    const t = Date.now();
    try {
      const started = await startHost(provider, key, {
        bundle,
        env: { VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN ?? '', HOST_KEEP_ENV: '0' },
        secretKey: 'p6-bench',
        healthTimeoutMs: 30_000,
      });
      const row = { mode, i, image: !!started.image, totalMs: Date.now() - t, ...started.ms };
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (err) {
      console.log(JSON.stringify({ mode, i, error: String(err).slice(0, 400) }));
    } finally {
      await provider.deleteVm(sandboxNameFor(key, 'p6bench')).catch((err) => console.log('delete failed', String(err)));
    }
  }
}

const p50 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
for (const mode of modes) {
  const mine = rows.filter((r) => r.mode === mode);
  if (!mine.length) continue;
  const pick = (k: string) => p50(mine.map((r) => Number(r[k] ?? 0)));
  console.log(`${mode}: n=${mine.length} total p50 ${pick('totalMs')} ms (open ${pick('open')}, install ${pick('install')}, health ${pick('health')})`);
}
