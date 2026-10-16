import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import { createWorld as createLocalWorld } from '@workflow/world-local';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chatRoute,
  defineDoc,
  deliver,
  type DriveContext,
  type DriverOptions,
  DocTooLarge,
  DOC_MAX_BYTES,
  durableSessions,
  EffectFailure,
  type EffectIO,
  type Harness,
  liveStreamName,
  readJsonLines,
  type Submission,
} from './index.ts';
import { callDocs, docBytes, materializeDoc, prepareUpdate } from './docs.ts';
import type { CreateEventRequest } from '@workflow/world';
import { decode, encode } from './codec.ts';
import type { StepEnvelope } from './fold.ts';
import { QUEUE_PREFIX } from './index.ts';
import { stepNameFor } from './names.ts';
import { SessionLog } from './session-log.ts';

/**
 * Documents (docs.ts) under attack, on world-local: the live stream under
 * run-ahead when an app's edit lands in a tool's window or the drive
 * rewinds, a rebased in-band edit next to another writer's, the size limit
 * through a migration and a rebase, a migrate that throws, a reconnect by
 * cursor, and an out-of-band write whose answer is lost and resent.
 */

const ulid = monotonicFactory();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(20);
  }
}

type Closable = World & { close?(): Promise<void> };
let opened: Closable[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.close?.().catch(() => {});
});

