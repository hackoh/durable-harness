import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import type { World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import {
  type DriveContext,
  durableSessions,
  EffectFailure,
  type Harness,
  QUEUE_NAME,
  QUEUE_PREFIX,
  wake,
  workflowNameFor,
} from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalQueue, createRemoteWorld, type LocalQueue } from './index.ts';
import { createWorldHandler, type WorldHandlerOptions } from './server.ts';
import { wire } from './wire.ts';

const BASE = 'http://remote.test/api/world';

/** A run id the World accepts: `wrun_` + a ULID minted now. */
function runIdNow(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = Date.now();
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = alphabet[time % 32] + head;
    time = Math.floor(time / 32);
  }
  let tail = '';
  for (let i = 0; i < 16; i++) tail += alphabet[Math.floor(Math.random() * 32)];
  return `wrun_${head}${tail}`;
}

/** Same echo harness as harness-world's kernel tests: no model, real log mechanics. */
function echoHarness(opts: { onTool?: (text: string) => Promise<void> } = {}): Harness {
  return {
    name: 'echo',
    async drive(ctx: DriveContext) {
      let turn = ctx.state().effectOrder.filter((e) => e.name === 'model').length;
      const last = ctx.state().effectOrder.findLast((e) => e.name === 'model');
      const unfinished = last && !ctx.isMemoized(`tool:${last.key}`) ? [last] : [];
      for (const record of unfinished) await runTurn(ctx, record.key, [], String(record.input));
      for (const submission of ctx.pending()) {
        const key = `model:${turn++}`;
        await runTurn(ctx, key, [submission.id], submission.text ?? '');
      }
    },
  };

  async function runTurn(ctx: DriveContext, key: string, placed: string[], text: string) {
    const decision = await ctx.effect(
      key,
      { name: 'model', replay: 'safe', input: text, placed },
      async () => ({ tool: 'echo', args: text.toUpperCase() })
    );
    try {
      await ctx.effect(
        `tool:${key}`,
        { name: 'tool.echo', replay: 'never', input: decision.args },
        async (io) => {
          io.progress({ started: decision.args });
          await opts.onTool?.(decision.args);
          return decision.args;
        }
      );
    } catch (err) {
      if (!(err instanceof EffectFailure)) throw err;
    }
    ctx.live({ type: 'turn_end', key });
  }
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A server World (world-local), fronted by the handler. */
async function server(options?: WorldHandlerOptions) {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-remote-'));
  const backing: LocalWorld = createWorld({ dataDir, recoverActiveRuns: false });
  cleanups.push(() => backing.close?.());
  const handle = createWorldHandler(backing, options);
  let requests = 0;
  const fetch = (url: string, init: RequestInit) => {
    requests++;
    return handle(new Request(url, init));
  };
  return { backing, handle, fetch, requests: () => requests };
}

/** A "tab": a remote World over the server with its own in-memory queue. */
async function tab(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  const queue: LocalQueue = createLocalQueue();
  cleanups.push(() => queue.stop());
  const world = await createRemoteWorld({ baseUrl: BASE, fetch, queue });
  return { world, queue };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out + decoder.decode();
    out += decoder.decode(value, { stream: true });
  }
}

