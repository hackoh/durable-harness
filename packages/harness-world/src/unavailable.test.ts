import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { chatRoute, type DurableSessions, durableSessions, EffectFailure, QUEUE_PREFIX, vercelAnchors } from './index.ts';
import { type Broker, type BrokerMessage, hostProcess, leasedWorld } from './testing/index.ts';
import { defaultHint, failingOf, Unavailable, UNAVAILABLE_STEP, unavailableOf } from './unavailable.ts';
import type { DriveContext, Harness } from './types.ts';

/**
 * A harness that cannot run here (unavailable.ts) fails its turn, not its
 * session, and not over and over: one `unavailable` fact takes the turn's
 * messages, the live stream says `error` then `idle`, the delivery acks,
 * and the next message drives the harness again.
 */

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function setup(harness: Harness, extra: { queue?: boolean } = {}) {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-unavailable-')), recoverActiveRuns: false });
  worlds.push(world);
  const sessions = durableSessions({ world, harness, marks: false });
  if (extra.queue) world.registerHandler(QUEUE_PREFIX, sessions.handler);
  const { sessionId } = await sessions.start();
  return { world, sessions, sessionId };
}

/** Throws `fail()` while `broken.on`; otherwise answers each message with one model effect. */
function flaky(broken: { on: boolean; fail: () => unknown; halt?: boolean }, seen: string[]): Harness {
  return {
    name: 'flaky',
    async drive(ctx: DriveContext) {
      if (ctx.pending().length === 0) return;
      if (broken.on) {
        if (broken.halt) {
          // A spawn error reported from a callback (the process host's), then the harness's own exit error.
          setTimeout(() => ctx.halt?.(broken.fail()), 0);
          await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r(), { once: true }));
          throw new Error('claude exited mid-turn');
        }
        throw broken.fail();
      }
      for (const s of ctx.pending()) {
        seen.push(s.text ?? '');
        await ctx.effect(`model:${s.id}`, { name: 'model', replay: 'safe', input: s.text, placed: [s.id] }, async () => {
          ctx.live({ type: 'text', delta: `echo:${s.text}` });
          return 'ok';
        });
      }
      ctx.live({ type: 'idle' });
    },
  };
}

async function liveEvents(sessions: { live(id: string, o?: { startIndex?: number; signal?: AbortSignal }): AsyncGenerator<unknown> }, id: string, until: (e: { type?: string }) => boolean) {
  const out: { type?: string; code?: string; message?: string; hint?: string }[] = [];
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 10_000);
  for await (const e of sessions.live(id, { startIndex: 0, signal: stop.signal })) {
    const event = e as { type?: string };
    if (event.type === 'mark') continue;
    out.push(event as (typeof out)[number]);
    if (until(event)) break;
  }
  clearTimeout(timer);
  return out;
}

