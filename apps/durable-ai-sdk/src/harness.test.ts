import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { APICallError, tool } from 'ai';
import { defineDoc, deliver, durableSessions, type Harness, type HostToolIO, QUEUE_PREFIX, type SessionState } from 'harness-world';
import { hostProcess } from 'harness-world/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CRASH_PROMPT, crashDuringPayment, recoverInChild, until } from './crash.ts';
import { aiSdkHarness, type Checkpoint, type DurableTool, transcript } from './harness.ts';
import { scriptedModel, text, toolCall } from './scripted.ts';
import { makePayment, readLedger } from './tools.ts';

/** The scripted tests: no credential, a scripted model, world-local in a temp dir. */

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function local(dataDir?: string, recoverActiveRuns = false) {
  const world = createWorld({ dataDir: dataDir ?? (await mkdtemp(join(tmpdir(), 'durable-ai-sdk-'))), recoverActiveRuns });
  worlds.push(world);
  return world;
}

function shout(runs: string[] = []): DurableTool {
  return {
    ...tool({
      description: 'Uppercase some text.',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        runs.push(text);
        return text.toUpperCase();
      },
    }),
    replay: 'never',
  };
}

const checkpointed = (sessions: { inspect(id: string): Promise<SessionState> }, id: string, turn: number) =>
  until(async () => {
    const state = await sessions.inspect(id);
    return state.effects.get(`checkpoint:${turn}`)?.status === 'completed' ? state : undefined;
  }, 30_000, `checkpoint:${turn}`);

