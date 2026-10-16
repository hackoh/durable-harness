import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A plain pi-durable program (test/fixtures/plain-pi-app.ts) whose only
 * changes are `openWorldStorage` and `resumeWith`, on world-local: SIGKILLed
 * in the middle of its tool calls, then started again. The backstop there is
 * the World's recovery at the next start, and the anchor the dead process's
 * commits carry (its pid, now gone): the restarted program finishes the turn
 * with its own opener, the safe tool rerun, the unsafe one interrupted.
 */

const APP = new URL('./fixtures/plain-pi-app.ts', import.meta.url).pathname;
const children = new Set<ChildProcess>();
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
});

function program(dataDir: string, args: string[]) {
  const proc = spawn(process.execPath, ['--import', 'tsx', APP, ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_DATA_DIR: dataDir, NODE_ENV: 'test' },
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
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`the program exited (${proc.exitCode ?? proc.signalCode}): ${err}`);
      if (Date.now() > deadline) throw new Error(`timed out: ${err}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { proc, next, exit, lines };
}

describe('a plain pi-durable program on a World storage', () => {
  it('survives SIGKILL in the middle of its tools: started again, it finishes the turn', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dh-pi-sigkill-'));
    const first = program(dataDir, ['run']);
    const { sessionId, pid } = await first.next((l) => typeof l.sessionId === 'string');
    await first.next((l) => l.tool === 'lookup_order');
    await first.next((l) => l.tool === 'refund');
    first.proc.kill('SIGKILL');
    expect((await first.exit).signal).toBe('SIGKILL');

    const again = program(dataDir, ['restart', sessionId]);
    const report = await again.next((l) => l.recovered === true, 120_000);
    expect((await again.exit).code).toBe(0);
    expect(report.pid).not.toBe(pid);
    // The safe tool ran again in the new process; the unsafe one did not.
    expect(again.lines().filter((l) => l.tool === 'lookup_order')).toHaveLength(1);
    expect(again.lines().filter((l) => l.tool === 'refund')).toHaveLength(0);
    expect(report.transcript).toContain('order 1234: shipped');
    expect(report.transcript).toContain('interrupted');
    expect(report.transcript).toContain('Order 1234 has shipped');
  }, 180_000);
});
