import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyDurableHarness } from '../src/next.ts';

/**
 * The same SIGKILL drill as pi-durable-sigkill.test.ts, through
 * `withDurableHarness`: fixtures/next-app is a Next.js app whose pi-durable
 * code registers its opener in lib/pi.ts and opens storages in its chat
 * route. The flow route withDurableHarness writes imports lib/pi.ts (not the
 * route), and a server that loads it after a SIGKILL finishes the turn.
 */

const APP = new URL('./fixtures/next-app/', import.meta.url).pathname;
const children = new Set<ChildProcess>();
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
});

function server(dataDir: string, args: string[], env: Record<string, string> = {}) {
  const proc = spawn(process.execPath, ['--import', 'tsx', join(APP, 'server.ts'), ...args], {
    cwd: APP,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_DATA_DIR: dataDir, NODE_ENV: 'test', ...env },
  });
  children.add(proc);
  let out = '';
  let err = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (err = (err + d).slice(-4000)));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => proc.once('exit', (code, signal) => (children.delete(proc), r({ code, signal }))));
  const lines = () => out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, any>);
  const next = async (pred: (l: Record<string, any>) => boolean, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = lines().find(pred);
      if (hit) return hit;
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`the server exited (${proc.exitCode ?? proc.signalCode}): ${err}`);
      if (Date.now() > deadline) throw new Error(`timed out: ${err}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { proc, next, exit, lines };
}

describe('pi-durable through withDurableHarness', () => {
  it('the flow route it writes registers the opener, and a server that loads it after a SIGKILL finishes the turn', async () => {
    applyDurableHarness({}, 'phase-development-server', APP);
    const route = readFileSync(join(APP, 'app/.well-known/workflow/v1/flow/route.js'), 'utf8');
    expect(route).toContain('import "../../../../../lib/pi";');
    expect(route).not.toContain('api/chat');
    // withDurableHarness keeps what it writes out of git.
    expect(readFileSync(join(APP, 'app/.well-known/workflow/v1/.gitignore'), 'utf8')).toBe('*\n');
    expect(existsSync(join(APP, 'app/.well-known/workflow/v1/config.json'))).toBe(true);

    const dataDir = await mkdtemp(join(tmpdir(), 'dh-pi-next-'));
    const first = server(dataDir, ['run'], { FIXTURE_HANG: '1' });
    const { sessionId } = await first.next((l) => typeof l.sessionId === 'string');
    await first.next((l) => l.tool === 'lookup_order');
    first.proc.kill('SIGKILL');
    expect((await first.exit).signal).toBe('SIGKILL');

    const again = server(dataDir, ['restart', sessionId]);
    const report = await again.next((l) => l.recovered === true, 120_000);
    expect((await again.exit).code).toBe(0);
    expect(again.lines().filter((l) => l.tool === 'lookup_order')).toHaveLength(1);
    expect(report.starts).toBe(2);
    expect(report.transcript).toContain('Order 1234 has shipped.');
  }, 180_000);
});
