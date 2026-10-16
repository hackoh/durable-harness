/**
 * Adversarial checks of durable-harness/pi-durable: a pi-durable program made
 * durable with only the documented change (`openWorldStorage` + `resumeWith`),
 * pushed where it can break.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTask, defineTool, Harness, type Storage, type ToolRegistration } from '@earendil-works/pi-durable';
import type { World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { recoverSessions } from 'harness-world';
import { journalHead, WorldStorage } from 'pi-world';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chatRoute, openWorldReader, openWorldStorage, resumeWith, StorageFenced } from '../src/pi-durable.ts';
import { dispatch, registerQueue } from '../src/registry.ts';
import { getWorld } from '../src/world.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(50);
  }
}

/** A Pi app: a scripted faux model, a registry with `tools`, and its opener (counted). */
function piApp(answers: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0], tools: ToolRegistration[] = []) {
  const faux = fauxProvider();
  faux.setResponses(answers);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry = createRegistry();
  if (tools.length) registry.install(defineExtension({ name: 'app', tools }));
  const opened: string[] = [];
  const open = (storage: Storage) => (opened.push(String((storage as { sessionId?: string }).sessionId)), Harness.open(storage, { models, registry }, ctx));
  return { faux, open, opened, agent: { model: { provider: model.provider, modelId: model.id } } };
}

/** A tool that runs until `release()` (or its call is aborted), writing output every `everyMs` when given. */
function gate(name: string, options: { replay?: 'safe'; everyMs?: number } = {}) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let started = 0;
  let finished = 0;
  const tool = defineTool({
    name,
    description: `${name}.`,
    parameters: Type.Object({}),
    ...(options.replay ? { replay: options.replay } : {}),
    execute: async (_args, api, context) => {
      started++;
      const aborted = new Promise((r) => context.abortSignal?.addEventListener('abort', r, { once: true }));
      for (let i = 0; ; i++) {
        const tick = options.everyMs ? sleep(options.everyMs).then(() => 'tick') : new Promise(() => {});
        const why = await Promise.race([released.then(() => 'done'), aborted.then(() => 'aborted'), tick]);
        if (why !== 'tick') break;
        api.output(`tick ${i}\n`);
      }
      finished++;
      return { content: [{ type: 'text', text: `${name} done` }] };
    },
  }) as ToolRegistration;
  return { tool, started: () => started, finished: () => finished, release: () => release() };
}

const abortable = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
  });

