/**
 * The kernel on the Cloudflare Durable Objects World, under local workerd
 * (`wrangler dev` with local Durable Object storage). The scenarios of
 * packages/harness-world/src/kernel.test.ts with its echo harness (no model,
 * no credential), driven over the Worker's HTTP API. A crash is a SIGKILL of
 * the whole wrangler process group; the restart reuses the persisted state.
 *
 *   pnpm --filter harness-cloudflare test:cf
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDev } from '../scripts/dev-server.mjs';

interface Server {
  url: string;
  kill(): Promise<unknown>;
}
interface Effect {
  key: string;
  name: string;
  status: string;
  input?: unknown;
  retryOf?: string;
  error?: string;
  interrupted?: boolean;
  placed: string[];
}
interface Summary {
  status: string;
  idle: boolean;
  submissions: { id: string; kind: string; text: string; placed: boolean; withdrawn: boolean }[];
  effects: Effect[];
}
interface LoggedEvent {
  eventId: string;
  eventType: string;
  correlationId?: string;
  createdAt: string;
}

const port = 8900 + Math.floor(Math.random() * 90);
const persistTo = mkdtempSync(join(tmpdir(), 'harness-cf-'));
let server: Server;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}
const start = async () => (await api<{ sessionId: string }>('/sessions', { harness: 'echo' })).sessionId;
const send = async (id: string, text: string) => (await api<{ submissionId: string }>(`/sessions/${id}/messages`, { text })).submissionId;
const inspect = (id: string) => api<Summary>(`/sessions/${id}`);

async function until<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out');
    await sleep(100);
  }
}
const settled = (id: string, n: number, timeoutMs?: number) =>
  until(async () => {
    const s = await inspect(id);
    const tools = s.effects.filter((e) => e.name.startsWith('tool.'));
    return tools.length >= n && s.idle && tools.every((e) => e.status === 'completed' || e.status === 'failed') ? s : undefined;
  }, timeoutMs);

/** The log is dense from slot 1 and its timestamps never go backwards. */
function expectWellFormed(log: LoggedEvent[]) {
  log.forEach((e, i) => {
    expect(e.eventId).toBe(`evnt_${String(i + 1).padStart(26, '0')}`);
    if (i > 0) expect(Date.parse(e.createdAt)).toBeGreaterThanOrEqual(Date.parse(log[i - 1]!.createdAt));
  });
}

async function restart() {
  await server.kill();
  server = await startDev({ port, persistTo });
}

beforeAll(async () => {
  server = await startDev({ port, persistTo });
});
afterAll(async () => {
  await server?.kill();
  rmSync(persistTo, { recursive: true, force: true });
});

