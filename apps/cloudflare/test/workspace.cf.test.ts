/**
 * The virtual workspace in workerd (`wrangler dev`, local Durable Objects):
 * no worker threads there, so just-bash runs in the session's own Durable
 * Object isolate, with the hardened limits and the same pinned command set,
 * and its files are in the session's log across invocations.
 *
 *   pnpm --filter harness-cloudflare test:cf
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIRTUAL_COMMANDS } from 'harness-world-hands/specs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDev } from '../scripts/dev-server.mjs';

interface Effect {
  name: string;
  status: string;
  error?: string;
  output?: unknown;
}
interface Summary {
  status: string;
  idle: boolean;
  effects: Effect[];
}

const port = 8800 + Math.floor(Math.random() * 90);
const persistTo = mkdtempSync(join(tmpdir(), 'harness-cf-ws-'));
let server: { url: string; kill(): Promise<unknown> };

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function settled(id: string, calls: number): Promise<Summary> {
  const t0 = Date.now();
  for (;;) {
    const s = await api<Summary>(`/sessions/${id}`);
    const tools = s.effects.filter((e) => e.name.startsWith('tool.'));
    if (s.status === 'failed') throw new Error(`session failed: ${JSON.stringify(s)}`);
    if (tools.length >= calls && s.idle && tools.every((e) => e.status === 'completed' || e.status === 'failed')) return s;
    if (Date.now() - t0 > 60_000) throw new Error(`timed out: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const out = (s: Summary, i: number) => {
  const e = s.effects.filter((x) => x.name.startsWith('tool.'))[i]!;
  return e.status === 'completed' ? String(e.output) : `error: ${e.error}`;
};

beforeAll(async () => {
  server = await startDev({ port, persistTo });
});
afterAll(async () => {
  await server?.kill();
  rmSync(persistTo, { recursive: true, force: true });
});

describe('the virtual workspace in workerd (the no-worker path)', () => {
  it('runs in the Durable Object, hardened, with the pinned commands, its files in the log across invocations', async () => {
    const { sessionId } = await api<{ sessionId: string }>('/sessions', { harness: 'workspace' });
    await api(`/sessions/${sessionId}/messages`, {
      text: JSON.stringify([
        { tool: 'where' },
        { tool: 'write_file', input: { path: 'a.txt', content: 'from workerd' } },
        { tool: 'bash', input: { command: "cat a.txt; echo; ls /bin | tr '\\n' ' '" } },
        { tool: 'bash', input: { command: 'printenv; sqlite3 x.db "select 1"; echo sqlite=$?' } },
        { tool: 'bash', input: { command: 'seq 1 20000 | wc -l' } },
      ]),
    });
    const first = await settled(sessionId, 5);
    expect(out(first, 0)).toBe('process');
    const listing = out(first, 2);
    expect(listing).toMatch(/^exit code: 0\nstdout:\nfrom workerd\n/);
    // The pinned set, less what just-bash's browser build (workerd's) has no code for.
    const bin = listing.split('\n').at(-1)!.trim().split(' ');
    expect(VIRTUAL_COMMANDS.filter((c) => !bin.includes(c))).toEqual(['tar', 'xan', 'yq']);
    expect(bin.filter((c) => !(VIRTUAL_COMMANDS as readonly string[]).includes(c))).toEqual([]);
    expect(out(first, 3)).toMatch(/sqlite=127/);
    expect(out(first, 3)).not.toMatch(/AI_GATEWAY|VERCEL_|CLOUDFLARE|HARNESS_/);
    // Hardened here: nothing in this realm can stop a command that never yields, so its counts are capped.
    expect(out(first, 4)).toMatch(/limit/);

    // Another invocation: the files come from the log.
    await api(`/sessions/${sessionId}/messages`, { text: JSON.stringify([{ tool: 'read_file', input: { path: 'a.txt' } }]) });
    const second = await settled(sessionId, 6);
    expect(out(second, 5)).toBe('from workerd');
    const files = await api<{ files: Record<string, unknown> | { path: string }[] }>(`/sessions/${sessionId}/files`);
    expect(JSON.stringify(files)).toContain('/workspace/a.txt');
  });
});
