import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The documents SIGKILL drill: a tool makes its edit (a document, or a file
 * of the document-backed workspace), and its process is SIGKILLed before the
 * call's outcome reaches the log. A new OS process recovers the session from
 * the log alone. No phantom edit: a `safe` call's retry lands its edit once
 * (one revision, not two), and a `never` call comes back interrupted with the
 * document unchanged.
 */

const CHILD = new URL('./docs-sigkill-child.ts', import.meta.url).pathname;
const children = new Set<ChildProcess>();
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
});

function child(args: string[]) {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
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
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`child exited (${proc.exitCode ?? proc.signalCode}): ${err}`);
      if (Date.now() > deadline) throw new Error(`timed out: ${err}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { proc, next, exit };
}

async function drill(tool: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hw-docs-sigkill-'));
  const victim = child([dataDir, tool]);
  const { sessionId, pid } = await victim.next((l) => typeof l.sessionId === 'string');
  // The tool made its edit; its outcome is not in the log yet.
  await victim.next((l) => l.worked === true);
  victim.proc.kill('SIGKILL');
  expect((await victim.exit).signal).toBe('SIGKILL');
  const recoverer = child([dataDir, tool, '--recover', sessionId]);
  const report = await recoverer.next((l) => l.pid !== undefined, 120_000);
  expect((await recoverer.exit).code).toBe(0);
  expect(report.pid).not.toBe(pid);
  return report as { doc: { revision: number; value: { items: string[] } }; files: Record<string, string>; workspaceRevision: number; effects: { name: string; status: string; retryOf?: string; docs?: unknown[]; error?: { interrupted?: boolean } }[] };
}

describe('SIGKILL in the middle of a document tool, after its edit', () => {
  it('a safe tool (docTools update_todos) is retried, and its edit lands once', async () => {
    const r = await drill('update_todos');
    const calls = r.effects.filter((e) => e.name === 'tool.update_todos');
    console.log('[drill] update_todos:', JSON.stringify(calls), JSON.stringify(r.doc));
    expect(calls.at(-1)).toMatchObject({ status: 'completed', docs: [{ kind: 'app.todos', revision: 1 }] });
    expect(calls.at(-1)!.retryOf).toBeDefined();
    expect(r.doc).toEqual({ revision: 1, value: { items: ['milk'] } });
  }, 180_000);

  it('a never tool comes back interrupted, and the document is unchanged', async () => {
    const r = await drill('add_todo_never');
    const calls = r.effects.filter((e) => e.name === 'tool.add_todo_never');
    console.log('[drill] add_todo_never:', JSON.stringify(calls), JSON.stringify(r.doc));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 'failed', error: { interrupted: true } });
    expect(calls[0]!.docs).toBeUndefined();
    expect(r.doc).toEqual({ revision: 0, value: { items: [] } });
  }, 180_000);

  it('a workspace write (write_file) is retried, and the file lands once', async () => {
    const r = await drill('write_file');
    const calls = r.effects.filter((e) => e.name === 'tool.write_file');
    console.log('[drill] write_file:', JSON.stringify(calls), JSON.stringify(r.files));
    expect(calls.at(-1)).toMatchObject({ status: 'completed', docs: [{ kind: 'hw.workspace', revision: 1 }] });
    expect(r.files).toEqual({ '/workspace/notes.txt': 'from the drill\n' });
    expect(r.workspaceRevision).toBe(1);
  }, 180_000);

  it("Pi's own write (createCodingTools(virtual())) is retried, and the file lands once", async () => {
    const r = await drill('write');
    const calls = r.effects.filter((e) => e.name === 'tool.write');
    console.log('[drill] write:', JSON.stringify(calls), JSON.stringify(r.files));
    expect(calls.at(-1)).toMatchObject({ status: 'completed', docs: [{ kind: 'hw.workspace', revision: 1 }] });
    expect(calls.at(-1)!.retryOf).toBeDefined();
    expect(r.files).toEqual({ '/workspace/notes.txt': 'from the drill\n' });
    expect(r.workspaceRevision).toBe(1);
  }, 180_000);
});
