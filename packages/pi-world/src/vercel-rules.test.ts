import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, Harness } from '@earendil-works/pi-durable';
import { type Event, getEventDataPayloadField, type World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { decode } from 'harness-world/codec';
import { NativeWorkspace } from 'harness-world-hands/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceTools } from './agent.ts';
import { worldStorage } from './index.ts';
import { JournalReader } from './reader.ts';
import { decodeJournalPayload, encodeJournalEntry, journalHookId, journalToken } from './storage.ts';

const ctx = BACKGROUND_CONTEXT;
const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}';
/** world-vercel 5.1.0's backend: every correlation id is one of these four entity ids (anything else is a 400 `validation-error`). */
const CORRELATION_ID = new RegExp(`^(?:step|hook|wait|attr)_${ULID}$`);
const RUN_ID = new RegExp(`^wrun_${ULID}$`);

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function localWorld(): Promise<LocalWorld> {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'pi-world-rules-')), recoverActiveRuns: false });
  worlds.push(world);
  return world;
}

/** `world` with its `events.create` replaced. */
function withCreate(world: World, create: World['events']['create']): World {
  return { ...world, events: { ...world.events, create, list: world.events.list.bind(world.events), get: world.events.get.bind(world.events) } } as World;
}

/**
 * world-local refusing what world-vercel 5.1.0 refuses: a run id that is not
 * `wrun_<ULID>`, a correlation id that is not `step|hook|wait|attr_<ULID>`
 * (the backend's 400), and an event payload that is not bytes (its client
 * throws `eventData.payload ... must be a Uint8Array`).
 */
function vercelRules(world: World, violations: string[]): World {
  const create = world.events.create.bind(world.events);
  return withCreate(world, (async (runId: string, data: { eventType: string; correlationId?: string; eventData?: Record<string, unknown> }, params?: unknown) => {
    const problems: string[] = [];
    if (!RUN_ID.test(runId)) problems.push(`run id ${runId}`);
    if (data.correlationId !== undefined && !CORRELATION_ID.test(data.correlationId)) problems.push(`${data.eventType} correlationId ${data.correlationId}`);
    const field = getEventDataPayloadField(data.eventType);
    const value = field ? data.eventData?.[field] : undefined;
    if (value !== undefined && !(value instanceof Uint8Array)) problems.push(`${data.eventType} eventData.${field} is ${typeof value}`);
    if (problems.length) {
      violations.push(...problems);
      throw new Error(`world-vercel would refuse: ${problems.join(', ')}`);
    }
    return create(runId as never, data as never, params as never);
  }) as never);
}

/** world-local written to the way pi-world wrote before 2026-10-07: `hook_journal_<ULID>`, JSON text payloads. */
function oldFormat(world: World): World {
  const create = world.events.create.bind(world.events);
  return withCreate(world, (async (runId: string, data: { eventType: string; correlationId?: string; eventData?: { token?: string; payload?: unknown } }, params?: unknown) => {
    let event = data;
    if (data.eventType === 'hook_created' && data.eventData?.token === journalToken(runId)) {
      event = { ...data, correlationId: `hook_journal_${runId.slice(5)}` };
    } else if (data.eventType === 'hook_received' && data.eventData?.token === journalToken(runId)) {
      event = { ...data, eventData: { ...data.eventData, payload: decode(data.eventData.payload) } };
    }
    return create(runId as never, event as never, params as never);
  }) as never);
}

async function events(world: World, runId: string): Promise<Event[]> {
  return (await world.events.list({ runId, pagination: { sortOrder: 'asc', limit: 1000 } } as never)).data as Event[];
}

/** One process: Pi's Harness on `world`, with the workspace tools and a faux model scripted with `answers`. */
function agent(world: World, answers: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const faux = fauxProvider();
  faux.setResponses(answers);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'workspace', tools: workspaceTools(() => NativeWorkspace.from()) }));
  return {
    async turn(sessionId: string, content: string, requestId: string) {
      const storage = await worldStorage(world, sessionId);
      const harness = await Harness.open(storage, { models, registry, settings: { toolExecution: 'sequential' } }, ctx);
      const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
      const settled = await (await root.submit({ type: 'input', content, requestId }, ctx)).wait(ctx);
      const transcript = JSON.stringify((await root.entries({}, 1000, undefined, ctx)).items);
      await harness.close(ctx);
      return { status: settled.status, transcript };
    },
  };
}

describe('journalHookId', () => {
  it('is `hook_` and the run ULID, an id world-vercel accepts', () => {
    const runId = 'wrun_01M4A12TY5Y4X81YB6ZFCQGKYR';
    expect(journalHookId(runId)).toBe('hook_01M4A12TY5Y4X81YB6ZFCQGKYR');
    expect(journalHookId(runId)).toMatch(CORRELATION_ID);
    // The id the storage wrote before, which world-vercel refused.
    expect(`hook_journal_${runId.slice(5)}`).not.toMatch(CORRELATION_ID);
  });

  it('is a fresh `hook_<ULID>` for a run id that is not `wrun_<ULID>`', () => {
    for (const runId of ['wrun_test', 'session-1', 'wrun_01m4a12ty5y4x81yb6zfcqgkyr']) {
      expect(journalHookId(runId)).toMatch(CORRELATION_ID);
    }
    expect(journalHookId('wrun_test')).not.toBe(journalHookId('wrun_test'));
  });
});