describe('wire', () => {
  it('round-trips bytes, dates and undefined positions', () => {
    const value = {
      bytes: new Uint8Array([0, 1, 254, 255]),
      buffer: Buffer.from('hi'),
      at: new Date('2026-09-25T00:00:00.000Z'),
      args: ['a', undefined, 3],
      gone: undefined,
    };
    const back = wire.parse(wire.stringify(value)) as typeof value;
    expect(back.bytes).toBeInstanceOf(Uint8Array);
    expect([...back.bytes]).toEqual([0, 1, 254, 255]);
    expect(new TextDecoder().decode(back.buffer)).toBe('hi');
    expect(back.at).toBeInstanceOf(Date);
    expect(back.at.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(back.args.length).toBe(3);
    expect(back.args[1]).toBeUndefined();
    expect('gone' in back).toBe(false);
  });
});

describe('createWorldHandler', () => {
  it('answers storage calls with bytes and dates intact', async () => {
    const { fetch } = await server();
    const { world } = await tab(fetch);
    expect(world.specVersion).toBeGreaterThan(0);
    const runId = runIdNow();
    const input = new Uint8Array([1, 2, 3]);
    const created = await world.events.create(runId, {
      eventType: 'run_created',
      specVersion: world.specVersion,
      eventData: {
        deploymentId: await world.getDeploymentId(),
        workflowName: 'workflow//test//x',
        input,
      },
    });
    expect(created.event?.createdAt).toBeInstanceOf(Date);
    const run = await world.runs.get(runId);
    expect(run.createdAt).toBeInstanceOf(Date);
    expect(run.input).toBeInstanceOf(Uint8Array);
    expect([...(run.input as Uint8Array)]).toEqual([1, 2, 3]);
    const events = await world.events.list({ runId, resolveData: 'all' });
    expect(events.data.map((e) => e.eventType)).toEqual(['run_created']);
  });

  it('rehydrates World errors as their @workflow/errors classes', async () => {
    const { fetch } = await server();
    const { world } = await tab(fetch);
    const missing = await world.runs.get(runIdNow()).catch((e) => e);
    expect(missing).toBeInstanceOf(Error);
    expect(missing.name).toBe('WorkflowRunNotFoundError');
    expect(WorkflowRunNotFoundError.is(missing)).toBe(true);
    const hook = await world.hooks.getByToken('no-such-token').catch((e) => e);
    expect(hook).toBeInstanceOf(HookNotFoundError);
    expect(HookNotFoundError.is(hook)).toBe(true);

    const runId = runIdNow();
    const runCreated = {
      eventType: 'run_created',
      specVersion: world.specVersion,
      eventData: { deploymentId: 'd', workflowName: 'workflow//t//x', input: new Uint8Array() },
    } as const;
    await world.events.create(runId, runCreated);
    const duplicate = await world.events.create(runId, runCreated).catch((e) => e);
    expect(duplicate).toBeInstanceOf(EntityConflictError);
    expect(duplicate.message).toContain('already exists');

    // A finished run refuses further writes.
    await world.events.create(runId, { eventType: 'run_started' });
    await world.events.create(runId, {
      eventType: 'run_completed',
      eventData: { output: new Uint8Array() },
    });
    const late = await world.events.create(runId, { eventType: 'run_started' }).catch((e) => e);
    expect(late).toBeInstanceOf(RunExpiredError);
    expect(RunExpiredError.is(late)).toBe(true);
    expect(late.status).toBe(410);
    expect(late.message).not.toBe('');
  });

  it('refuses ops outside the allowlist, and unauthorized requests', async () => {
    const { handle } = await server({ authorize: (req) => req.headers.get('x-key') === 'k' });
    const call = (body: unknown, key = 'k') =>
      handle(
        new Request(BASE, {
          method: 'POST',
          headers: { 'x-key': key },
          body: JSON.stringify(body),
        })
      );
    expect((await call({ op: 'info', args: [] }, 'wrong')).status).toBe(401);
    const queued = await call({ op: 'queue', args: ['__wkf_workflow_x', { runId: 'r' }] });
    expect(queued.status).toBe(400);
    expect(((await queued.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_ARGUMENT'
    );
    expect((await call({ op: 'runs.create', args: [] })).status).toBe(400);
    expect((await call({ op: 'info', args: [] })).status).toBe(200);
  });

  it('calls onCommitted after a successful op only, and a failing hook does not fail the op', async () => {
    const seen: [string, unknown][] = [];
    const errors: unknown[] = [];
    const { fetch } = await server({
      onCommitted: async (op, args) => {
        seen.push([op, (args[1] as { eventType?: string } | undefined)?.eventType]);
        if ((args[1] as { eventType?: string } | undefined)?.eventType === 'run_started') throw new Error('arm failed');
      },
      onError: (err) => errors.push(err),
    });
    const { world } = await tab(fetch);
    const runId = runIdNow();
    await world.events.create(runId, {
      eventType: 'run_created',
      specVersion: world.specVersion,
      eventData: { deploymentId: 'd', workflowName: 'workflow//m//f', input: new Uint8Array() },
    } as never);
    // Refused by the World: no hook call for it.
    await expect(world.events.create(runId, { eventType: 'step_completed', correlationId: 'step_nope', eventData: { result: new Uint8Array() } } as never)).rejects.toThrow();
    // The hook throws, and the write still succeeds.
    await world.events.create(runId, { eventType: 'run_started' } as never);
    expect(seen).toEqual([
      ['info', undefined],
      ['events.create', 'run_created'],
      ['events.create', 'run_started'],
    ]);
    expect(errors).toHaveLength(1);
  });

  it('keeps the queue local: nothing is enqueued on the server World', async () => {
    const { backing, fetch } = await server();
    let serverQueued = 0;
    const original = backing.queue.bind(backing);
    backing.queue = (async (...args: Parameters<World['queue']>) => {
      serverQueued++;
      return original(...args);
    }) as World['queue'];
    const { world, queue } = await tab(fetch);
    const seen: unknown[] = [];
    world.createQueueHandler(QUEUE_PREFIX, async (message) => {
      seen.push(message);
    });
    await world.queue(QUEUE_NAME, { runId: 'wrun_x' });
    await queue.idle();
    expect(seen).toEqual([{ runId: 'wrun_x' }]);
    expect(serverQueued).toBe(0);
  });
});

describe('durableSessions over a remote World', () => {
  async function remoteSessions(fetch: (url: string, init: RequestInit) => Promise<Response>, harness: Harness) {
    const { world, queue } = await tab(fetch);
    const sessions = durableSessions({ world, harness, contendedDelaySeconds: 1 });
    return { world, queue, sessions };
  }

  it('turns a session into a run whose steps are the transcript', async () => {
    const { backing, fetch } = await server();
    const { sessions } = await remoteSessions(fetch, echoHarness());
    const { sessionId } = await sessions.start({ prompt: 'hello' });
    await sessions.send(sessionId, 'world');

    const state = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effectOrder.filter((e) => e.status === 'completed').length === 4 ? s : undefined;
    });
    expect(state.workflowName).toBe(workflowNameFor('echo'));
    expect(state.effectOrder.map((e) => [e.key, e.name, e.output])).toEqual([
      ['model:0', 'model', { tool: 'echo', args: 'HELLO' }],
      ['tool:model:0', 'tool.echo', 'HELLO'],
      ['model:1', 'model', { tool: 'echo', args: 'WORLD' }],
      ['tool:model:1', 'tool.echo', 'WORLD'],
    ]);

    // The log lives on the server: a reader of the backing World sees it all.
    const direct = durableSessions({ world: backing, harness: echoHarness() });
    const fromServer = await direct.inspect(sessionId);
    expect(fromServer.effectOrder.map((e) => e.key)).toEqual(state.effectOrder.map((e) => e.key));
    const run = await backing.runs.get(sessionId);
    expect(run.status).toBe('running');
  });

  it('streams live harness events through the remote tail', async () => {
    const { fetch } = await server();
    const { sessions } = await remoteSessions(fetch, echoHarness());
    const { sessionId } = await sessions.start();
    const abort = new AbortController();
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const event of sessions.live(sessionId, { signal: abort.signal })) {
        seen.push(event);
        if (seen.filter((e) => (e as { type?: string }).type === 'turn_end').length === 2) break;
      }
    })();
    await sessions.send(sessionId, 'one');
    await sessions.send(sessionId, 'two');
    await reading;
    abort.abort();
    expect(seen.filter((e) => (e as { type?: string }).type === 'turn_end')).toEqual([
      { type: 'turn_end', key: 'model:0' },
      { type: 'turn_end', key: 'model:1' },
    ]);
  });

  it('withdraws a submission that has not been placed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fetch } = await server();
    const { sessions } = await remoteSessions(fetch, echoHarness({ onTool: () => gate }));
    const { sessionId } = await sessions.start({ prompt: 'first' });
    await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effectOrder.some((e) => e.name === 'tool.echo') ? true : undefined;
    });
    const queued = await sessions.send(sessionId, 'second');
    expect(await sessions.withdraw(sessionId, queued)).toBe('withdrawn');
    release();
    await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.effects.get('tool:model:0')?.status === 'completed' ? s : undefined;
    });
    await new Promise((r) => setTimeout(r, 300));
    const after = await sessions.inspect(sessionId);
    expect(after.effectOrder.map((e) => e.key)).toEqual(['model:0', 'tool:model:0']);
  });

  it('a second tab picks up a session the first abandoned mid-tool', async () => {
    const { fetch } = await server();
    // Tab A hangs inside a replay:'never' tool, then "closes".
    const a = await remoteSessions(fetch, echoHarness({ onTool: () => new Promise(() => {}) }));
    const { sessionId } = await a.sessions.start({ prompt: 'hello' });
    await until(async () => {
      const s = await a.sessions.inspect(sessionId);
      return s.effects.get('tool:model:0')?.status === 'running' ? true : undefined;
    });
    a.queue.stop();

    // Tab B opens on the same server log and is woken for the session.
    const b = await remoteSessions(fetch, echoHarness());
    // No lease to wait out: A's intent names a drive this World does not run, so it is gone.
    await wake(b.world, sessionId);
    const tool = await until(async () => {
      const s = await b.sessions.inspect(sessionId);
      const t = s.effects.get('tool:model:0');
      return t?.status === 'failed' ? t : undefined;
    });
    expect(tool.error).toMatchObject({ interrupted: true, partial: [{ started: 'HELLO' }] });
    await b.sessions.send(sessionId, 'again');
    await until(async () => {
      const s = await b.sessions.inspect(sessionId);
      return s.effects.get('tool:model:1')?.status === 'completed' ? true : undefined;
    });
  });
});