/** world-local on a fresh store, its queue in memory (deliveries are explicit). */
async function open(): Promise<World> {
  const dataDir = await mkdtemp(join(tmpdir(), 'hw-docs-review-'));
  const base = createLocalWorld({ dataDir, recoverActiveRuns: false }) as Closable;
  opened.push(base);
  return new Proxy(base, {
    get(target, key) {
      if (key === 'queue') return async () => ({ messageId: `msg_${ulid()}` });
      const value = (target as unknown as Record<string | symbol, unknown>)[key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as World;
}

type LiveLine = { type?: string; kind?: string; revision?: number; value?: unknown; name?: string };
const liveLines = async (world: World, runId: string) => (await readJsonLines(world, runId, liveStreamName(runId))) as LiveLine[];

/** What a client keeping the highest revision it saw (the documented rule) ends up showing, per kind. */
function clientView(lines: LiveLine[]): Map<string, { revision: number; value: unknown }> {
  const out = new Map<string, { revision: number; value: unknown }>();
  for (const e of lines) {
    if (e.type === 'rewind') out.clear();
    if (e.type !== 'doc' || !e.kind) continue;
    const seen = out.get(e.kind);
    if (!seen || e.revision! > seen.revision) out.set(e.kind, { revision: e.revision!, value: e.value });
  }
  return out;
}

function scripted(turn: (ctx: DriveContext, sub: Submission) => Promise<void>, name = 'docs-review'): Harness {
  return {
    name,
    async drive(ctx) {
      const pending = new Set(ctx.pending().map((p) => p.id));
      for (const sub of ctx.state().submissions) {
        if (sub.kind !== 'prompt') continue;
        if (!pending.has(sub.id) && !ctx.state().placed.has(sub.id)) continue;
        await ctx.effect(`model:${sub.id}`, { name: 'model', replay: 'safe', input: sub.text, placed: [sub.id] }, async () => 'ok');
        await turn(ctx, sub);
      }
      ctx.live({ type: 'idle' });
    },
  };
}

async function call<T>(ctx: DriveContext, key: string, fn: (io: EffectIO) => Promise<T>, replay: 'safe' | 'never' = 'safe'): Promise<T | EffectFailure> {
  try {
    return await ctx.effect(key, { name: 'tool.edit', replay, input: key }, fn);
  } catch (err) {
    if (err instanceof EffectFailure) return err;
    throw err;
  }
}

const Board = defineDoc<{ cards: Record<string, string> }>({ kind: 'app.board', version: 1, initial: () => ({ cards: {} }) });
const msg = (m: string) => ({ anchor: { k: 'msg' as const, m } });

describe('the live doc event agrees with the log', () => {
  for (const runAhead of [false, true]) {
    it(`an app edit landing in a tool's window (${runAhead ? 'run-ahead' : 'strict'}): the last doc event a client keeps is the document the log has`, async () => {
      const world = await open();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const harness = scripted(async (ctx, sub) => {
        await call(ctx, `tool:${sub.id}`, async (io) => {
          io.docs!.update(Board, (d) => void (d.cards.tool = 'from the tool'));
          await gate;
          return 'ok';
        });
        ctx.live({ type: 'tool_end', key: `tool:${sub.id}` });
      });
      const options: DriverOptions = { world, harness, marks: false, runAhead };
      const sessions = durableSessions(options);
      const { sessionId } = await sessions.start();
      await sessions.send(sessionId, 'go');
      const driving = deliver(options, sessionId, msg('m1'));
      await until(async () => ((await sessions.inspect(sessionId)).effectOrder.some((e) => e.key.startsWith('tool:') && e.status === 'running') ? true : undefined));
      // The tool pinned revision 0; the app writes revision 1 meanwhile.
      await durableSessions({ world, harness, marks: false }).updateDoc(sessionId, Board, (d) => void (d.cards.app = 'from the app'));
      release();
      await driving;
      const durable = await sessions.doc(sessionId, Board);
      expect(durable).toEqual({ value: { cards: { app: 'from the app', tool: 'from the tool' } }, revision: 2 });
      const lines = await liveLines(world, sessionId);
      expect(clientView(lines).get('app.board')).toEqual({ revision: durable.revision, value: durable.value });
      // A doc event and the value it names never disagree with the log for its revision.
      for (const e of lines.filter((l) => l.type === 'doc' && l.revision === 2)) expect(e.value).toEqual(durable.value);
      // The tool's doc event is on the stream before its tool_end.
      const docAt = lines.findIndex((l) => l.type === 'doc' && (l.value as { cards?: Record<string, string> })?.cards?.tool);
      const endAt = lines.findIndex((l) => l.type === 'tool_end');
      expect(docAt).toBeGreaterThanOrEqual(0);
      expect(docAt).toBeLessThan(endAt);
    });
  }

  it('chatRoute: a reconnect by cursor after a doc event gets the current value first and nothing twice', async () => {
    const world = await open();
    const harness = scripted(async (ctx, sub) => {
      await call(ctx, `t:${sub.id}`, async (io) => {
        io.docs!.update(Board, (d) => void (d.cards[sub.text!] = sub.text!));
        return 'ok';
      });
      ctx.live({ type: 'text', text: `after ${sub.text}` });
    });
    const options: DriverOptions = { world, harness, marks: false };
    const sessions = durableSessions(options);
    const send = async (id: string, text: string, kind: 'prompt' | 'steer' | 'followUp') => {
      const submission = await sessions.send(id, text, kind);
      void deliver(options, id, msg(`m_${ulid()}`));
      return submission;
    };
    const read = async (response: Response) =>
      (await response.text())
        .split('\n\n')
        .filter((b) => b.includes('data:'))
        .map((b) => ({ id: /^id: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) as LiveLine & { text?: string } }));
    const route = chatRoute(sessions, { send, docs: [Board] });
    const first = await route.POST(new Request('http://x/api/chat', { method: 'POST', body: JSON.stringify({ text: 'a' }) }));
    const sessionId = first.headers.get('x-session-id')!;
    const one = await read(first);
    const doc = one.find((m) => m.data.type === 'doc')!;
    expect(doc.id).toBeDefined();
    // An app edit after the turn, then a reconnect from the doc event's cursor.
    await sessions.updateDoc(sessionId, Board, (d) => void (d.cards.app = 'app'));
    const again = await read(await route.GET(new Request(`http://x/api/chat?sessionId=${sessionId}&cursor=${encodeURIComponent(doc.id!)}`)));
    // The prelude (no id) has the current value; then what followed the cursor, once.
    expect(again[0]).toMatchObject({ id: undefined, data: { type: 'doc', kind: 'app.board', revision: 2, value: { cards: { a: 'a', app: 'app' } } } });
    const texts = again.filter((m) => m.data.type === 'text').map((m) => m.data.text);
    expect(texts).toEqual(['after a']);
    // The app's doc event came after the turn's idle: this reconnect ends at the idle, and the prelude carried it.
    expect(again.filter((m) => m.data.type === 'doc' && m.id !== undefined)).toEqual([]);
  });
});

describe('the size limit holds', () => {
  const big = (bytes: number) => 'x'.repeat(bytes);

  it('through a migration that grows a document: a write may not store more than the log held unless it is under the limit', async () => {
    const V1 = defineDoc<{ text: string }>({ kind: 'app.notes', version: 1, initial: () => ({ text: '' }) });
    const V2 = defineDoc<{ text: string; copy: string; n: number }>({
      kind: 'app.notes',
      version: 2,
      initial: () => ({ text: '', copy: '', n: 0 }),
      // A migration that doubles the document (an app bug, or a schema that is just bigger).
      migrate: (old) => ({ text: old.text as string, copy: old.text as string, n: 0 }),
    });
    const stored = { schema: 1, revision: 3, value: { text: big(40_000) } };
    const m = materializeDoc(V2.definition, stored);
    expect(m.migrated).toBe(true);
    expect(docBytes(m.value)).toBeGreaterThan(DOC_MAX_BYTES);
    // A small change after the migration would store 80 KB: refused, as growth past the limit.
    expect(() => prepareUpdate(V2.definition, m.value, (d) => void (d.n = 1), { storedBytes: docBytes(stored.value) })).toThrow(DocTooLarge);
    // In an effect too.
    const calls = callDocs(() => ({ docs: new Map([['app.notes', { kind: 'app.notes', slot: 1, by: { edit: 'e' }, ...stored }]]) }));
    expect(() => calls.io.update(V2, (d) => void (d.n = 1))).toThrow(DocTooLarge);
    // A write that brings it back under the limit is allowed.
    expect(() => calls.io.update(V2, (d) => void (d.copy = ''))).not.toThrow();
    expect(calls.edits()).toHaveLength(1);
    // And one that does not grow what the log holds (an oversized v1, migrated to the same size) still is.
    const fat = { schema: 1, revision: 1, value: { text: big(70_000) } };
    const Same = defineDoc<{ body: string }>({ kind: 'app.notes', version: 2, initial: () => ({ body: '' }), migrate: (old) => ({ body: old.text as string }) });
    const same = callDocs(() => ({ docs: new Map([['app.notes', { kind: 'app.notes', slot: 1, by: { edit: 'e' }, ...fat }]]) }));
    expect(() => same.io.update(Same, (d) => void (d.body = d.body.slice(1)))).not.toThrow();
    expect(V1.definition.version).toBe(1);
  });

  it('updateDoc refuses the same growth through a migration, before writing', async () => {
    const world = await open();
    const V1 = defineDoc<{ text: string }>({ kind: 'app.notes', version: 1, initial: () => ({ text: '' }) });
    const V2 = defineDoc<{ text: string; copy: string; n: number }>({
      kind: 'app.notes',
      version: 2,
      initial: () => ({ text: '', copy: '', n: 0 }),
      migrate: (old) => ({ text: old.text as string, copy: old.text as string, n: 0 }),
    });
    const sessions = durableSessions({ world, harness: scripted(async () => {}), marks: false });
    const { sessionId } = await sessions.start();
    await sessions.updateDoc(sessionId, V1, (d) => void (d.text = big(40_000)));
    await expect(sessions.updateDoc(sessionId, V2, (d) => void (d.n = 1))).rejects.toBeInstanceOf(DocTooLarge);
    expect((await sessions.inspect(sessionId)).docs.get('app.notes')).toMatchObject({ schema: 1, revision: 1 });
  });

  it('a rebase can leave a document over the limit (two siblings each within it); then growth is refused and a shrink allowed', async () => {
    const world = await open();
    const Log = defineDoc<{ lines: string[] }>({ kind: 'app.log', version: 1, initial: () => ({ lines: [] }) });
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    const outcomes = new Map<string, unknown>();
    const harness = scripted(async (ctx, sub) => {
      if (sub.text === 'grow') {
        await Promise.all(
          ['left', 'right'].map((side) =>
            call(ctx, `${side}:${sub.id}`, async (io) => {
              io.docs!.update(Log, (d) => void d.lines.push(big(40_000)));
              if (++arrived === 2) release();
              await both;
              return side;
            })
          )
        );
        return;
      }
      outcomes.set('more', await call(ctx, `more:${sub.id}`, async (io) => void io.docs!.update(Log, (d) => void d.lines.push('one more'))));
      outcomes.set('less', await call(ctx, `less:${sub.id}`, async (io) => void io.docs!.update(Log, (d) => void d.lines.shift())));
    });
    const options: DriverOptions = { world, harness, marks: false };
    const sessions = durableSessions(options);
    const { sessionId } = await sessions.start();
    await sessions.send(sessionId, 'grow');
    await deliver(options, sessionId, msg('m1'));
    const grown = await sessions.doc(sessionId, Log);
    expect(grown.revision).toBe(2);
    expect(docBytes(grown.value)).toBeGreaterThan(DOC_MAX_BYTES);
    await sessions.send(sessionId, 'after');
    await deliver(options, sessionId, msg('m2'));
    expect(outcomes.get('more')).toBeInstanceOf(EffectFailure);
    expect((outcomes.get('more') as EffectFailure).error.message).toMatch(/limit is 65,536/);
    expect(outcomes.get('less')).toBeUndefined();
    const after = await sessions.doc(sessionId, Log);
    expect(after.value.lines).toHaveLength(1);
    expect(docBytes(after.value)).toBeLessThan(DOC_MAX_BYTES);
  });
});

describe('a migrate that throws', () => {
  it('fails the calls and reads that need it, loudly, and changes nothing; the drive and other documents go on; chatRoute sends its error', async () => {
    const world = await open();
    const Old = defineDoc<{ items: string[] }>({ kind: 'app.todos', version: 1, initial: () => ({ items: [] }) });
    const Broken = defineDoc<{ items: { text: string }[] }>({
      kind: 'app.todos',
      version: 2,
      initial: () => ({ items: [] }),
      migrate: () => {
        throw new Error('migrate is broken');
      },
    });
    const outcomes = new Map<string, unknown>();
    const harness = scripted(async (ctx, sub) => {
      outcomes.set(
        `todo:${sub.text}`,
        await call(ctx, `todo:${sub.id}`, async (io) => {
          if (sub.text !== 'one') io.docs!.update(Broken, (d) => void d.items.push({ text: sub.text! }));
          else io.docs!.update(Old, (d) => void d.items.push(sub.text!));
          return 'ok';
        })
      );
      outcomes.set(`board:${sub.text}`, await call(ctx, `board:${sub.id}`, async (io) => (io.docs!.update(Board, (d) => void (d.cards[sub.text!] = 'x')), 'board ok')));
    });
    const options: DriverOptions = { world, harness, marks: false };
    const sessions = durableSessions(options);
    const { sessionId } = await sessions.start();
    await sessions.send(sessionId, 'one');
    await deliver(options, sessionId, msg('m1'));
    await sessions.send(sessionId, 'two');
    await deliver(options, sessionId, msg('m2'));
    expect(outcomes.get('todo:two')).toBeInstanceOf(EffectFailure);
    expect((outcomes.get('todo:two') as EffectFailure).error.message).toBe('migrate is broken');
    expect(outcomes.get('board:two')).toBe('board ok');
    const state = await sessions.inspect(sessionId);
    expect(state.docs.get('app.todos')).toMatchObject({ schema: 1, revision: 1, value: { items: ['one'] } });
    await expect(sessions.doc(sessionId, Broken)).rejects.toThrow('migrate is broken');
    await expect(sessions.updateDoc(sessionId, Broken, (d) => void d.items.push({ text: 'app' }))).rejects.toThrow('migrate is broken');
    expect((await sessions.inspect(sessionId)).docsHook).toBeUndefined();
    // The chat route shows the error instead of the value, and the turn still streams.
    const route = chatRoute(
      {
        ...sessions,
        start: () => sessions.start(),
        send: async (id, text, kind) => {
          const s = await sessions.send(id, text, kind);
          void deliver(options, id, msg(`m_${ulid()}`));
          return s;
        },
      },
      { docs: [Broken] }
    );
    const text = await (await route.POST(new Request('http://x/api/chat', { method: 'POST', body: JSON.stringify({ sessionId, text: 'three' }) }))).text();
    const events = text
      .split('\n\n')
      .filter((b) => b.includes('data:'))
      .map((b) => JSON.parse(/^data: (.*)$/m.exec(b)![1]!) as { type: string; error?: string });
    expect(events[0]).toMatchObject({ type: 'doc', kind: 'app.todos', error: 'migrate is broken' });
    expect(events.some((e) => e.type === 'idle')).toBe(true);
  });
});

describe('an out-of-band edit whose answer is lost', () => {
  it('and that the next read does not show yet: resent with the same id, the World has two copies, the document has it once', async () => {
    const world = await open();
    let hideNextList = 0;
    let dropped = 0;
    const isDocsEdit = (e: { eventType?: string; eventData?: { token?: unknown } }) =>
      e.eventType === 'hook_received' && typeof e.eventData?.token === 'string' && e.eventData.token.endsWith(':docs');
    const lossy = new Proxy(world, {
      get(target, key) {
        if (key !== 'events') return (target as unknown as Record<string | symbol, unknown>)[key];
        return new Proxy(target.events, {
          get(events, k) {
            const value = (events as unknown as Record<string | symbol, unknown>)[k];
            if (k === 'create') {
              return async (runId: string, data: { eventType: string; eventData?: { token?: string } }, ...rest: unknown[]) => {
                const result = await (value as (...a: unknown[]) => Promise<unknown>).call(events, runId, data, ...rest);
                // The World commits the edit; its answer is lost, and the next listing lags behind it.
                if (isDocsEdit(data) && dropped === 0) {
                  dropped++;
                  hideNextList = 1;
                  throw Object.assign(new Error('socket hang up'), { ambiguous: true });
                }
                return result;
              };
            }
            if (k === 'list') {
              return async (...args: unknown[]) => {
                const page = (await (value as (...a: unknown[]) => Promise<{ data: Array<{ eventType?: string; eventData?: { token?: unknown } }> }>).apply(events, args));
                if (hideNextList > 0) {
                  hideNextList--;
                  return { ...page, data: page.data.filter((e) => !isDocsEdit(e)) };
                }
                return page;
              };
            }
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(events) : value;
          },
        });
      },
    }) as World;
    const sessions = durableSessions({ world: lossy, harness: scripted(async () => {}), marks: false });
    const { sessionId } = await sessions.start();
    const after = await sessions.updateDoc(sessionId, Board, (d) => void (d.cards.once = 'once'));
    expect(after).toEqual({ value: { cards: { once: 'once' } }, revision: 1 });
    const fresh = durableSessions({ world, harness: scripted(async () => {}), marks: false });
    const state = await fresh.inspect(sessionId);
    expect(state.docEdits.size).toBe(1);
    expect(state.docs.get('app.board')).toMatchObject({ revision: 1, value: { cards: { once: 'once' } } });
    const copies = (await world.events.list({ runId: sessionId, pagination: { limit: 1000 }, resolveData: 'all' })).data.filter((e) => isDocsEdit(e as never));
    expect(copies).toHaveLength(2);
  });
});

describe('an in-band edit rebased onto another writer keeps what that writer did', () => {
  const item = (who: string) => `${who}:${'x'.repeat(2000)}`;

  it('two sibling calls each append a large item to an empty list: both items survive (no root set erases the first)', async () => {
    const world = await open();
    const Notes = defineDoc<{ items: string[] }>({ kind: 'app.notes', version: 1, initial: () => ({ items: [] }) });
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    const harness = scripted(async (ctx, sub) => {
      await Promise.all(
        ['left', 'right'].map((side) =>
          call(ctx, `${side}:${sub.id}`, async (io) => {
            io.docs!.update(Notes, (d) => void d.items.push(item(side)));
            if (++arrived === 2) release();
            await both;
            return side;
          })
        )
      );
    });
    const options: DriverOptions = { world, harness, marks: false };
    const sessions = durableSessions(options);
    const { sessionId } = await sessions.start();
    await sessions.send(sessionId, 'go');
    await deliver(options, sessionId, msg('m1'));
    const doc = await sessions.doc(sessionId, Notes);
    expect(doc.revision).toBe(2);
    expect([...doc.value.items].sort()).toEqual([item('left'), item('right')]);
  });

  it("an app's first write lands while a tool's first write (a large item onto an empty list) is in flight: both survive", async () => {
    const world = await open();
    const Notes = defineDoc<{ items: string[]; title?: string }>({ kind: 'app.notes', version: 1, initial: () => ({ items: [] }) });
    let releaseTool!: () => void;
    const gate = new Promise<void>((r) => (releaseTool = r));
    const harness = scripted(async (ctx, sub) => {
      await call(ctx, `tool:${sub.id}`, async (io) => {
        io.docs!.update(Notes, (d) => void d.items.push(item('tool')));
        await gate;
        return 'ok';
      });
    });
    const options: DriverOptions = { world, harness, marks: false };
    const sessions = durableSessions(options);
    const { sessionId } = await sessions.start();
    await sessions.send(sessionId, 'go');
    const driving = deliver(options, sessionId, msg('m1'));
    await until(async () => ((await sessions.inspect(sessionId)).effectOrder.some((e) => e.key.startsWith('tool:') && e.status === 'running') ? true : undefined));
    await sessions.updateDoc(sessionId, Notes, (d) => void (d.title = 'from the app'));
    releaseTool();
    await driving;
    expect(await sessions.doc(sessionId, Notes)).toEqual({ value: { items: [item('tool')], title: 'from the app' }, revision: 2 });
  });
});

describe('a run-ahead rewind and documents', () => {
  it("a foreign writer rewinds the drive after a tool's edit was published: what a client keeps (dropping its documents at the rewind) is the log's document", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hw-docs-rewind-'));
    const world = createLocalWorld({ dataDir, recoverActiveRuns: false });
    opened.push(world as Closable);
    let runId = '';
    let injected = false;
    const create = world.events.create.bind(world.events);
    world.events.create = (async (id: string, req: CreateEventRequest, params?: unknown) => {
      const data = (req as { eventData?: { stepName?: string; input?: unknown } }).eventData;
      const isModel1 = req.eventType === 'step_started' && data?.stepName === stepNameFor('model') && data.input !== undefined && (decode(data.input as string) as StepEnvelope).key === 'model:1';
      if (!injected && isModel1) {
        injected = true;
        // Another live driver's progress lands just ahead of the intent.
        const other = new SessionLog(world, runId);
        await other.refresh();
        await other.write({
          eventType: 'step_started',
          correlationId: 'step_foreign',
          eventData: { stepName: stepNameFor('model'), input: encode({ key: 'x', replay: 'safe', input: 0, epoch: other.state.epoch, drv: 'drv_other' } satisfies StepEnvelope) },
        } as CreateEventRequest);
      }
      return create(id, req, params as never);
    }) as typeof world.events.create;
    const harness: Harness = {
      name: 'docs-rewind',
      async drive(ctx) {
        const st = ctx.state();
        const s = st.submissions.find((x) => x.kind === 'prompt');
        if (!s || ctx.isMemoized('model:1')) return;
        await ctx.effect('model:0', { name: 'model', replay: 'safe', input: s.text, placed: [s.id] }, async () => 'edit');
        await ctx.effect('tool:0', { name: 'tool.edit', replay: 'safe', input: 0 }, async (io) => {
          io.docs!.update(Board, (d) => void (d.cards.tool = 'from the tool'));
          return 'edited';
        });
        await ctx.effect('model:1', { name: 'model', replay: 'safe', input: 'edited', placed: [] }, async () => 'done');
        ctx.live({ type: 'idle' });
      },
    };
    const sessions = durableSessions({ world, harness, runAhead: true, contendedDelaySeconds: 1, marks: false });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    ({ sessionId: runId } = await sessions.start());
    await sessions.send(runId, 'go');
    await until(async () => ((await sessions.inspect(runId)).effects.get('model:1')?.status === 'completed' ? true : undefined), 20_000);
    expect(injected).toBe(true);
    const lines = await liveLines(world, runId);
    expect(lines.some((l) => l.type === 'rewind')).toBe(true);
    const durable = await sessions.doc(runId, Board);
    expect(durable.revision).toBeGreaterThan(0);
    expect(clientView(lines).get('app.board')).toEqual({ revision: durable.revision, value: durable.value });
  }, 30_000);
});

/** world-local, and world-postgres when `WORKFLOW_POSTGRES_URL` is set (it treats a hook that does not say otherwise as a webhook, as world-vercel does). */
const hookWorlds: Array<[string, () => Promise<World>]> = [['world-local', open]];
if (process.env.WORKFLOW_POSTGRES_URL) {
  hookWorlds.push([
    'world-postgres',
    async () => {
      const { createWorld } = await import('@workflow/world-postgres');
      const base = createWorld({ connectionString: process.env.WORKFLOW_POSTGRES_URL!, jobPrefix: `hw_docs_adv_${ulid().toLowerCase()}_` }) as unknown as Closable;
      opened.push(base);
      return new Proxy(base, {
        get(target, key) {
          if (key === 'queue') return async () => ({ messageId: `msg_${ulid()}` });
          const value = (target as unknown as Record<string | symbol, unknown>)[key];
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as World;
    },
  ]);
}

describe.each(hookWorlds)("the session's hooks are not public webhooks (%s)", (_name, make) => {
  it('are created with isWebhook: false, and a payload written on them that the kernel cannot read (a webhook request, an encrypted body) is inert', async () => {
    const world = await make();
    const sessions = durableSessions({ world, harness: scripted(async () => {}), marks: false });
    const { sessionId } = await sessions.start();
    await sessions.updateDoc(sessionId, Board, (d) => void (d.cards.a = 'a'));
    for (const kind of ['inbox', 'docs']) {
      const hook = await world.hooks.getByToken(`harness:${sessionId}:${kind}`);
      expect(hook.isWebhook).toBe(false);
    }
    const state = await sessions.inspect(sessionId);
    const enc = new TextEncoder();
    // What a public webhook resume would write: the Workflow runtime's encoding of a Request, or a body sealed for the run.
    const foreign = [enc.encode('encr\u0000\u0001garbage'), enc.encode('devl[["Request",1],{"url":2},"https://x"]'), enc.encode('devl"just a string"')];
    for (const hook of [state.inbox!, state.docsHook!]) {
      for (const payload of foreign) {
        await world.events.create(sessionId, { eventType: 'hook_received', correlationId: hook.hookId, eventData: { token: hook.token, payload } } as never);
      }
    }
    const fresh = durableSessions({ world, harness: scripted(async () => {}), marks: false });
    const after = await fresh.inspect(sessionId);
    expect(after.submissions).toEqual([]);
    expect(after.docs.get('app.board')).toMatchObject({ revision: 1, value: { cards: { a: 'a' } } });
    // The session still works.
    await fresh.send(sessionId, 'still here');
    expect((await fresh.inspect(sessionId)).submissions.map((s) => s.text)).toEqual(['still here']);
  });
});