describe('harness-world kernel on the Cloudflare World (local workerd)', () => {
  it('turns a session into a run whose steps are the transcript', async () => {
    const id = await start();
    await send(id, 'hello');
    await send(id, 'world');
    const s = await settled(id, 2);
    expect(s.effects.map((e) => [e.key, e.name, e.status])).toEqual([
      ['model:0', 'model', 'completed'],
      ['tool:model:0', 'tool.echo', 'completed'],
      ['model:1', 'model', 'completed'],
      ['tool:model:1', 'tool.echo', 'completed'],
    ]);
    expect(s.effects.filter((e) => e.name === 'tool.echo').map((e) => e.input)).toEqual(['HELLO', 'WORLD']);
    expect(s.submissions.every((x) => x.placed)).toBe(true);
    const log = await api<LoggedEvent[]>(`/sessions/${id}/events`);
    expect(log.slice(0, 3).map((e) => e.eventType)).toEqual(['run_created', 'run_started', 'hook_created']);
    expectWellFormed(log);
  });

  it('folds concurrent submissions written from a stale view (bump and report)', async () => {
    const id = await start();
    const texts = ['a', 'b', 'c', 'd', 'e', 'f'];
    const ids = await Promise.all(texts.map((t) => send(id, t)));
    expect(new Set(ids).size).toBe(texts.length);
    const s = await settled(id, texts.length);
    expect(s.submissions.filter((x) => x.placed)).toHaveLength(texts.length);
    expect(s.effects.filter((e) => e.name === 'tool.echo').map((e) => e.input).sort()).toEqual(texts.map((t) => t.toUpperCase()));
    expectWellFormed(await api<LoggedEvent[]>(`/sessions/${id}/events`));
  });

  it('withdraws a submission no model step has placed yet', async () => {
    const id = await start();
    await send(id, 'slow:3000 first');
    await until(async () => (await inspect(id)).effects.some((e) => e.name === 'tool.echo' && e.status === 'running'));
    const second = await send(id, 'second');
    expect((await api<{ result: string }>(`/sessions/${id}/withdraw`, { submissionId: second })).result).toBe('withdrawn');
    const s = await settled(id, 1);
    await sleep(1000);
    const after = await inspect(id);
    expect(after.effects.filter((e) => e.name === 'tool.echo')).toHaveLength(1);
    expect(after.submissions.find((x) => x.id === second)).toMatchObject({ placed: false, withdrawn: true });
    expect(s.status).toBe('running');
  });

  it('streams live events next to the log', async () => {
    const id = await start();
    await send(id, 'one');
    await send(id, 'two');
    await settled(id, 2);
    const live = await api<{ type: string; key?: string }[]>(`/sessions/${id}/live`);
    expect(live.filter((l) => l.type === 'turn_end').map((l) => l.key)).toEqual(['model:0', 'model:1']);
  });

  it("gives a replay: 'never' tool killed mid-call an interrupted result, recovered by the run object's alarm", async () => {
    const id = await start();
    await send(id, 'slow:8000 pay');
    await until(async () => (await inspect(id)).effects.some((e) => e.name === 'tool.echo' && e.status === 'running'));
    await sleep(500);
    const killedAt = Date.now();
    await restart();
    const restartedAt = Date.now();
    // No request touches the session: only the object's alarm can wake it.
    await sleep(20_000);
    const pokedAt = Date.now();
    const log = await api<LoggedEvent[]>(`/sessions/${id}/events`);
    const recovered = log.filter((e) => Date.parse(e.createdAt) > restartedAt && Date.parse(e.createdAt) < pokedAt);
    expect(recovered.length).toBeGreaterThan(0);
    const s = await settled(id, 1);
    const tools = s.effects.filter((e) => e.name === 'tool.echo');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ status: 'failed', interrupted: true });
    // The session goes on: the next message is a normal turn.
    await send(id, 'after');
    const next = await settled(id, 2);
    expect(next.effects.filter((e) => e.name === 'tool.echo').at(-1)).toMatchObject({ status: 'completed', input: 'AFTER' });
    expectWellFormed(await api<LoggedEvent[]>(`/sessions/${id}/events`));
    console.log(`never: first recovered event ${Date.parse(recovered[0]!.createdAt) - killedAt} ms after the kill`);
  });

  it("reruns a replay: 'safe' tool killed mid-call", async () => {
    const id = await start();
    await send(id, 'safe slow:6000 again');
    await until(async () => (await inspect(id)).effects.some((e) => e.name === 'tool.echo_safe' && e.status === 'running'));
    await sleep(500);
    await restart();
    const s = await settled(id, 1, 60_000);
    const tools = s.effects.filter((e) => e.name === 'tool.echo_safe');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ status: 'completed', input: 'SAFE SLOW:6000 AGAIN' });
    expect(tools[0]!.retryOf).toBeTruthy();
    expectWellFormed(await api<LoggedEvent[]>(`/sessions/${id}/events`));
  });

  it('closes a session: run_completed, and the run object drops its signals', async () => {
    const id = await start();
    await send(id, 'bye');
    await settled(id, 1);
    await api(`/sessions/${id}/close`, {});
    expect((await inspect(id)).status).toBe('completed');
    const object = await api<{ value: { signals: unknown[] } }>(`/sessions/${id}/object`);
    expect(object.value.signals).toEqual([]);
  });
});
