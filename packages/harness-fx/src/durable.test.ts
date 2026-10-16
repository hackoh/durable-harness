import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { durableSessions, pendingSubmissions, QUEUE_PREFIX } from 'harness-world';
import { createFxEngine } from 'libfx';
import { afterEach, describe, expect, it } from 'vitest';
import { createDurableFxAgent, type DurableFxEvent, type FxTool, fxHarness } from './index.ts';

type Part = Record<string, unknown>;
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const sse = (parts: Part[]) =>
  new Response([...parts.map((p) => `data: ${JSON.stringify(p)}`), 'data: [DONE]', ''].join('\n\n'), {
    headers: { 'content-type': 'text/event-stream' },
  });
const toolCall = (id: string, name: string, input: unknown): Part[] => [
  { type: 'tool-call', toolCallId: id, toolName: name, input },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
];
const text = (...deltas: string[]): Part[] => [
  ...deltas.map((delta) => ({ type: 'text-delta', delta })),
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];
function fakeGateway(script: ((body: any) => Part[])[]) {
  const requests: any[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ object: 'list', data: [] });
    requests.push(JSON.parse(String(init?.body)));
    const next = script.shift();
    if (!next) throw new Error('unexpected model request');
    return sse(next(requests.at(-1)));
  };
  return { fetch: fetchImpl, requests };
}
const shout = (onRun: () => Promise<void> = async () => {}): FxTool => ({
  name: 'shout',
  description: 'Uppercase some text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  replay: 'never',
  async execute(input: { text: string }) {
    await onRun();
    return input.text.toUpperCase();
  },
});
const harness = (gateway: ReturnType<typeof fakeGateway>, tools: FxTool[]) =>
  fxHarness({ createFxEngine: createFxEngine as never, apiKey: 'test', model: 'test/model', tools, fetch: gateway.fetch });

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function collect(turn: AsyncIterable<DurableFxEvent>) {
  const events: DurableFxEvent[] = [];
  for await (const e of turn) events.push(e);
  return events;
}