describe('a harness that cannot run here', () => {
  it('fails the turn once: the messages are placed by an unavailable fact, the stream says error then idle, the session lives', async () => {
    const broken = { on: true, fail: () => new Unavailable('/var/task/claude is not on this machine (spawn ENOENT)', { code: 'binary_missing' }) };
    const seen: string[] = [];
    const { sessions, sessionId } = await setup(flaky(broken, seen));
    const first = await sessions.send(sessionId, 'one', 'prompt', { wake: 'backstop' });
    // The drive resolves (the delivery would ack): nothing to redeliver.
    await sessions.drive(sessionId);
    const state = await sessions.inspect(sessionId);
    expect(state.status).toBe('running');
    const fact = state.effectOrder.find((e) => e.name === UNAVAILABLE_STEP)!;
    expect(fact.status).toBe('completed');
    expect(fact.placed).toEqual([first]);
    expect(fact.output).toMatchObject({ code: 'binary_missing', harness: 'flaky', message: '/var/task/claude is not on this machine (spawn ENOENT)' });
    expect(state.placed.has(first)).toBe(true);
    const events = await liveEvents(sessions, sessionId, (e) => e.type === 'idle');
    expect(events.map((e) => e.type)).toEqual(['error', 'idle']);
    expect(events[0]).toMatchObject({ code: 'binary_missing', message: '/var/task/claude is not on this machine (spawn ENOENT)' });
    expect(events[0]!.hint).toMatch(/native binary/);

    // Fixed (a redeploy, an install): the next message drives the harness, without the failed one.
    broken.on = false;
    await sessions.send(sessionId, 'two', 'prompt', { wake: 'backstop' });
    await sessions.drive(sessionId);
    expect(seen).toEqual(['two']);
    const after = await sessions.inspect(sessionId);
    expect(after.effectOrder.map((e) => [e.name, e.status])).toEqual([
      [UNAVAILABLE_STEP, 'completed'],
      ['model', 'completed'],
    ]);
  });

  it('is told by the reason a drive was halted with, whatever the harness throws on its way out', async () => {
    const broken = {
      on: true,
      halt: true,
      fail: () => new Unavailable('codex is not on this machine', { code: 'binary_missing', cause: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) }),
    };
    const { sessions, sessionId } = await setup(flaky(broken, []));
    await sessions.send(sessionId, 'go', 'prompt', { wake: 'backstop' });
    await sessions.drive(sessionId);
    const state = await sessions.inspect(sessionId);
    expect(state.effectOrder.map((e) => e.name)).toEqual([UNAVAILABLE_STEP]);
    expect(state.effectOrder[0]!.output).toMatchObject({ code: 'binary_missing' });
  });

  it('ends a chat response with the error, through the queue', async () => {
    const broken = { on: true, fail: () => new Error("the OpenCode host exited: Error: Cannot find module 'tree-sitter-bash/tree-sitter-bash.wasm'\nRequire stack:\n- /var/task/node_modules/@opencode/core/dist/shell/parser-wasm.node.js\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)") };
    const { sessions } = await setup(flaky(broken, []), { queue: true });
    const route = chatRoute(sessions, { keepaliveMs: 60_000 });
    const t0 = Date.now();
    const res = await route.POST(new Request('http://local/api/chat', { method: 'POST', body: JSON.stringify({ text: 'hi' }), headers: { 'content-type': 'application/json' } }));
    const text = await res.text();
    expect(Date.now() - t0).toBeLessThan(5000);
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)) as { type?: string; code?: string; message?: string })
      .filter((e) => e.type && e.type !== 'mark');
    expect(data.map((e) => e.type)).toEqual(['error', 'idle']);
    expect(data[0]).toMatchObject({ code: 'module_missing', message: "the OpenCode host exited: Error: Cannot find module 'tree-sitter-bash/tree-sitter-bash.wasm'" });
    expect(text).toMatch(/;end\n/);
    expect(text).toContain('event: end');
  });

  it('a transient error still ends the delivery with its error, for the queue to redeliver', async () => {
    const broken = { on: true, fail: () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) };
    const { sessions, sessionId } = await setup(flaky(broken, []));
    await sessions.send(sessionId, 'go', 'prompt', { wake: 'backstop' });
    await expect(sessions.drive(sessionId)).rejects.toThrow('ECONNRESET');
    const state = await sessions.inspect(sessionId);
    expect(state.effectOrder).toEqual([]);
    expect(state.placed.size).toBe(0);
  });

  it('an error it does not know fails the turn only once a message has failed maxFailedDeliveries times', async () => {
    const broken = { on: true, fail: () => new Error('the child said something odd') };
    const { sessions, sessionId } = await setup(flaky(broken, []));
    await sessions.send(sessionId, 'go', 'prompt', { wake: 'backstop' });
    await expect(sessions.drive(sessionId, { attempt: 7 })).rejects.toThrow('odd');
    await sessions.drive(sessionId, { attempt: 8 });
    const fact = (await sessions.inspect(sessionId)).effectOrder.find((e) => e.name === UNAVAILABLE_STEP)!;
    expect(fact.output).toMatchObject({ code: 'failing', attempt: 8, message: 'failed on 8 deliveries in a row: the child said something odd' });
  });
});

