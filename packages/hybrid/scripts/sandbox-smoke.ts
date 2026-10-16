/**
 * Live check of VercelSandboxProvider against a real Vercel Sandbox: sync a
 * workspace in, run a real-system command, sync the changes back, then
 * delete the sandbox. Needs Vercel credentials, e.g. from the demo app:
 *
 *   cd packages/hybrid && npx tsx --env-file=../../apps/demo/.env.local scripts/sandbox-smoke.ts
 */
import { Sandbox } from '@vercel/sandbox';
import { sandboxNameFor, syncIn, syncOut } from '../src/index.ts';
import { VercelSandboxProvider } from '../src/sandbox.ts';

const session = `smoke-${Date.now()}`;
const provider = new VercelSandboxProvider({ timeoutMs: 5 * 60_000 });
const started = Date.now();
const lap = (label: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);

try {
  const sbx = await provider.open(session);
  lap(`opened ${sbx.name}`);
  const fold = new Map([['/workspace/notes.txt', 'hello from the browser\nsecond line\n']]);
  const synced = await syncIn(sbx, '/workspace', fold, new Set(fold.keys()));
  lap(`synced in: ${synced.written.join(', ')}`);
  const again = await syncIn(sbx, '/workspace', fold, new Set(fold.keys()));
  if (again.written.length) throw new Error(`second sync rewrote ${again.written}`);
  lap('second sync wrote nothing (hashes match)');
  const result = await sbx.exec(
    'node -v && python3 --version && git --version && wc -l < notes.txt > count.txt && mkdir -p out && echo "made in the sandbox" > out/made.txt && printf "\\x00\\x01" > blob.bin && cat notes.txt',
    { cwd: '/workspace', timeoutMs: 60_000, onOutput: (s, d) => process.stdout.write(`[${s}] ${d}`) }
  );
  lap(`exit ${result.exitCode}`);
  const back = await syncOut(sbx, '/workspace', synced.baseline);
  console.log('synced out:', back);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  if (back.files['/workspace/out/made.txt'] !== 'made in the sandbox\n') throw new Error('made.txt did not come back');
  if ('/workspace/blob.bin' in back.files) throw new Error('binary file came back');
  lap('ok');
} finally {
  const name = sandboxNameFor(session);
  await Sandbox.get({ name })
    .then((s) => s.delete())
    .then(() => lap(`deleted ${name}`))
    .catch((err) => console.error(`cleanup of ${name} failed:`, err));
}
