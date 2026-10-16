import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTask, defineTool, Harness, type ToolRegistration } from '@earendil-works/pi-durable';
import type { World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { type Anchor, anchorKey, type AnchorPolicy, deliveryAnchors, isActiveAnchor, localAnchors } from 'harness-world/anchor';
import { decodeJournalPayload } from './reader.ts';
import { type Backstop, journalHead, QUEUE_PREFIX, runWake, StorageFenced, WAKE_QUEUE, WorldStorage } from './index.ts';

const ctx = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(25);
  }
}

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

interface Recorded {
  /** Queue calls and journal writes, in order. */
  log: ({ q: string; key?: string; delaySeconds?: number; input?: unknown } | { write: 'commit' | 'close'; anchor?: Anchor })[];
  queued(): { q: string; key?: string; delaySeconds?: number; input?: unknown }[];
}

/** A world-local World whose queue calls and journal writes are recorded; its queue's deliveries are acked unread. */
async function recordingWorld(): Promise<{ world: LocalWorld; rec: Recorded }> {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'pi-world-backstop-')), recoverActiveRuns: false });
  worlds.push(world);
  const rec: Recorded = { log: [], queued: () => rec.log.filter((e): e is Extract<Recorded['log'][number], { q: string }> => 'q' in e) };
  const queue = world.queue.bind(world);
  world.queue = (async (name, message, opts) => {
    rec.log.push({ q: name, ...(opts?.idempotencyKey ? { key: opts.idempotencyKey } : {}), ...(opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : {}), input: (message as { input?: unknown }).input });
    return queue(name, message, opts);
  }) as World['queue'];
  const create = world.events.create.bind(world.events);
  world.events.create = (async (runId: string, data: { eventType: string; eventData?: { payload?: unknown } }, params?: unknown) => {
    if (data.eventType === 'hook_received') {
      const entry = decodeJournalPayload(data.eventData?.payload) as { close?: boolean; anchor?: Anchor };
      rec.log.push({ write: entry.close ? 'close' : 'commit', ...(entry.anchor ? { anchor: entry.anchor } : {}) });
    }
    return create(runId, data as never, params as never);
  }) as World['events']['create'];
  world.registerHandler(QUEUE_PREFIX, async () => Response.json({}));
  return { world, rec };
}

/** Pi with a scripted faux model and `tools`. */
function pi(answers: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0], tools: ToolRegistration[] = []) {
  const faux = fauxProvider();
  faux.setResponses(answers);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry = createRegistry();
  if (tools.length) registry.install(defineExtension({ name: 'test', tools }));
  return {
    faux,
    agent: { model: { provider: model.provider, modelId: model.id } },
    open: (storage: WorldStorage) => Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } } }, ctx),
  };
}

/** A backstop that records what it was asked to keep alive. */
function backstop(anchors: AnchorPolicy, recoverAfterMs: number) {
  const kept: { promise: Promise<void>; settled: boolean }[] = [];
  const b: Backstop = {
    anchors,
    recoverAfterMs,
    keepAlive: (promise) => {
      if (kept.some((k) => k.promise === promise)) return;
      const k = { promise, settled: false };
      kept.push(k);
      void promise.then(() => (k.settled = true));
    },
  };
  return { b, kept };
}

/** A tool that writes output every `everyMs` until released, so Pi commits while it runs. */
function chatty() {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  let started = 0;
  const tool = defineTool({
    name: 'chatty',
    description: 'Talks while it works.',
    parameters: Type.Object({}),
    replay: 'safe',
    execute: async (_args, api, context) => {
      started++;
      for (let i = 0; ; i++) {
        const stop = await Promise.race([done.then(() => true), sleep(50).then(() => false)]);
        if (stop || context.abortSignal?.aborted) break;
        api.output(`tick ${i}\n`);
      }
      return { content: [{ type: 'text', text: 'worked' }] };
    },
  }) as ToolRegistration;
  return { tool, release: () => release(), started: () => started };
}