/**
 * The drive route on a World whose queue outlives the process (Vercel): the
 * chat Function drives the turn itself, with a companion delayed past its
 * deadline behind it, and another Function (its own bundle) serves the
 * queue. Queue seconds are 50 ms here; the direct drive's deadline is a
 * minute away, so its companion comes 65 queue seconds (3.25 s) later.
 */
async function setupSplit(chatHarness: Harness, flowHarness: Harness) {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-unavailable-')), recoverActiveRuns: false });
  worlds.push(world);
  const leased = leasedWorld(world, { visibilityMs: 300, secondMs: 50 });
  const common = { anchors: vercelAnchors(), directDriveMs: 60_000, marks: false };
  const chat = durableSessions({ world: hostProcess(leased).world, harness: chatHarness, ...common });
  // Registered last, so it serves the queue.
  const flow = durableSessions({ world: leased, harness: flowHarness, ...common });
  const { sessionId } = await flow.start();
  return { chat, flow, broker: leased.broker, sessionId };
}

const inputOf = (m: BrokerMessage) => (m.payload as { input?: { companion?: boolean; continues?: string } }).input ?? {};
const notCompanion = (m: BrokerMessage) => !inputOf(m).companion;
const missing = () => new Unavailable('Native CLI binary for linux-x64 not found.', { code: 'binary_missing' });