describe('streams over the wire', () => {
  const runId = runIdNow();

  it('tails a stream until it closes', async () => {
    const { fetch } = await server();
    const { world } = await tab(fetch);
    const name = `${runId}_tail`;
    await world.streams.write(runId, name, 'a\n');
    const reading = world.streams.get(runId, name).then(readAll);
    await new Promise((r) => setTimeout(r, 50));
    await world.streams.writeMulti!(runId, name, ['b\n', new TextEncoder().encode('c\n')]);
    await world.streams.close(runId, name);
    expect(await reading).toBe('a\nb\nc\n');
    expect((await world.streams.getInfo(runId, name)).done).toBe(true);
    expect(await world.streams.list(runId)).toContain(name);
    const chunks = await world.streams.getChunks(runId, name);
    expect(chunks.data.every((c) => c.data instanceof Uint8Array)).toBe(true);
  });

  it('reconnects across server time budgets without losing or repeating bytes', async () => {
    const { fetch, requests } = await server({ maxStreamMs: 120 });
    const { world } = await tab(fetch);
    const name = `${runId}_budget`;
    const reading = world.streams.get(runId, name).then(readAll);
    const expected: string[] = [];
    for (let i = 0; i < 8; i++) {
      const line = `line ${i}\n`;
      expected.push(line);
      await world.streams.write(runId, name, line);
      await new Promise((r) => setTimeout(r, 60));
    }
    await world.streams.close(runId, name);
    expect(await reading).toBe(expected.join(''));
    // More than one tail request was needed: the budget really cut them.
    expect(requests()).toBeGreaterThan(8 + 3);
  });

  it('honors a negative startIndex across reconnects', async () => {
    const { fetch } = await server({ maxStreamMs: 100 });
    const { world } = await tab(fetch);
    const name = `${runId}_negative`;
    for (const c of ['1\n', '2\n', '3\n', '4\n']) await world.streams.write(runId, name, c);
    const reading = world.streams.get(runId, name, -2).then(readAll);
    await new Promise((r) => setTimeout(r, 250)); // at least one reconnect
    await world.streams.write(runId, name, '5\n');
    await world.streams.close(runId, name);
    expect(await reading).toBe('3\n4\n5\n');
  });

  it('cancelling the reader ends the tail', async () => {
    const { fetch } = await server();
    const { world } = await tab(fetch);
    const name = `${runId}_cancel`;
    await world.streams.write(runId, name, 'x');
    const stream = await world.streams.get(runId, name);
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('x');
    await reader.cancel();
  });
});