describe('durable-harness/pi-durable, adversarial (world-local)', () => {
  beforeAll(() => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';
    process.env.WORKFLOW_LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'dh-pi-adv-'));
  });
  afterAll(async () => {
    await ((await getWorld()) as { close?: () => Promise<void> }).close?.();
  });

  it('background work a turn started (Pi example 23: a background task) is finished after the route closes, without a wake loop', async () => {
    let runs = 0;
    let finished = 0;
    // A background task that takes a while, as a background subagent's reporter or Pi's own background compaction does.
    const Slow = defineTask<null, { phase: 'work' }, null>({
      name: 'app.slow',
      version: 1,
      initial: () => ({ phase: 'work' }),
      phases: {
        work: async (_task, runtime, context) => {
          runs++;
          await abortable(600, context.abortSignal);
          finished++;
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
        },
      },
      abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
    });
    const spawn = defineTool({
      name: 'spawn',
      description: 'Start background work.',
      parameters: Type.Object({}),
      execute: async (_args, api, context) => {
        await api.createTask(Slow, null, { ownership: { kind: 'conversation' }, background: true }, context);
        return { content: [{ type: 'text', text: 'started' }] };
      },
    }) as ToolRegistration;
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage([fauxToolCall('spawn', {})], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Started it.')])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'bg', tools: [spawn], tasks: [Slow] }));
    let opens = 0;
    const open = resumeWith((storage: Storage) => (opens++, Harness.open(storage, { models, registry }, ctx)), { name: 'pi-adv-bg' });

    // The documented route: open, submit, wait for the submission, close.
    const storage = await openWorldStorage(undefined, { name: 'pi-adv-bg' });
    const harness = await open(storage);
    const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
    const submission = await root.submit({ type: 'input', content: 'Start it.' }, ctx);
    expect((await submission.wait(ctx)).status).toBe('done');
    await harness.close(ctx);

    const reader = openWorldReader(storage.sessionId);
    await until(async () => {
      await reader.refresh();
      return !(await reader.snapshot()).unfinished;
    }).catch((e) => { throw new Error(`${e.message}: opens=${opens} runs=${runs} finished=${finished}`); });
    expect(finished).toBe(1);
    // The route's open plus a wake or two, not a wake per close.
    await sleep(500);
    expect(opens).toBeLessThanOrEqual(3);
    expect(runs).toBeLessThanOrEqual(2);
  }, 60_000);

  it('a route that returns right after submit keeps its invocation alive (waitUntil) until the session has no work', async () => {
    const kept: { promise: Promise<unknown>; settled: boolean }[] = [];
    const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
    const g = globalThis as { [REQUEST_CONTEXT]?: unknown };
    const request = { waitUntil: (p: Promise<unknown>) => { const k = { promise: p, settled: false }; kept.push(k); void p.then(() => (k.settled = true)); } };
    g[REQUEST_CONTEXT] = { get: () => request };
    try {
      const work = gate('work', { replay: 'safe' });
      const app = piApp([fauxAssistantMessage([fauxToolCall('work', {})], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Done.')])], [work.tool]);
      resumeWith(app.open, { name: 'pi-adv-keepalive' });
      const storage = await openWorldStorage(undefined, { name: 'pi-adv-keepalive' });
      const harness = await app.open(storage);
      const root = await harness.root(ctx, { agent: app.agent });
      expect(kept).toHaveLength(0); // creating the root leaves no work
      await root.submit({ type: 'input', content: 'Work.' }, ctx);
      // The route returns here, without after() or close.
      await until(() => work.started() === 1);
      expect(kept).toHaveLength(1);
      await sleep(200);
      expect(kept[0]!.settled).toBe(false);
      work.release();
      await until(() => kept[0]!.settled);
      await harness.close(ctx);
      expect(kept).toHaveLength(1);
    } finally {
      delete g[REQUEST_CONTEXT];
    }
  });

  it('work this deployment cannot run (a task whose extension is gone) does not pin a request open, and the chat stream still ends', async () => {
    const kept: { promise: Promise<unknown>; settled: boolean }[] = [];
    const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
    const g = globalThis as { [REQUEST_CONTEXT]?: unknown };
    // A session with a task an earlier deployment's extension defined: not installed here.
    const Legacy = defineTask<null, { phase: 'work' }, null>({
      name: 'app.legacy',
      version: 1,
      initial: () => ({ phase: 'work' }),
      phases: { work: (_t, _runtime, context) => abortable(60_000, context.abortSignal) },
      abort: (_t, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
    });
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage([fauxText('Queued it.')])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const oldRegistry = createRegistry();
    oldRegistry.install(defineExtension({ name: 'legacy', tasks: [Legacy] }));
    const first = await openWorldStorage(undefined, { name: 'pi-adv-blocked', recoverAfterMs: 1_000 });
    const h1 = await Harness.open(first, { models, registry: oldRegistry }, ctx);
    const r1 = await h1.root(ctx, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
    await r1.commit((tx) => tx.createTask(Legacy, null, { ownership: { kind: 'conversation' } }), ctx);
    await sleep(100);
    first.abandon();

    const app = piApp(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxText('Here.')])));
    resumeWith(app.open, { name: 'pi-adv-blocked' });
    const request = { waitUntil: (p: Promise<unknown>) => { const k = { promise: p, settled: false }; kept.push(k); void p.then(() => (k.settled = true)); } };
    g[REQUEST_CONTEXT] = { get: () => request };
    try {
      const storage = await openWorldStorage(first.sessionId, { name: 'pi-adv-blocked', recoverAfterMs: 1_000 });
      const harness = await app.open(storage);
      expect((await harness.inspect(ctx)).tasks.map((t) => t.state.kind)).toEqual(['blocked']);
      const root = await harness.root(ctx, { agent: app.agent });
      await root.submit({ type: 'write', entry: { kind: 'app.note', data: 'hello' } }, ctx);
      expect(kept.length).toBeGreaterThan(0);
      // Nothing this process can run: the request is let go by the deadline at the latest, not at its maxDuration.
      await until(() => kept.every((k) => k.settled), 5_000).catch(() => {
        throw new Error(`kept alive: ${kept.filter((k) => !k.settled).length} of ${kept.length}`);
      });
      await harness.close(ctx);
    } finally {
      delete g[REQUEST_CONTEXT];
    }
    const route = chatRoute({ open: app.open, agent: app.agent, authorize: 'public', name: 'pi-adv-blocked', recoverAfterMs: 1_000 });
    const res = await route.POST(post({ sessionId: first.sessionId, text: 'Still there?' }));
    const events = await Promise.race([sse(res), sleep(8_000).then(() => 'hung' as const)]);
    expect(events).not.toBe('hung');
  }, 30_000);

  it("Pi's own background compaction, still running when the route closes, is finished by a wake", async () => {
    let summaries = 0;
    const long = 'word '.repeat(400);
    const answer = async (context: unknown) => {
      if (JSON.stringify(context).includes('context summarization assistant')) {
        summaries++;
        await sleep(700);
        return fauxAssistantMessage([fauxText('SUMMARY of the chat.')]);
      }
      return fauxAssistantMessage([fauxText(long)]);
    };
    const faux = fauxProvider({ models: [{ id: 'small', contextWindow: 4000 }] });
    faux.setResponses(Array.from({ length: 20 }, () => answer));
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const registry = createRegistry();
    let opens = 0;
    // Background compaction above 4000 - 1000 - 2800 = 200 tokens; blocking above 3000.
    const settings = { compaction: { enabled: true, reserveTokens: 1000, backgroundTokens: 2800, keepRecentTokens: 50 } };
    const open = resumeWith((storage: Storage) => (opens++, Harness.open(storage, { models, registry, settings }, ctx)), { name: 'pi-adv-compact' });

    const storage = await openWorldStorage(undefined, { name: 'pi-adv-compact' });
    const harness = await open(storage);
    const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
    for (const text of ['One.', 'Two.']) expect((await (await root.submit({ type: 'input', content: text }, ctx)).wait(ctx)).status).toBe('done');
    const live = (await harness.inspect(ctx)).tasks.map((t) => t.record.kind);
    expect(live).toContain('pi.compaction');
    await harness.close(ctx);

    const reader = openWorldReader(storage.sessionId);
    const snap = await until(async () => {
      await reader.refresh();
      const s = await reader.snapshot();
      return !s.unfinished ? s : undefined;
    }).catch((e) => {
      throw new Error(`${e.message}: opens=${opens} summaries=${summaries}`);
    });
    expect(JSON.stringify(snap.entries)).toContain('SUMMARY of the chat.');
    expect(opens).toBeLessThanOrEqual(3);
  }, 60_000);
});

describe('two processes on one session (two World instances on one data directory)', () => {
  const worlds: LocalWorld[] = [];
  afterEach(async () => {
    for (const w of worlds.splice(0)) await w.close?.();
  });
  const pair = () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dh-pi-adv-pair-'));
    const a = createWorld({ dataDir, recoverActiveRuns: false });
    const b = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(a, b);
    return { a, b };
  };

  it('two requests that open and submit at once: one wins, the other is fenced and nothing of it lands; its retry with the same requestId lands once', async () => {
    const { a, b } = pair();
    const appA = piApp(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxText('from A')])));
    const appB = piApp(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxText('from B')])));
    const first = await openWorldStorage(undefined, { world: a, name: 'pi-adv-race' });
    const id = first.sessionId;
    const h0 = await appA.open(first);
    await (await h0.root(ctx, { agent: appA.agent })).submit({ type: 'write', entry: { kind: 'app.note', data: 'start' } }, ctx);
    await h0.close(ctx);

    const request = async (world: World, app: ReturnType<typeof piApp>, text: string) => {
      const harness = await app.open(await openWorldStorage(id, { world, name: 'pi-adv-race' }));
      try {
        const root = await harness.root(ctx, { agent: app.agent });
        const submission = await root.submit({ type: 'input', content: text, requestId: text }, ctx);
        const settled = await submission.wait(ctx);
        return { ok: settled.status };
      } catch (error) {
        return { error };
      } finally {
        await harness.close(ctx).catch(() => {});
      }
    };
    const [ra, rb] = await Promise.all([request(a, appA, 'ask-a'), request(b, appB, 'ask-b')]);
    const outcomes = [ra, rb];
    // At most one was refused, as Pi's one owner rule says; a refusal is StorageFenced.
    for (const o of outcomes) if ('error' in o) expect(o.error).toBeInstanceOf(StorageFenced);
    expect(outcomes.some((o) => 'ok' in o)).toBe(true);

    // The refused one retries on a fresh open, with the same requestId.
    for (const [o, world, app, text] of [[ra, a, appA, 'ask-a'], [rb, b, appB, 'ask-b']] as const) {
      if ('error' in o) expect(await request(world, app, text)).toMatchObject({ ok: 'done' });
    }
    const reader = openWorldReader(id, { world: a });
    await reader.refresh();
    const snap = await reader.snapshot();
    expect(snap.unfinished).toBe(false);
    const users = snap.entries.filter((e) => e.kind === 'pi.user').map((e) => JSON.stringify(e.model));
    // Each input once, each answered.
    expect(users.filter((u) => u.includes('ask-a'))).toHaveLength(1);
    expect(users.filter((u) => u.includes('ask-b'))).toHaveLength(1);
    expect(snap.entries.filter((e) => e.kind === 'pi.assistant')).toHaveLength(2);
  }, 60_000);

  it('a process killed in the middle of a compaction: the next start finishes it', async () => {
    const { a, b } = pair();
    const name = 'pi-adv-compact-kill';
    const long = 'word '.repeat(300);
    let summarizing = 0;
    const app = (slow: boolean) => {
      const faux = fauxProvider({ models: [{ id: 'small', contextWindow: 100_000 }] });
      faux.setResponses(Array.from({ length: 10 }, () => async (context: unknown) => {
        if (JSON.stringify(context).includes('context summarization assistant')) {
          summarizing++;
          if (slow) await new Promise(() => {}); // the process dies in here
          return fauxAssistantMessage([fauxText('SUMMARY after restart.')]);
        }
        return fauxAssistantMessage([fauxText(long)]);
      }));
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      const opened: string[] = [];
      const settings = { compaction: { enabled: true, keepRecentTokens: 50 } };
      return { opened, model: faux.getModel(), open: (storage: Storage) => (opened.push(String((storage as { sessionId?: string }).sessionId)), Harness.open(storage, { models, registry, settings }, ctx)) };
    };
    const first = app(true);
    const storage = await openWorldStorage(undefined, { world: a, name });
    const harness = await first.open(storage);
    const root = await harness.root(ctx, { agent: { model: { provider: first.model.provider, modelId: first.model.id } } });
    for (const text of ['One.', 'Two.']) await (await root.submit({ type: 'input', content: text }, ctx)).wait(ctx);
    await root.compact('Keep it short', ctx);
    await until(() => summarizing === 1);
    storage.abandon();
    expect((await journalHead(a, storage.sessionId, ctx)).unfinished).toBe(true);

    const second = app(false);
    resumeWith(second.open, { world: b, name });
    registerQueue(b);
    await b.start?.();
    expect(await recoverSessions(b as World)).toBeGreaterThan(0);
    const reader = openWorldReader(storage.sessionId, { world: b });
    const snap = await until(async () => {
      await reader.refresh();
      const s = await reader.snapshot();
      return !s.unfinished ? s : undefined;
    });
    expect(JSON.stringify(snap.entries)).toContain('SUMMARY after restart.');
    expect(second.opened).toEqual([storage.sessionId]);
  }, 60_000);

  it('a session written before durable-harness/pi-durable had a backstop (commits with no anchor, the run named pi-durable) is finished by resumeWith(open) with no name', async () => {
    const { a, b } = pair();
    const hang = gate('lookup', { replay: 'safe' });
    const before = piApp([fauxAssistantMessage([fauxToolCall('lookup', {})], { stopReason: 'toolUse' })], [hang.tool]);
    // As an older release wrote it: a raw World storage, no backstop, no anchor on its commits.
    const id = await WorldStorage.create(a, { name: 'pi-durable' });
    const legacy = await WorldStorage.open(a, id, { name: 'pi-durable' });
    const h = await before.open(legacy);
    await (await h.root(ctx, { agent: before.agent })).submit({ type: 'input', content: 'Look it up.' }, ctx);
    await until(() => hang.started() === 1);
    legacy.abandon();
    expect((await journalHead(a, id, ctx)).last?.anchor).toBeUndefined();

    const done = gate('lookup', { replay: 'safe' });
    done.release();
    const now = piApp([fauxAssistantMessage([fauxText('Found it.')])], [done.tool]);
    resumeWith(now.open, { world: b });
    registerQueue(b);
    await b.start?.();
    expect(await recoverSessions(b as World)).toBeGreaterThan(0);
    const reader = openWorldReader(id, { world: b });
    await until(async () => {
      await reader.refresh();
      const s = await reader.snapshot();
      return !s.unfinished && JSON.stringify(s.entries).includes('Found it.');
    });
    expect(now.opened).toEqual([id]);
    hang.release();
  }, 60_000);
});

