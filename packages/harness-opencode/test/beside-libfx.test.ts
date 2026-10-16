import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';

/**
 * OpenCode beside libfx in one process (test/beside-libfx.ts, in a process
 * of its own so a crash is its exit, not this runner's): a real libfx engine
 * runs a turn, then OpenCode drives a session, ten times, with freed memory
 * reused in between. OpenCode must not change the process's environment
 * once libfx is running: libfx's native addon reads the environment through
 * a pointer it kept, which a new variable leaves pointing at freed memory
 * (the process then crashes on libfx's next lookup). The script fails on any
 * change to `process.env`, which catches the cause even in a run the crash
 * would have spared.
 */

const SCRIPT = fileURLToPath(new URL('./beside-libfx.ts', import.meta.url));
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'oc-beside-libfx-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('runs beside a libfx engine in one process without changing its environment: ten drives between libfx turns, no crash', { timeout: 180_000 }, async () => {
  const env = { ...process.env };
  // The script's models are local stand-ins: no credential of this machine reaches it.
  delete env.AI_GATEWAY_API_KEY;
  delete env.VERCEL_OIDC_TOKEN;
  const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT, dir, '10'], { cwd: PACKAGE, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  expect({ ...exit, stdout: stdout.trim() }, stderr).toEqual({ code: 0, signal: null, stdout: 'ok' });
});