describe('journal payloads', () => {
  it('are bytes in the kernel codec, and read back exactly, `__proto__` keys and lone surrogates too', () => {
    const entry = JSON.parse('{"v":1,"after":3,"seq":7,"writes":[{"__proto__":{"x":"a\\ud800b"},"s":"<script>\\u2028"}],"by":"pi_1"}');
    const bytes = encodeJournalEntry(entry);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('devl');
    const back = decodeJournalPayload(bytes) as typeof entry;
    expect(JSON.stringify(back)).toBe(JSON.stringify(entry));
    expect(Object.keys(back.writes[0])).toEqual(['__proto__', 's']);
    expect(back.writes[0].__proto__.x).toBe('a\ud800b');
  });

  it('read the bare JSON text sessions carry from before 2026-10-07', () => {
    expect(decodeJournalPayload('{"v":1,"seq":2}')).toEqual({ v: 1, seq: 2 });
    expect(() => decodeJournalPayload(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe('a session on world-vercel rules', () => {
  it('writes only events world-vercel accepts, through a whole turn with tools', async () => {
    const violations: string[] = [];
    const world = vercelRules(await localWorld(), violations);
    const sessionId = await worldStorage.create(world, { name: 'pi-durable' });
    const a = agent(world, [
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'a.txt', content: 'hi' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Done.')]),
    ]);
    const { status, transcript } = await a.turn(sessionId, 'write a file', 'r1');
    expect(violations).toEqual([]);
    expect(status).toBe('done');
    expect(transcript).toContain('Done.');

    const log = await events(world, sessionId);
    const hook = log.find((e) => e.eventType === 'hook_created');
    expect(hook?.correlationId).toBe(journalHookId(sessionId));
    const commits = log.filter((e) => e.eventType === 'hook_received');
    expect(commits.length).toBeGreaterThan(3);
    expect(commits.every((e) => e.correlationId === hook?.correlationId && (e.eventData as { payload: unknown }).payload instanceof Uint8Array)).toBe(true);

    const snap = await (async () => {
      const reader = new JournalReader(world, sessionId);
      await reader.refresh();
      return reader.snapshot();
    })();
    expect(snap.commits).toBe(commits.length);
    expect(snap.log.every((c) => c.valid)).toBe(true);
    expect(snap.entries.map((e) => e.kind)).toContain('pi.tool-result');
  });
});

describe('a session written before 2026-10-07', () => {
  it('(hook_journal_<ULID>, JSON text payloads) opens, reads and continues; new commits are bytes on the same hook', async () => {
    const local = await localWorld();
    const old = oldFormat(local);
    const sessionId = await worldStorage.create(old);
    const first = await agent(old, [
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'a.txt', content: 'hi' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('First answer.')]),
    ]).turn(sessionId, 'first question', 'r1');
    expect(first.status).toBe('done');

    const before = await events(local, sessionId);
    const oldHookId = `hook_journal_${sessionId.slice(5)}`;
    expect(before.find((e) => e.eventType === 'hook_created')?.correlationId).toBe(oldHookId);
    const oldCommits = before.filter((e) => e.eventType === 'hook_received');
    expect(oldCommits.length).toBeGreaterThan(3);
    expect(oldCommits.every((e) => typeof (e.eventData as { payload: unknown }).payload === 'string')).toBe(true);

    // Today's code, on the same log: the reader and a reopened storage see the first turn.
    const reader = new JournalReader(local, sessionId);
    await reader.refresh();
    const snapBefore = await reader.snapshot();
    expect(snapBefore.commits).toBe(oldCommits.length);
    expect(snapBefore.entries.some((e) => JSON.stringify(e.model).includes('First answer.'))).toBe(true);

    const second = await agent(local, [fauxAssistantMessage([fauxText('Second answer.')])]).turn(sessionId, 'second question', 'r2');
    expect(second.status).toBe('done');
    expect(second.transcript).toContain('First answer.');
    expect(second.transcript).toContain('Second answer.');

    const after = await events(local, sessionId);
    const newCommits = after.filter((e) => e.eventType === 'hook_received').slice(oldCommits.length);
    expect(newCommits.length).toBeGreaterThan(0);
    expect(newCommits.every((e) => e.correlationId === oldHookId && (e.eventData as { payload: unknown }).payload instanceof Uint8Array)).toBe(true);

    // A mixed log (text, then bytes) replays whole, for the reader and for a third process.
    await reader.refresh();
    const snapAfter = await reader.snapshot();
    expect(snapAfter.commits).toBe(oldCommits.length + newCommits.length);
    expect(snapAfter.log.every((c) => c.valid)).toBe(true);
    const third = await worldStorage(local, sessionId);
    const conversations = (await third.scanConversations({}, 100, undefined, ctx)).items;
    expect(conversations.length).toBeGreaterThan(0);
    await third.close(ctx);
  });
});