async function sse(response: Response): Promise<{ event?: string; data?: any }[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const m: { event?: string; data?: any } = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) m.event = line.slice(7);
        if (line.startsWith('data: ')) m.data = JSON.parse(line.slice(6));
      }
      return m;
    })
    .filter((m) => m.event || m.data);
}
const post = (body: unknown) => new Request('http://local/api/chat', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const textOf = (events: { data?: any }[]) => events.filter((e) => e.data?.type === 'text').map((e) => e.data.delta).join('');

describe('chatRoute across two processes', () => {
  const worlds: LocalWorld[] = [];
  afterEach(async () => {
    for (const w of worlds.splice(0)) await w.close?.();
  });

  it('a steer from another process takes the session over; the first stream follows the log to the end, and a reconnect anywhere follows it too', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dh-pi-adv-steer-'));
    const a = createWorld({ dataDir, recoverActiveRuns: false });
    const b = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(a, b);
    const name = 'pi-adv-steer';
    const toolA = gate('lookup', { replay: 'safe' });
    const appA = piApp([fauxAssistantMessage([fauxText('Looking. '), fauxToolCall('lookup', {})], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('A answers.')])], [toolA.tool]);
    const toolB = gate('lookup', { replay: 'safe' });
    const appB = piApp([fauxAssistantMessage([fauxText('Steered: B answers.')])], [toolB.tool]);
    const routeA = chatRoute({ open: appA.open, agent: appA.agent, authorize: 'public', world: a, name });
    const routeB = chatRoute({ open: appB.open, agent: appB.agent, authorize: 'public', world: b, name });

    const resA = await routeA.POST(post({ text: 'Look it up.' }));
    const sessionId = resA.headers.get('x-session-id')!;
    const eventsA = sse(resA);
    await until(() => toolA.started() === 1);
    // The steer lands on another instance: its open takes the session over.
    const resB = await routeB.POST(post({ sessionId, text: 'Use the other source.', kind: 'steer' }));
    expect(resB.status).toBe(200);
    const eventsB = sse(resB);
    await until(() => toolB.started() === 1);
    // A reconnect on the first instance follows the log; it opens nothing.
    const opensA = appA.opened.length;
    const followed = await routeA.GET(new Request(`http://local/api/chat?sessionId=${sessionId}`));
    expect(followed.status).toBe(200);
    const eventsFollowed = sse(followed);
    toolA.release(); // the first holder's late tool result: refused
    toolB.release();
    const [ea, eb, ef] = await Promise.all([eventsA, eventsB, eventsFollowed]);
    for (const events of [ea, eb, ef]) {
      expect(events.at(-2)?.data).toEqual({ type: 'idle' });
      expect(events.at(-1)?.event).toBe('end');
    }
    expect(textOf(ea)).toContain('Steered: B answers.');
    expect(textOf(ef)).toContain('Steered: B answers.');
    expect(textOf(eb)).toContain('Steered: B answers.');
    expect(appA.opened.length).toBe(opensA);
    const reader = openWorldReader(sessionId, { world: a });
    await reader.refresh();
    const snap = await reader.snapshot();
    expect(snap.unfinished).toBe(false);
    expect(JSON.stringify(snap.entries)).not.toContain('A answers.');
    expect(JSON.stringify(snap.entries)).toContain('Use the other source.');
  }, 60_000);
});