/** A chat route over the drive route (durable-harness's): send with a companion, then drive in this invocation. */
async function chatTurn(chat: DurableSessions, broker: Broker, sessionId: string) {
  const route = chatRoute(chat, {
    keepaliveMs: 60_000,
    async send(id, text, kind) {
      const submissionId = await chat.send(id, text, kind, { wake: 'backstop' });
      void chat.drive(id);
      return submissionId;
    },
  });
  const res = await route.POST(new Request('http://local/api/chat', { method: 'POST', body: JSON.stringify({ sessionId, text: 'hi' }), headers: { 'content-type': 'application/json' } }));
  // The queue's Function: everything but the companion, while the response streams.
  let streaming = true;
  const serving = (async () => {
    while (streaming) {
      await broker.drain({ timeoutMs: 200, filter: notCompanion });
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  const text = await res.text();
  streaming = false;
  await serving;
  const events = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as { type?: string; code?: string; delta?: string })
    .filter((e) => e.type && e.type !== 'mark');
  return { text, events };
}

describe('a direct drive with a companion behind it, whose harness cannot run in its Function', () => {
  it('hands the turn to the queue at once, and a Function that can run the harness answers it', async () => {
    const seen: string[] = [];
    const { chat, flow, broker, sessionId } = await setupSplit(flaky({ on: true, fail: missing }, []), flaky({ on: false, fail: missing }, seen));
    const first = await chat.send(sessionId, 'one', 'prompt', { wake: 'backstop' });
    await chat.drive(sessionId);
    // Nothing failed: the message waits for the queue, unplaced.
    let state = await flow.inspect(sessionId);
    expect(state.effectOrder.some((e) => e.name === UNAVAILABLE_STEP)).toBe(false);
    expect(state.placed.has(first)).toBe(false);
    // A continuation, due now; the companion still a deadline away.
    const continuation = broker.sent().find((m) => inputOf(m).continues)!;
    expect(continuation).toBeDefined();
    expect(continuation.availableAt).toBeLessThanOrEqual(Date.now());
    const companion = broker.sent().find((m) => inputOf(m).companion)!;
    expect(companion.availableAt - Date.now()).toBeGreaterThan(2000);
    await broker.deliver(continuation.messageId)!.done;
    expect(seen).toEqual(['one']);
    state = await flow.inspect(sessionId);
    expect(state.placed.has(first)).toBe(true);
    expect(state.effectOrder.filter((e) => e.name !== 'recover').map((e) => [e.name, e.status])).toEqual([['model', 'completed']]);
    const events = await liveEvents(flow, sessionId, (e) => e.type === 'idle');
    expect(events.map((e) => e.type)).toEqual(['text', 'idle']);
  });

  it('a queue delivery that meets it fails the turn: the error comes in seconds, not past the deadline', async () => {
    const { chat, flow, broker, sessionId } = await setupSplit(flaky({ on: true, fail: missing }, []), flaky({ on: true, fail: missing }, []));
    const first = await chat.send(sessionId, 'one', 'prompt', { wake: 'backstop' });
    const t0 = Date.now();
    await chat.drive(sessionId);
    await broker.drain({ timeoutMs: 3000, filter: notCompanion });
    expect(Date.now() - t0).toBeLessThan(2000);
    const facts = (await flow.inspect(sessionId)).effectOrder.filter((e) => e.name === UNAVAILABLE_STEP);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.placed).toEqual([first]);
    expect(facts[0]!.output).toMatchObject({ code: 'binary_missing', attempt: 1, message: 'Native CLI binary for linux-x64 not found.' });
    // Written by the queue's delivery, under its own message.
    expect(facts[0]!.anchor?.k).toBe('msg');
    const events = await liveEvents(flow, sessionId, (e) => e.type === 'idle');
    expect(events.map((e) => e.type)).toEqual(['error', 'idle']);
    // The companion, past the deadline, finds the turn over: no second failure.
    const companion = broker.sent().find((m) => inputOf(m).companion)!;
    companion.availableAt = 0;
    await broker.deliver(companion.messageId)!.done;
    expect((await flow.inspect(sessionId)).effectOrder.filter((e) => e.name === UNAVAILABLE_STEP)).toHaveLength(1);
  });

  it('a chat response streams the turn when the queue’s Function runs it, and the error when it cannot either', async () => {
    const ok = await setupSplit(flaky({ on: true, fail: missing }, []), flaky({ on: false, fail: missing }, []));
    const answered = await chatTurn(ok.chat, ok.broker, ok.sessionId);
    expect(answered.events.map((e) => e.type)).toEqual(['text', 'idle']);
    expect(answered.events[0]).toMatchObject({ delta: 'echo:hi' });
    expect(answered.text).toMatch(/;end\n/);

    const broken = await setupSplit(flaky({ on: true, fail: missing }, []), flaky({ on: true, fail: missing }, []));
    const t0 = Date.now();
    const failed = await chatTurn(broken.chat, broken.broker, broken.sessionId);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(failed.events.map((e) => e.type)).toEqual(['error', 'idle']);
    expect(failed.events[0]).toMatchObject({ code: 'binary_missing' });
    expect(failed.text).toMatch(/;end\n/);
  });
});

describe('unavailableOf', () => {
  const errno = (message: string, code: string, extra: object = {}) => Object.assign(new Error(message), { code, ...extra });

  it('knows an Unavailable anywhere in the cause chain', () => {
    const inner = new Unavailable('claude is not on this machine', { code: 'binary_missing', hint: 'include it' });
    expect(unavailableOf(new Error('drive failed', { cause: inner }))).toEqual({ code: 'binary_missing', message: 'claude is not on this machine', hint: 'include it' });
    expect(unavailableOf(new AggregateError([new Error('x'), inner]))?.code).toBe('binary_missing');
  });

  it('knows modules that are not installed, by code or by a child’s message', () => {
    expect(unavailableOf(errno("Cannot find package '@opencode/core' imported from /var/task/x.js", 'ERR_MODULE_NOT_FOUND'))?.code).toBe('module_missing');
    expect(unavailableOf(errno("Cannot find module 'tree-sitter-bash/tree-sitter-bash.wasm'", 'MODULE_NOT_FOUND'))?.code).toBe('module_missing');
    const fromChild = unavailableOf(new Error("the OpenCode host exited: some output\nmore output\nError: Cannot find module 'web-tree-sitter/tree-sitter.wasm'\nRequire stack:\n- /var/task/a.js"));
    expect(fromChild).toEqual({ code: 'module_missing', message: "Error: Cannot find module 'web-tree-sitter/tree-sitter.wasm'" });
    // An effect's committed failure, rethrown on replay.
    expect(unavailableOf(new EffectFailure({ message: "Cannot find module 'x'" }))?.code).toBe('module_missing');
  });

  it('knows the Claude Agent SDK’s own binary errors, and native code that does not load', () => {
    expect(unavailableOf(new Error('Claude Code native binary not found at /var/task/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude. Please ensure ...'))?.code).toBe('binary_missing');
    expect(unavailableOf(new Error('Claude Code native binary at /x/claude exists but failed to launch. This usually means ...'))?.code).toBe('binary_unusable');
    // When it finds no platform package itself (pathToClaudeCodeExecutable unset).
    expect(unavailableOf(new Error('Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.'))?.code).toBe('binary_missing');
    expect(unavailableOf(Object.assign(new Error('whatever it says'), { errorClass: 'executable_not_found' }))?.code).toBe('binary_missing');
    expect(unavailableOf(errno('/var/task/x.node: invalid ELF header', 'ERR_DLOPEN_FAILED'))?.code).toBe('binary_unusable');
  });

  it('leaves everything else to the queue', () => {
    // A spawn ENOENT on its own may be a missing working directory: the process host decides.
    expect(unavailableOf(errno('spawn /var/task/claude ENOENT', 'ENOENT', { syscall: 'spawn /var/task/claude' }))).toBeUndefined();
    expect(unavailableOf(errno('read ECONNRESET', 'ECONNRESET'))).toBeUndefined();
    expect(unavailableOf(new Error('claude exited mid-turn (killed)'))).toBeUndefined();
    expect(unavailableOf(Object.assign(new Error('Service Unavailable'), { status: 503 }))).toBeUndefined();
    expect(unavailableOf(undefined)).toBeUndefined();
  });

  it('does not read a child that a signal ended by its stderr tail', () => {
    // Out of memory after a warning that names a library: the redelivery, on another instance, may run.
    const warning = 'WARN codex_core::exec: sandbox probe failed: libseccomp.so.2: cannot open shared object file: No such file or directory';
    expect(unavailableOf(new Error(`codex app-server exited (SIGKILL): ${warning}`))).toBeUndefined();
    expect(unavailableOf(new Error(`a-harness: its host exited (SIGKILL): Error: Cannot find module 'x'`))).toBeUndefined();
    // Exited on its own with the error: still known.
    expect(unavailableOf(new Error(`codex app-server exited (code 1): Error: ${warning}`))?.code).toBe('binary_unusable');
  });
});

describe('failingOf', () => {
  it('counts deliveries of one message, never the World’s or the network’s errors', () => {
    expect(failingOf(new Error('boom'), 7, 8)).toBeUndefined();
    expect(failingOf(new Error('boom'), undefined, 8)).toBeUndefined();
    expect(failingOf(new Error('boom'), 8, 8)).toEqual({ code: 'failing', message: 'failed on 8 deliveries in a row: boom' });
    expect(failingOf(Object.assign(new Error('Too Many Requests'), { status: 429 }), 20, 8)).toBeUndefined();
    expect(failingOf(Object.assign(new Error('x'), { retryAfter: 30 }), 20, 8)).toBeUndefined();
    expect(failingOf(new Error('wrapped', { cause: Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' }) }), 20, 8)).toBeUndefined();
    expect(failingOf(new Error('boom'), 100, Infinity)).toBeUndefined();
  });
});

describe('defaultHint for the sandbox-tier codes (docs/workspaces.md §5, §6)', () => {
  it('names the fix for each new code without leaking a value', () => {
    expect(defaultHint({ code: 'sandbox_required', message: 'x' }, 'Claude Code')).toContain('workspace: sandbox()');
    expect(defaultHint({ code: 'cli_version', message: 'x' }, 'Codex')).toMatch(/newer|pinned/);
    // A generic code still falls through to the default sentence.
    expect(defaultHint({ code: 'unavailable', message: 'x' }, 'Pi')).toContain('cannot run on this machine');
  });
});