const commits = (rec: Recorded) => rec.log.filter((e): e is { write: 'commit'; anchor?: Anchor } => 'write' in e && e.write === 'commit');

describe('a storage that is its own backstop', () => {
  it('queues the wake behind the first commit that may leave work before writing it, and none for one that cannot', async () => {
    const { world, rec } = await recordingWorld();
    const id = await WorldStorage.create(world);
    const { b, kept } = backstop(deliveryAnchors(), 20_000);
    const storage = await WorldStorage.open(world, id, { backstop: b });
    const p = pi([fauxAssistantMessage([fauxText('Hi.')])]);
    const harness = await p.open(storage);
    const root = await harness.root(ctx, { agent: p.agent });
    await root.submit({ type: 'write', entry: { kind: 'app.note', data: 'a note' } }, ctx);
    // Neither creating the root conversation nor a write can leave work: nothing queued, no anchor.
    expect(rec.queued()).toEqual([]);
    expect(commits(rec).every((c) => !c.anchor)).toBe(true);
    const before = rec.log.length;

    const submission = await root.submit({ type: 'input', content: 'Hello' }, ctx);
    expect((await submission.wait(ctx)).status).toBe('done');
    await until(() => kept.length === 1 && kept[0]!.settled);
    const after = rec.log.slice(before);
    // The wake first, delayed past the deadline, keyed by the anchor; then the commit under that anchor.
    const first = after[0] as { q: string; key: string; delaySeconds: number; input: unknown };
    expect(first).toMatchObject({ q: WAKE_QUEUE, delaySeconds: 25, input: { kind: 'pi-wake' } });
    const anchor = (after[1] as { anchor: Anchor }).anchor;
    expect(anchor).toMatchObject({ k: 'deadline', at: expect.any(Number) });
    expect(first.key).toBe(`${id}:pi-companion:${anchor.m}`);
    // One wake for the whole turn (it is shorter than half the window), one busy period, settled at idle.
    expect(rec.queued()).toHaveLength(1);
    expect(kept).toHaveLength(1);
    // While it lives here, this process holds the anchor: a wake of this process acks.
    expect(isActiveAnchor(world, anchorKey(anchor))).toBe(true);
    await harness.close(ctx);
    expect(isActiveAnchor(world, anchorKey(anchor))).toBe(false);
    // Idle at close: no close entry, no continuation.
    expect(rec.log.some((e) => 'write' in e && e.write === 'close')).toBe(false);
    expect(rec.queued()).toHaveLength(1);
  });

  it('renews its anchor once it is less than half a window from its deadline, on its own commits; an old wake acks', async () => {
    const { world, rec } = await recordingWorld();
    const id = await WorldStorage.create(world);
    const { b, kept } = backstop(deliveryAnchors(), 600);
    const storage = await WorldStorage.open(world, id, { backstop: b });
    const work = chatty();
    const p = pi([fauxAssistantMessage([fauxToolCall('chatty', {})], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Done.')])], [work.tool]);
    const harness = await p.open(storage);
    const root = await harness.root(ctx, { agent: p.agent });
    const submission = await root.submit({ type: 'input', content: 'Work.' }, ctx);
    await until(() => work.started() === 1);
    // The tool talks for 1.5 s: about five renewals at a 600 ms window.
    await sleep(1_500);
    const anchors = [...new Map(commits(rec).filter((c) => c.anchor).map((c) => [c.anchor!.m, c.anchor!])).values()];
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < anchors.length; i++) expect(anchors[i]!.at!).toBeGreaterThan(anchors[i - 1]!.at!);
    const wakes = rec.queued().filter((q) => q.key?.includes(':pi-companion:'));
    expect(wakes.map((w) => w.key)).toEqual(anchors.map((a) => `${id}:pi-companion:${a.m}`));
    // The newest commit is under the newest anchor; the first anchor's wake finds a holder that is not gone.
    const head = await journalHead(world, id, ctx);
    expect(head.last?.anchor?.m).toBe(anchors.at(-1)!.m);
    const opened: string[] = [];
    const outcome = await runWake(world, id, async () => (opened.push('x'), harness), { anchors: deliveryAnchors(), anchor: { k: 'msg', m: 'msg_old_wake' } });
    expect(outcome.kind).toBe('covered');
    expect(opened).toEqual([]);
    work.release();
    expect((await submission.wait(ctx)).status).toBe('done');
    await until(() => kept.length === 1 && kept[0]!.settled);
    await harness.close(ctx);
  });

  it('closing with work left writes its close entry and queues one continuation, which the next wake takes at once', async () => {
    const { world, rec } = await recordingWorld();
    const id = await WorldStorage.create(world);
    const { b, kept } = backstop(deliveryAnchors(), 20_000);
    const storage = await WorldStorage.open(world, id, { backstop: b });
    const work = chatty();
    const p = pi([fauxAssistantMessage([fauxToolCall('chatty', {})], { stopReason: 'toolUse' })], [work.tool]);
    const harness = await p.open(storage);
    await (await harness.root(ctx, { agent: p.agent })).submit({ type: 'input', content: 'Work.' }, ctx);
    await until(() => work.started() === 1);
    await harness.close(ctx);
    expect(kept.every((k) => k.settled)).toBe(true);
    const closeAt = rec.log.findIndex((e) => 'write' in e && e.write === 'close');
    expect(closeAt).toBeGreaterThan(-1);
    const continuations = rec.queued().filter((q) => q.key?.includes(':pi-close:'));
    expect(continuations).toEqual([{ q: WAKE_QUEUE, key: `${id}:pi-close:${storage.writer}`, input: { kind: 'pi-wake', continues: expect.stringMatching(/^deadline:/) } }]);
    expect(rec.log.indexOf(continuations[0]!)).toBeGreaterThan(closeAt);
    expect(await journalHead(world, id, ctx)).toMatchObject({ unfinished: true, closed: true });
    // The next wake (even on Vercel's rules, where nothing else is proven gone) resumes it.
    const quick = chatty();
    quick.release();
    const q = pi([fauxAssistantMessage([fauxText('Done.')])], [quick.tool]);
    const outcome = await runWake(world, id, async (sessionId, anchor) => q.open(await WorldStorage.open(world, sessionId, { ...(anchor ? { anchor } : {}) })), {
      anchors: deliveryAnchors(),
      anchor: { k: 'msg', m: 'msg_continuation' },
      maxDriveMs: 10_000,
    });
    expect(outcome).toEqual({ kind: 'resumed', unfinished: false });
    expect(quick.started()).toBe(1); // The safe tool reran in the wake.
  });

  it('a refused commit lets go of the anchor and of the request at once', async () => {
    const { world } = await recordingWorld();
    const id = await WorldStorage.create(world);
    const { b, kept } = backstop(deliveryAnchors(), 20_000);
    const storage = await WorldStorage.open(world, id, { backstop: b });
    const work = chatty();
    const p = pi([fauxAssistantMessage([fauxToolCall('chatty', {})], { stopReason: 'toolUse' })], [work.tool]);
    const harness = await p.open(storage);
    await (await harness.root(ctx, { agent: p.agent })).submit({ type: 'input', content: 'Work.' }, ctx);
    await until(() => work.started() === 1);
    const anchor = storage.anchor!;
    expect(isActiveAnchor(world, anchorKey(anchor))).toBe(true);
    // Another writer opens the session (Pi's open takes it: running tasks back to pending).
    const other = await pi([]).open(await WorldStorage.open(world, id));
    // The first one's next commit (its tool's output) is refused.
    await until(async () => (await storage.commit([], ctx).then(() => false, (e: unknown) => e instanceof StorageFenced)) || undefined);
    expect(isActiveAnchor(world, anchorKey(anchor))).toBe(false);
    expect(kept.every((k) => k.settled)).toBe(true);
    work.release();
    await other.close(ctx).catch(() => {});
    await harness.close(ctx).catch(() => {});
  });

  it('on world-local queues nothing: its anchors name this process, and a wake of this process acks while it holds one', async () => {
    const { world, rec } = await recordingWorld();
    const id = await WorldStorage.create(world);
    const { b } = backstop(localAnchors(), 20_000);
    const storage = await WorldStorage.open(world, id, { backstop: b });
    const work = chatty();
    const p = pi([fauxAssistantMessage([fauxToolCall('chatty', {})], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Done.')])], [work.tool]);
    const harness = await p.open(storage);
    const submission = await (await harness.root(ctx, { agent: p.agent })).submit({ type: 'input', content: 'Work.' }, ctx);
    await until(() => work.started() === 1);
    expect(storage.anchor).toMatchObject({ k: 'deadline', proc: expect.objectContaining({ pid: process.pid }) });
    // Without the hold, an anchor of this very process with no drive running here would be gone.
    expect(await runWake(world, id, async () => harness, { anchors: localAnchors(), anchor: { k: 'msg', m: 'msg_wake' } })).toEqual({ kind: 'covered', why: 'it drives in this process' });
    work.release();
    expect((await submission.wait(ctx)).status).toBe('done');
    await harness.close(ctx);
    expect(rec.queued()).toEqual([]);
  });

  it('a delivery shares the open storage under its own message: no renewal while it holds it', async () => {
    const { world, rec } = await recordingWorld();
    const id = await WorldStorage.create(world);
    const { b } = backstop(deliveryAnchors(), 600);
    const storage = await WorldStorage.open(world, id, { backstop: b });
    const work = chatty();
    const p = pi([fauxAssistantMessage([fauxToolCall('chatty', {})], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Done.')])], [work.tool]);
    const harness = await p.open(storage);
    const submission = await (await harness.root(ctx, { agent: p.agent })).submit({ type: 'input', content: 'Work.' }, ctx);
    await until(() => work.started() === 1);
    const unset = storage.setAnchor({ k: 'msg', m: 'msg_delivery' });
    const queuedBefore = rec.queued().length;
    await sleep(800);
    expect(rec.queued()).toHaveLength(queuedBefore);
    expect((await journalHead(world, id, ctx)).last?.anchor).toEqual({ k: 'msg', m: 'msg_delivery' });
    // The delivery lets go: the next commits renew this storage's own anchor.
    unset();
    await until(() => rec.queued().length > queuedBefore);
    work.release();
    expect((await submission.wait(ctx)).status).toBe('done');
    await harness.close(ctx);
  });

  it('a wake waits for background work (Pi\'s own background compaction, a background subagent), and does not close on it at waitForIdle', async () => {
    const { world } = await recordingWorld();
    let runs = 0;
    const Slow = defineTask<null, { phase: 'work' }, null>({
      name: 'test.slow',
      version: 1,
      initial: () => ({ phase: 'work' }),
      phases: {
        work: async (_task, runtime, context) => {
          runs++;
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 300);
            context.abortSignal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
          });
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
        },
      },
      abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'bg', tasks: [Slow] }));
    const open = async (id: string, anchor?: Anchor) => Harness.open(await WorldStorage.open(world, id, anchor ? { anchor } : {}), { models, registry }, ctx);
    const id = await WorldStorage.create(world);
    const harness = await open(id);
    const root = await harness.root(ctx, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
    await root.commit((tx) => tx.createTask(Slow, null, { ownership: { kind: 'conversation' }, background: true }), ctx);
    // The conversation is idle: Pi's waitForIdle does not wait for background work.
    harness.resume();
    await harness.waitForIdle(ctx);
    await harness.close(ctx);
    expect((await journalHead(world, id, ctx)).unfinished).toBe(true);
    const outcome = await runWake(world, id, open, { anchors: deliveryAnchors(), anchor: { k: 'msg', m: 'msg_1' }, continues: undefined });
    expect(outcome).toEqual({ kind: 'resumed', unfinished: false });
    expect((await journalHead(world, id, ctx)).unfinished).toBe(false);
    expect(runs).toBeGreaterThanOrEqual(1);
  });
});