describe('on Vercel\'s rules (a queue that outlives the process: companion wakes), on world-local', () => {
  const worlds: LocalWorld[] = [];
  let vercel: string | undefined;
  beforeAll(() => {
    vercel = process.env.VERCEL;
    process.env.VERCEL = '1';
  });
  afterAll(async () => {
    if (vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = vercel;
    for (const w of worlds.splice(0)) await w.close?.();
  });
  const worldPair = async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dh-pi-adv-vercel-'));
    const a = createWorld({ dataDir, recoverActiveRuns: false });
    const b = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(a, b);
    return { a, b };
  };
  const meta = (queueName: string) => ({ attempt: 1, queueName, messageId: `msg_${Math.random().toString(36).slice(2)}` });

  it('a request killed right after submit (before Pi commits anything more) is resumed by the wake behind its anchor', async () => {
    const { a, b } = await worldPair();
    const name = 'pi-adv-killed';
    const app = piApp([fauxAssistantMessage([fauxText('Answered.')])]);
    const storage = await openWorldStorage(undefined, { world: a, name, recoverAfterMs: 1_000 });
    const queued: unknown[] = [];
    const queue = a.queue.bind(a);
    a.queue = (async (q, message, opts) => (queued.push({ q, message, opts }), queue(q, message, opts))) as World['queue'];
    const harness = await app.open(storage);
    const root = await harness.root(ctx, { agent: app.agent });
    await root.submit({ type: 'input', content: 'Hello', requestId: 'r1' }, ctx);
    // Killed: nothing more is committed, no close entry.
    storage.abandon();
    const head = await journalHead(a, storage.sessionId, ctx);
    expect(head.unfinished).toBe(true);
    expect(head.last?.anchor).toMatchObject({ k: 'deadline' });
    // The companion wake went out before that commit.
    expect(queued).toHaveLength(1);
    const wake = queued[0] as { q: string; message: unknown; opts: { delaySeconds: number } };
    expect(wake.opts.delaySeconds).toBe(6);

    // Its delivery, in another instance, after the deadline.
    const other = piApp([fauxAssistantMessage([fauxText('Answered.')])]);
    resumeWith(other.open, { world: b, name });
    await sleep(1_100);
    await dispatch(b, wake.message, meta(wake.q));
    const reader = openWorldReader(storage.sessionId, { world: b });
    await reader.refresh();
    const snap = await reader.snapshot();
    expect(snap.unfinished).toBe(false);
    expect(JSON.stringify(snap.entries)).toContain('Answered.');
    expect(other.opened).toEqual([storage.sessionId]);
  }, 60_000);

  it('the backstop firing while a live holder elsewhere keeps committing acks; once the holder falls silent past its deadline it takes over and the holder is fenced', async () => {
    const { a, b } = await worldPair();
    const name = 'pi-adv-live';
    const chat = gate('chatty', { replay: 'safe', everyMs: 50 });
    const app = piApp([fauxAssistantMessage([fauxToolCall('chatty', {})], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('A done.')])], [chat.tool]);
    const queued: { q: string; message: unknown }[] = [];
    const queue = a.queue.bind(a);
    a.queue = (async (q, message, opts) => (queued.push({ q, message }), queue(q, message, opts))) as World['queue'];
    const storage = await openWorldStorage(undefined, { world: a, name, recoverAfterMs: 1_000 });
    const harness = await app.open(storage);
    const root = await harness.root(ctx, { agent: app.agent });
    const submission = await root.submit({ type: 'input', content: 'Go.' }, ctx);
    await until(() => chat.started() === 1);

    const otherTool = gate('chatty', { replay: 'safe' });
    otherTool.release();
    const other = piApp([fauxAssistantMessage([fauxText('B done.')])], [otherTool.tool]);
    resumeWith(other.open, { world: b, name });
    // Well past the first anchor's deadline, while the holder renews on its tool's output.
    await sleep(2_500);
    expect(queued.length).toBeGreaterThan(2);
    await dispatch(b, queued[0]!.message, meta(queued[0]!.q));
    expect(other.opened).toEqual([]);

    // The holder falls silent (a process frozen mid-tool): past its deadline the next wake takes over.
    const frozen = storage as unknown as { commit: (...args: unknown[]) => Promise<unknown> };
    const commit = frozen.commit.bind(storage);
    let hold!: () => void;
    const thaw = new Promise<void>((r) => (hold = r));
    frozen.commit = async (...args: unknown[]) => (await thaw, commit(...args));
    await sleep(1_200);
    await dispatch(b, queued.at(-1)!.message, meta(queued.at(-1)!.q));
    expect(other.opened).toEqual([storage.sessionId]);
    // The thawed holder's next commit is refused: nothing of its late work lands.
    hold();
    chat.release();
    const refused = await submission.wait(ctx).then(() => undefined, (e: unknown) => e);
    // Pi poisons the session on the refused commit; the storage says why.
    expect(String(refused)).toMatch(/poisoned|StorageFenced|committed to by another process/);
    expect(storage.isFenced).toBe(true);
    await harness.close(ctx).catch(() => {});
    const reader = openWorldReader(storage.sessionId, { world: b });
    await reader.refresh();
    const snap = await reader.snapshot();
    expect(snap.unfinished).toBe(false);
    const text = JSON.stringify(snap.entries);
    expect(text).toContain('B done.');
    expect(text).not.toContain('A done.');
  }, 60_000);
});