// Every test runs twice: awaited writes ("Strict") and run-ahead ("Durable On").
// The kernel reads HARNESS_DURABILITY, and the crash child inherits it.
describe.each(['strict', 'run-ahead'])('ai-sdk harness, scripted model, %s', (durability) => {
  const before = process.env.HARNESS_DURABILITY;
  beforeAll(() => {
    process.env.HARNESS_DURABILITY = durability;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.HARNESS_DURABILITY;
    else process.env.HARNESS_DURABILITY = before;
  });

  it('records a tool turn as effects and folds it back into the same messages', async () => {
    const runs: string[] = [];
    const model = scriptedModel([toolCall('shout', { text: 'hi' }, 'call_1'), text('I shouted HI.'), text('Twice now.')]);
    const world = await local();
    const sessions = durableSessions({ world, harness: aiSdkHarness({ model, instructions: 'Be loud.', tools: { shout: shout(runs) } }) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({ prompt: 'shout hi' });

    let state = await checkpointed(sessions, sessionId, 0);
    expect(state.effectOrder.map((e) => e.key)).toEqual(['turn:0', 'model:0:0', 'tool:call_1', 'model:0:1', 'checkpoint:0']);
    expect(state.effects.get('tool:call_1')).toMatchObject({ name: 'tool.shout', replay: 'never', status: 'completed', output: 'HI' });
    expect(runs).toEqual(['hi']);
    expect(state.submissions.every((s) => state.placed.has(s.id))).toBe(true);
    const end = state.effects.get('checkpoint:0')!.output as Checkpoint;
    expect(end.stopReason).toBe('stop');
    expect(transcript(state).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    // The next turn's request is built from the fold of the log alone, and
    // the fold of turn 0 is exactly what the live loop sent the model.
    await sessions.send(sessionId, 'again');
    state = await checkpointed(sessions, sessionId, 1);
    expect(model.calls).toHaveLength(3);
    const [, live, folded] = model.calls;
    expect(folded!.prompt.slice(0, live!.prompt.length)).toEqual(live!.prompt);
    expect(folded!.prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    expect(transcript(state).at(-1)).toMatchObject({ role: 'assistant' });
  });

  it('a tool edits a document through its io; promptDocs shows it to the next model call, and app code reads it', async () => {
    const Todos = defineDoc<{ items: string[] }>({ kind: 'app.todos', version: 1, initial: () => ({ items: [] }) });
    const addTodo: DurableTool = {
      ...tool({ description: 'Add a todo.', inputSchema: z.object({ item: z.string() }) }),
      replay: 'safe',
      execute: async ({ item }: { item: string }, _options: unknown, io: HostToolIO) => {
        io.docs!.update(Todos, (d) => void d.items.push(item));
        return 'added';
      },
    } as DurableTool;
    const model = scriptedModel([toolCall('add_todo', { item: 'milk' }, 'call_t'), text('Added milk.')]);
    const world = await local();
    const sessions = durableSessions({ world, harness: aiSdkHarness({ model, instructions: 'Be brief.', tools: { add_todo: addTodo }, promptDocs: [Todos] }) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({ prompt: 'add milk' });
    const state = await checkpointed(sessions, sessionId, 0);
    expect(state.effects.get('tool:call_t')?.docs).toEqual([{ kind: 'app.todos', revision: 1 }]);
    expect(await sessions.doc(sessionId, Todos)).toEqual({ revision: 1, value: { items: ['milk'] } });
    // The instructions are the same on every call (a cached prefix); the documents open the latest prompt.
    const systems = model.calls.map((c) => c.prompt.filter((m) => m.role === 'system').map((m) => m.content));
    expect(systems).toEqual([['Be brief.'], ['Be brief.']]);
    const latest = model.calls.map((c) => c.prompt.findLast((m) => m.role === 'user')!.content as { type: string; text: string }[]);
    expect(latest[0]).toEqual([{ type: 'text', text: expect.stringContaining('<document name="todos" kind="app.todos" revision="0">\n{"items":[]}') }, { type: 'text', text: 'add milk' }]);
    expect(latest[1]).toEqual([{ type: 'text', text: expect.stringContaining('<document name="todos" kind="app.todos" revision="1">\n{"items":["milk"]}') }, { type: 'text', text: 'add milk' }]);
    // Everything after the prompt (the tool call and its result) is as the conversation has it.
    expect(model.calls[1]!.prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    // The recorded conversation is what it was without the hook: the documents are read inside each call.
    expect(state.effects.get('model:0:1')?.input).toMatchObject({ messages: 4 });
  });

  // A prompt cache keyed on the prompt's last message (Anthropic's) hits only
  // when the prompt starts with an earlier one: documents taken off a message
  // once it is no longer the latest would make every new turn miss.
  it('with promptDocs, each prompt starts with the one before it, across turns, edits and a new World', async () => {
    const Todos = defineDoc<{ items: string[] }>({ kind: 'app.todos', version: 1, initial: () => ({ items: [] }) });
    const addTodo: DurableTool = {
      ...tool({ description: 'Add a todo.', inputSchema: z.object({ item: z.string() }) }),
      replay: 'safe',
      execute: async ({ item }: { item: string }, _options: unknown, io: HostToolIO) => {
        io.docs!.update(Todos, (d) => void d.items.push(item));
        return 'added';
      },
    } as DurableTool;
    const dataDir = await mkdtemp(join(tmpdir(), 'durable-ai-sdk-'));
    const first = scriptedModel([toolCall('add_todo', { item: 'milk' }, 'call_t'), text('Added milk.'), toolCall('shout', { text: 'hi' }, 'call_s'), text('HI.')]);
    const harness = (model: ReturnType<typeof scriptedModel>) => aiSdkHarness({ model, instructions: 'Be brief.', tools: { add_todo: addTodo, shout: shout() }, promptDocs: [Todos] });
    const a = await local(dataDir);
    const sa = durableSessions({ world: a, harness: harness(first) });
    a.registerHandler(QUEUE_PREFIX, sa.handler);
    const { sessionId } = await sa.start({ prompt: 'add milk' });
    await checkpointed(sa, sessionId, 0);
    await sa.send(sessionId, 'shout hi');
    const state = await checkpointed(sa, sessionId, 1);
    // Recorded: a new latest message (calls 1 and 3) and a change on it (call 2); not an unchanged one (call 4).
    const models = state.effectOrder.filter((e) => e.name === 'model');
    expect(models.map((r) => (r.output as { promptDocs?: { at: number } }).promptDocs?.at)).toEqual([1, 1, 5, undefined]);
    // The AI SDK never sees the record.
    expect(first.calls).toHaveLength(4);
    await a.close?.();

    // A new World and harness after an app edit: its prompt starts with the last one too.
    const second = scriptedModel([text('Noted.')]);
    const b = await local(dataDir);
    const sb = durableSessions({ world: b, harness: harness(second) });
    b.registerHandler(QUEUE_PREFIX, sb.handler);
    await sb.updateDoc(sessionId, Todos, (d) => void d.items.push('eggs'));
    await sb.send(sessionId, 'thanks');
    await checkpointed(sb, sessionId, 2);
    const prompts = [...first.calls, ...second.calls].map((c) => JSON.parse(JSON.stringify(c.prompt)) as { role: string; content: unknown }[]);
    for (let i = 1; i < prompts.length; i++) {
      // The tool's edit in the first turn changed the latest message's documents (index 1): the second prompt keeps what comes before it.
      const kept = i === 1 ? 1 : prompts[i - 1]!.length;
      expect(prompts[i]!.slice(0, kept)).toEqual(prompts[i - 1]!.slice(0, kept));
    }
    const docsOn = (p: { role: string; content: unknown }[]) =>
      p.flatMap((m) => (m.role !== 'user' ? [] : [((m.content as { text?: string }[])[0]!.text ?? '').match(/"items":(\[[^\]]*\])/)?.[1] ?? '-']));
    expect(prompts.map(docsOn)).toEqual([['[]'], ['["milk"]'], ['["milk"]', '["milk"]'], ['["milk"]', '["milk"]'], ['["milk"]', '["milk"]', '["milk","eggs"]']]);
  });

  it('a new World and harness on the same log replay recorded calls instead of making them', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'durable-ai-sdk-'));
    const runs: string[] = [];
    const first = scriptedModel([toolCall('shout', { text: 'hi' }, 'call_1'), text('I shouted HI.')]);
    const a = await local(dataDir);
    const sa = durableSessions({ world: a, harness: aiSdkHarness({ model: first, tools: { shout: shout(runs) } }) });
    a.registerHandler(QUEUE_PREFIX, sa.handler);
    const { sessionId } = await sa.start({ prompt: 'shout hi' });
    await checkpointed(sa, sessionId, 0);
    await a.close?.();

    // A new World instance and harness: nothing in memory but the log.
    const second = scriptedModel([text('Still loud.')]);
    const b = await local(dataDir);
    const sb = durableSessions({ world: b, harness: aiSdkHarness({ model: second, tools: { shout: shout(runs) } }) });
    b.registerHandler(QUEUE_PREFIX, sb.handler);
    await sb.send(sessionId, 'and now?');
    const state = await checkpointed(sb, sessionId, 1);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.prompt.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(runs).toEqual(['hi']);
    expect((state.effects.get('checkpoint:1')!.output as Checkpoint).messages).toHaveLength(1);
  });

  it('a model call that fails for good ends the turn, and the session goes on', async () => {
    const model = scriptedModel([new Error('the provider said no'), text('Back.')]);
    const world = await local();
    const sessions = durableSessions({ world, harness: aiSdkHarness({ model }) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({ prompt: 'hello?' });
    let state = await checkpointed(sessions, sessionId, 0);
    expect(state.effects.get('model:0:0')).toMatchObject({ status: 'failed', error: { message: 'the provider said no' } });
    expect(state.effects.get('checkpoint:0')!.output).toMatchObject({ stopReason: 'error', error: 'the provider said no', messages: [] });
    await sessions.send(sessionId, 'hello again');
    state = await checkpointed(sessions, sessionId, 1);
    expect(transcript(state).map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
  });

  it('a model call that fails after a tool step keeps that step in the conversation', async () => {
    const runs: string[] = [];
    const refused = new APICallError({ message: 'bad request', url: 'https://example', requestBodyValues: {}, statusCode: 400, isRetryable: false });
    const model = scriptedModel([toolCall('shout', { text: 'hi' }, 'call_1'), refused, text('Yes: HI.')]);
    const world = await local();
    const sessions = durableSessions({ world, harness: aiSdkHarness({ model, tools: { shout: shout(runs) } }) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({ prompt: 'shout hi' });
    let state = await checkpointed(sessions, sessionId, 0);
    expect(state.effects.get('model:0:1')).toMatchObject({ status: 'failed', error: { message: 'bad request' } });
    const end = state.effects.get('checkpoint:0')!.output as Checkpoint;
    expect(end).toMatchObject({ stopReason: 'error', error: 'bad request' });
    expect(end.messages.map((m) => m.role)).toEqual(['assistant', 'tool']);

    // The next turn's request still has the call and its result.
    await sessions.send(sessionId, 'did you shout?');
    state = await checkpointed(sessions, sessionId, 1);
    expect(runs).toEqual(['hi']);
    const next = model.calls.at(-1)!.prompt;
    expect(next.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(JSON.stringify(next)).toContain('call_1');
    expect(JSON.stringify(next)).toContain('HI');
  });

  it('a second driver that loses a tool call to the live one stops: no model call, no checkpoint, one payment', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'durable-ai-sdk-'));
    const ledger = join(dataDir, 'ledger.jsonl');
    const world = await local(dataDir);
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true })); // the test delivers by hand
    const pay = (id: string) => toolCall('make_payment', { to: 'alice@example.com', amountUsd: 5, memo: 'lunch' }, id);
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((r) => (open = r));
      return { open, opened };
    };
    const atTool = gate();
    const goA = gate();
    const enteredB = gate();
    const goB = gate();

    // A, the live driver: it pauses between asking for the payment and making it.
    const a = aiSdkHarness({
      model: scriptedModel([pay('call_pay_1'), text('Paid.')]),
      tools: { make_payment: makePayment(ledger, 1500) },
      onToolExecutionStart: async () => {
        atTool.open();
        await goA.opened;
      },
    });
    // B, a duplicate delivery of the same session. Were it handed the
    // contended error as a tool result, its model would pay again.
    const bModel = scriptedModel([pay('call_pay_2'), text('Paid again.')]);
    const bHarness = aiSdkHarness({ model: bModel, tools: { make_payment: makePayment(ledger, 0) } });
    const b: Harness = {
      ...bHarness,
      async drive(ctx) {
        enteredB.open();
        await goB.opened;
        return bHarness.drive(ctx);
      },
    };

    const sessions = durableSessions({ world, harness: a });
    const { sessionId } = await sessions.start({ prompt: CRASH_PROMPT });
    const first = deliver({ world, harness: a }, sessionId);
    await atTool.opened;
    await until(async () => ((await sessions.inspect(sessionId)).effects.get('model:0:0')?.status === 'completed' ? true : undefined));
    // B is another process (its own view of the World: this process's drive
    // registry would have it rerun A instead). Nothing is running, so B is
    // admitted on the same epoch, and its log has model:0:0.
    const second = deliver({ world: hostProcess(world).world, harness: b }, sessionId);
    await Promise.race([enteredB.opened, second.then((r) => Promise.reject(new Error(`B was not admitted: ${JSON.stringify(r)}`)))]);
    goA.open();
    await until(async () => ((await readLedger(ledger)).length > 0 ? true : undefined));
    // A's payment is running. B replays model:0:0 and reaches the same call.
    goB.open();
    const yielded = await second;
    await first;
    expect(bModel.calls).toHaveLength(0);
    expect(await readLedger(ledger)).toHaveLength(1);
    expect(yielded).toBeUndefined(); // B yielded (contended), through a continuation
    const state = await sessions.inspect(sessionId);
    expect(state.effects.get('tool:call_pay_1')).toMatchObject({ status: 'completed' });
    expect(state.effects.get('tool:call_pay_2')).toBeUndefined();
    const end = state.effects.get('checkpoint:0')!;
    expect(end.status).toBe('completed');
    expect(JSON.stringify(end.output)).not.toContain('contended');
    expect((end.output as Checkpoint).messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('retries a retryable provider error inside the model step', async () => {
    const overloaded = new APICallError({ message: 'overloaded', url: 'https://example', requestBodyValues: {}, statusCode: 529, isRetryable: true });
    const model = scriptedModel([overloaded, text('Made it.')]);
    const world = await local();
    const sessions = durableSessions({ world, harness: aiSdkHarness({ model, maxRetries: 1 }) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start({ prompt: 'hello?' });
    const state = await checkpointed(sessions, sessionId, 0);
    expect(model.calls).toHaveLength(2);
    expect(state.effectOrder.map((e) => `${e.key}:${e.status}`)).toEqual(['turn:0:completed', 'model:0:0:completed', 'checkpoint:0:completed']);
  });

  /** Crash a drive in this process partway through its first tool call (the kernel's chaos), then close its World. */
  async function crashMidTool(dataDir: string, model: ReturnType<typeof scriptedModel>, t: DurableTool, instructions?: string) {
    const world = await local(dataDir);
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    const sessions = durableSessions({
      world,
      chaos: true,
      crash: () => crashed(),
      harness: aiSdkHarness({ model, tools: { t }, ...(instructions ? { instructions } : {}) }),
    });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const { sessionId } = await sessions.start();
    await sessions.chaos(sessionId, { at: 'tool', afterMs: 200 });
    await sessions.send(sessionId, 'go');
    await died;
    await world.close?.();
    return sessionId;
  }

  /** A tool that takes a second, so an armed crash lands inside it. */
  function slow(replay: 'safe' | 'never', runs: number[] = []): DurableTool {
    return {
      ...tool({
        description: 'Count, slowly.',
        inputSchema: z.object({}),
        execute: async () => {
          runs.push(Date.now());
          await new Promise((r) => setTimeout(r, 1000));
          return `run ${runs.length}`;
        },
      }),
      replay,
    };
  }

  it('a crash mid-call reruns a replay-safe tool', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'durable-ai-sdk-'));
    const runs: number[] = [];
    const sessionId = await crashMidTool(dataDir, scriptedModel([toolCall('t', {}, 'call_safe')]), slow('safe', runs));
    const model = scriptedModel([text('Counted.')]);
    const world = await local(dataDir, true);
    const sessions = durableSessions({ world, harness: aiSdkHarness({ model, tools: { t: slow('safe', runs) } }) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    await world.start?.();
    const state = await checkpointed(sessions, sessionId, 0);
    expect(runs).toHaveLength(2);
    expect(state.effects.get('tool:call_safe')).toMatchObject({ status: 'completed', output: 'run 2' });
    expect(JSON.stringify(model.calls[0]!.prompt.at(-1))).toContain('run 2');
  });

  it('running out of invocation time mid tool chain hands the rest to the next drive at once: each tool and model call once', async () => {
    const world = await local();
    const runs: string[] = [];
    const model = scriptedModel([...Array.from({ length: 6 }, (_, i) => toolCall('step', { i }, `call_${i}`)), text('Done.')]);
    const step: DurableTool = {
      ...tool({
        description: 'One step of the chain.',
        inputSchema: z.object({ i: z.number() }),
        execute: async ({ i }) => {
          runs.push(`step ${i}`);
          await new Promise((r) => setTimeout(r, 400));
          return `ok ${i}`;
        },
      }),
      replay: 'never',
    };
    const logs: string[] = [];
    // About three steps per drive, so the chain crosses at least one budget boundary.
    const sessions = durableSessions({ world, harness: aiSdkHarness({ model, tools: { step } }), maxInvocationMs: 1300, deadlineMarginMs: 0, log: (m) => logs.push(m) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const t0 = Date.now();
    const { sessionId } = await sessions.start({ prompt: 'go' });
    const state = await checkpointed(sessions, sessionId, 0);
    // About 3 s of work; each budget boundary hands over through a continuation, at once.
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(logs).toContain('yield: budget');
    expect(logs.filter((l) => l.startsWith('defer'))).toEqual([]);
    expect(runs).toEqual(Array.from({ length: 6 }, (_, i) => `step ${i}`));
    expect(model.calls).toHaveLength(7);
    const end = state.effects.get('checkpoint:0')!.output as Checkpoint;
    expect(end.stopReason).toBe('stop');
    expect(end.messages.filter((m) => m.role === 'tool')).toHaveLength(6);
  });

  it('a replay that sends a different conversation than the log recorded fails the session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'durable-ai-sdk-'));
    const sessionId = await crashMidTool(dataDir, scriptedModel([toolCall('t', {}, 'call_1')]), slow('never'), 'Be loud.');
    // The same session, driven by a build without the system prompt.
    const world = await local(dataDir, true);
    const sessions = durableSessions({ world, harness: aiSdkHarness({ model: scriptedModel([]), tools: { t: slow('never') } }) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    await world.start?.();
    const state = await until(async () => {
      const s = await sessions.inspect(sessionId);
      return s.status === 'failed' ? s : undefined;
    });
    expect(state.failure?.message).toContain('model:0:0: the agent sent a different conversation than the log recorded');
  });

  it('SIGKILL during a never tool: a new process recovers from the log, the ledger has one payment, the model hears it was interrupted', async () => {
    const { dataDir, ledger, sessionId, signal, childPid } = await crashDuringPayment('scripted');
    expect(signal).toBe('SIGKILL');
    expect(await readLedger(ledger)).toHaveLength(1);

    // Another OS process, which never drove the session, opens the same
    // World. Its start() redelivers the session; the open intent's anchor
    // names the killed pid, so the kernel resolves it at once by the tool's replay rule.
    const r = await recoverInChild({ dataDir, ledger, sessionId, model: 'scripted' });
    expect(r.pid).not.toBe(childPid);
    expect(r.pid).not.toBe(process.pid);

    const payments = await readLedger(ledger);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.pid).toBe(childPid);
    expect(r.submissions[0]).toBe(CRASH_PROMPT);
    const pay = r.effects.filter((e) => e.name === 'tool.make_payment');
    expect(pay).toEqual([expect.objectContaining({ key: 'tool:call_pay_1', replay: 'never', status: 'failed', error: expect.objectContaining({ interrupted: true }) })]);
    expect(r.effects.filter((e) => e.key === 'model:0:0')).toEqual([expect.objectContaining({ status: 'completed' })]);
    // model:0:0 (the tool call) replayed from the log; only the answer was asked for.
    expect(r.modelCalls).toHaveLength(1);
    const last = r.modelCalls![0]!.at(-1)!;
    expect(last.role).toBe('tool');
    expect(JSON.stringify(last.content)).toContain('interrupted');
    expect(r.checkpoint.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
  }, 120_000);
});