describe('createDurableFxAgent', () => {
  it('reads like libfx: prompt, stream the turn, await its result, reattach by session id', async () => {
    const gateway = fakeGateway([
      () => toolCall('c1', 'shout', { text: 'hi' }),
      () => text('I shouted ', 'HI.'),
      () => text('We talked about shouting.'),
    ]);
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-dfx-')), recoverActiveRuns: false });
    worlds.push(world);
    const sessions = durableSessions({ world, harness: harness(gateway, [shout()]) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);

    const agent = await createDurableFxAgent({ sessions, pollMs: 50 });
    const turn = agent.prompt('shout hi');
    const events = await collect(turn);
    expect(await turn.result).toMatchObject({ stopReason: expect.any(String) });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta).join('')).toBe('I shouted HI.');
    expect(events.map((e) => e.type)).toContain('tool_start');
    await agent.close();

    // Another handle on the same session: sees only its own turn, and the kernel remembers.
    const again = await createDurableFxAgent({ sessions, sessionId: agent.sessionId, pollMs: 50 });
    const second = again.prompt('what did we talk about?');
    const secondText = (await collect(second))
      .flatMap((e) => (e.type === 'text_delta' ? [e.delta] : []))
      .join('');
    await second.result;
    expect(secondText).toBe('We talked about shouting.');
    expect(gateway.requests).toHaveLength(3);
    // Reattaching to a turn that already finished ends at once with its result.
    const late = again.turn(await second.submissionId);
    await late.result;
    expect(await collect(late)).toEqual([]);
    await again.close();
  });

  it('commits a steer sent right after prompt() after that prompt', async () => {
    // Before the fix the steer, sent at once, beat the prompt (which reads
    // the live stream's end first) and ran as a turn of its own, ahead of it.
    const gateway = fakeGateway([() => text('Short facts.'), () => text('Kept short.')]);
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-dfx-')), recoverActiveRuns: false });
    worlds.push(world);
    const sessions = durableSessions({ world, harness: harness(gateway, []) });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const agent = await createDurableFxAgent({ sessions, pollMs: 50 });
    const turn = agent.prompt('write three facts');
    await turn.steer('keep them short');
    const streamed = (await collect(turn)).flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('');
    expect(await turn.result).toMatchObject({ stopReason: expect.any(String) });
    // The steer joins this turn (in its first request, or the one after), or
    // becomes the next one if this turn ended first; never the one before.
    expect(['Short facts.', 'Short facts.Kept short.']).toContain(streamed);
    expect(JSON.stringify(gateway.requests[0])).toContain('write three facts');
    for (;;) {
      const state = await sessions.inspect(agent.sessionId);
      const turns = state.effectOrder.filter((e) => e.name === 'turn').length;
      const checkpoints = state.effectOrder.filter((e) => e.name === 'checkpoint' && e.status === 'completed').length;
      if (pendingSubmissions(state).length === 0 && turns === checkpoints) {
        expect(state.submissions.map((s) => s.kind)).toEqual(['prompt', 'steer']);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(gateway.requests.some((r) => JSON.stringify(r).includes('keep them short'))).toBe(true);
    await agent.close();
  });

  it('resolves result from the log even when nobody iterated the turn, and across a crash', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hw-dfx-'));
    const worldA = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(worldA);
    const a = durableSessions({
      world: worldA,
      harness: harness(fakeGateway([() => toolCall('c1', 'shout', { text: 'hi' })]), [shout(() => new Promise(() => {}))]),
    });
    worldA.registerHandler(QUEUE_PREFIX, a.handler);
    const agent = await createDurableFxAgent({ sessions: a, pollMs: 50 });
    const turn = agent.prompt('shout hi');
    await turn.submissionId;
    // Let the tool hang, then "crash" this process.
    await new Promise((r) => setTimeout(r, 1500));
    await worldA.close?.();

    const worldB = createWorld({ dataDir, recoverActiveRuns: true });
    worlds.push(worldB);
    const b = durableSessions({
      world: worldB,
      harness: harness(fakeGateway([() => text('The shout was interrupted.')]), [shout()]),
    });
    worldB.registerHandler(QUEUE_PREFIX, b.handler);
    await worldB.start?.();
    // A new handle in the "new process" reattaches to the same turn by its submission.
    const reopened = await createDurableFxAgent({ sessions: b, sessionId: agent.sessionId, pollMs: 50 });
    const outcome = await reopened.turn(await turn.submissionId).result;
    expect(outcome.stopReason).toBeTruthy();
    await agent.close();
    await reopened.close();
  });

  it('ends the turn with an error result when the model call fails', async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-dfx-')), recoverActiveRuns: false });
    worlds.push(world);
    const failing: typeof fetch = async (_u, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? Response.json({ object: 'list', data: [] })
        : new Response(JSON.stringify({ error: { message: 'Authentication failed', type: 'authentication_error' } }), { status: 401 });
    const sessions = durableSessions({
      world,
      harness: fxHarness({ createFxEngine: createFxEngine as never, apiKey: 'bad', model: 'test/model', tools: [], fetch: failing }),
    });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    const agent = await createDurableFxAgent({ sessions, pollMs: 50 });
    const turn = agent.prompt('hello');
    await collect(turn);
    expect(await turn.result).toMatchObject({ stopReason: 'error', error: expect.any(String) });
    await agent.close();
  });

  it('withdraws a prompt that has not started', async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-dfx-')), recoverActiveRuns: false });
    worlds.push(world);
    const sessions = durableSessions({ world, harness: harness(fakeGateway([]), []) });
    // No handler registered: nothing drives the session, so the prompt stays queued.
    const agent = await createDurableFxAgent({ sessions, pollMs: 50 });
    const turn = agent.prompt('never mind');
    expect(await turn.cancel()).toBe('withdrawn');
    expect(await turn.result).toEqual({ stopReason: 'withdrawn' });
  });
});
