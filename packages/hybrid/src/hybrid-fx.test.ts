import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import {
  currentLane,
  type DriverOptions,
  deliver,
  durableSessions,
  type HandoffOutput,
  harnessOf,
  type HostTool,
  type Lane,
  QUEUE_PREFIX,
} from 'harness-world';
import { filesFromState } from 'harness-world-hands';
import { createFxEngine } from 'libfx';
import { afterEach, describe, expect, it } from 'vitest';
import {
  customerRecord,
  FakeSandboxProvider,
  HYBRID_FX_HARNESS,
  HYBRID_SYSTEM_PROMPT,
  hybridFxConfigHash,
  hybridFxHarness,
  hybridTools,
  LIBFX_VERSION,
  sandboxNameFor,
} from './index.ts';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/**
 * The fx twin of hybrid.test.ts: the real fx kernel (native libfx) against
 * a scripted AI Gateway, one session across every lane.
 */

const SECRET = 'test-crm-secret';

type Part = Record<string, unknown>;
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const sse = (parts: Part[]) =>
  new Response([...parts.map((p) => `data: ${JSON.stringify(p)}`), 'data: [DONE]', ''].join('\n\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
const toolCall = (id: string, name: string, input: unknown): Part[] => [
  { type: 'tool-call', toolCallId: id, toolName: name, input },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
];
const text = (t: string): Part[] => [
  { type: 'text-delta', delta: t },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

const hasJspi = typeof WebAssembly !== 'undefined' && 'Suspending' in WebAssembly;

describe('hybrid fx configuration', () => {
  it('pins LIBFX_VERSION to the installed libfx', async () => {
    let dir = dirname(createRequire(import.meta.url).resolve('libfx'));
    for (;;) {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8').catch(() => '{}'));
      if (pkg.name === 'libfx') return expect(pkg.version).toBe(LIBFX_VERSION);
      dir = dirname(dir);
    }
  });

  it('hashes the same in every lane, and differently for another model or prompt', async () => {
    const browser = await hybridFxConfigHash({ lane: 'browser' });
    const server = await hybridFxConfigHash({
      lane: 'sandbox',
      tools: hybridTools({ lane: 'sandbox', secrets: { crmSecret: SECRET }, sandbox: new FakeSandboxProvider() }),
    });
    expect(server).toBe(browser);
    expect(await hybridFxConfigHash({ lane: 'browser', model: 'anthropic/other' })).not.toBe(browser);
    const renamed = hybridTools({ lane: 'browser' }).map((t) => (t.name === 'bash' ? { ...t, description: 'changed' } : t));
    expect(await hybridFxConfigHash({ lane: 'browser', tools: renamed })).not.toBe(browser);
  });
});

describe('hybrid fx session', () => {
  it('hands a turn the tab cannot run to the function lane, which runs it', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-hybrid-fx-nojspi-')), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
    const gateway: typeof fetch = async (_url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json({ object: 'list', data: [] });
      return sse(text('hello from the server'));
    };
    let tabKernels = 0;
    const lanesFor = (serves: Lane) => ({ serves: [serves], settle: 'browser' as Lane, async wake(_r: string, to: Lane) { queue.push(to); } });
    const queue: Lane[] = [];
    const tab = hybridFxHarness({
      lane: 'browser',
      createFxEngine: (async () => {
        tabKernels++;
        throw new Error('fx WebAssembly requires JSPI (Chrome or Edge 137+)');
      }) as never,
      apiKey: 'test',
      fetch: gateway,
      cannotDrive: () => 'this browser has no WebAssembly JSPI',
      lanes: lanesFor('browser'),
    });
    const server = hybridFxHarness({ lane: 'function', createFxEngine: createFxEngine as never, apiKey: 'test', fetch: gateway, lanes: lanesFor('function') });
    const sessions = durableSessions({ world, harness: tab });
    const { sessionId } = await sessions.start({ harness: HYBRID_FX_HARNESS, prompt: 'say hello' });
    const drivers: Partial<Record<Lane, DriverOptions>> = { browser: { world, harness: tab }, function: { world, harness: server } };
    queue.push('browser');
    while (queue.length) await deliver(drivers[queue.shift()!]!, sessionId);
    const state = await sessions.inspect(sessionId);
    expect(tabKernels).toBe(0);
    expect(currentLane(state)).toBe('browser');
    const handoffs = state.effectOrder.filter((e) => e.name === 'handoff').map((e) => e.output as HandoffOutput);
    expect(handoffs.map((h) => [h.from, h.to])).toEqual([['browser', 'function'], ['function', 'browser']]);
    expect(handoffs[0]!.reason).toContain('no WebAssembly JSPI');
    expect((state.effects.get('model:0:0')!.output as { text: string }).text).toBe('hello from the server');
    expect(state.submissions.every((s) => state.placed.has(s.id))).toBe(true);
    // Idle in the tab again: nothing more to hand off.
    await deliver(drivers.browser!, sessionId);
    expect((await sessions.inspect(sessionId)).effectOrder.filter((e) => e.name === 'handoff')).toHaveLength(2);
  });

  it('runs one fx session across browser, function, and sandbox lanes on one log', () => crossLanes({}));

  // The tab runs libfx's Wasm build and the server its native addon; the
  // session moves between them mid-turn. Node needs JSPI for the Wasm build
  // (Node 25, or 24 with --experimental-wasm-jspi on the command line).
  it.runIf(hasJspi)('moves between the Wasm kernel (browser lane) and the native one (server lanes)', () =>
    crossLanes({ backend: 'wasm' })
  );
});

async function crossLanes(browserAgentOptions: Record<string, unknown>) {
  {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-hybrid-fx-')), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));

    // AI Gateway, shared by every lane. Each request gets the next reply.
    let lane: Lane = 'browser';
    const requests: { lane: Lane; body: any; model: string | null }[] = [];
    const script: ((body: any) => Part[])[] = [
      // Turn 1, in the browser: a file.
      () => toolCall('c1', 'write_file', { path: 'notes.txt', content: 'hello from the browser\n' }),
      () => text('Saved notes.txt.'),
      // Turn 2: a backend-only tool, decided in the browser...
      () => toolCall('c2', 'lookup_customer', { query: 'cus_42' }),
      // ...finished in the function lane.
      () => text('cus_42 is on the plan shown.'),
      // Turn 3: a real machine, decided in the browser, run in the sandbox.
      () => toolCall('c3', 'run_on_machine', { command: 'wc -l < notes.txt > count.txt && cat notes.txt' }),
      () => text('notes.txt has 1 line; see count.txt.'),
      // Turn 4, back in the browser: memory of all of it.
      () => text('I remember everything.'),
    ];
    const gateway: typeof fetch = async (_url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json({ object: 'list', data: [] });
      const body = JSON.parse(String(init?.body));
      requests.push({ lane, body, model: new Headers(init?.headers).get('ai-language-model-id') });
      const next = script.shift();
      if (!next) throw new Error('unexpected model request');
      return sse(next(body));
    };

    const sandbox = new FakeSandboxProvider();
    const harnessFor = (tools: HostTool[], agentOptions: Record<string, unknown> = {}) =>
      hybridFxHarness({ lane: 'browser', createFxEngine: createFxEngine as never, apiKey: 'test', fetch: gateway, tools, agentOptions });
    const harnesses: Record<Lane, ReturnType<typeof harnessFor>> = {
      browser: harnessFor(hybridTools({ lane: 'browser', isolation: 'process' }), browserAgentOptions),
      function: harnessFor(hybridTools({ lane: 'function', secrets: { crmSecret: SECRET }, isolation: 'process' })),
      sandbox: harnessFor(hybridTools({ lane: 'sandbox', secrets: { crmSecret: SECRET }, sandbox, isolation: 'process' })),
    };

    const wakes: HandoffOutput[] = [];
    const queue: Lane[] = [];
    const logs: string[] = [];
    const drivers = Object.fromEntries(
      (['browser', 'function', 'sandbox'] as Lane[]).map((serves): [Lane, DriverOptions] => [
        serves,
        {
          world: world!,
          harness: harnesses[serves],
          lanes: {
            serves: [serves],
            settle: 'browser',
            async wake(_runId, to, handoff) {
              wakes.push(handoff);
              queue.push(to);
            },
          },
          log: (m) => logs.push(m),
        },
      ])
    ) as Record<Lane, DriverOptions>;
    const drive = async (runId: string) => {
      queue.push('browser');
      while (queue.length > 0) {
        lane = queue.shift()!;
        await deliver(drivers[lane], runId);
      }
    };

    const sessions = durableSessions({ world, harness: harnesses.browser });
    const { sessionId } = await sessions.start({ harness: HYBRID_FX_HARNESS, prompt: 'save a note' });

    // Turn 1: entirely in the browser.
    await drive(sessionId);
    let state = await sessions.inspect(sessionId);
    expect(harnessOf(state.workflowName)).toBe(HYBRID_FX_HARNESS);
    expect(currentLane(state)).toBe('browser');
    expect(filesFromState(state)).toEqual({ '/workspace/notes.txt': 'hello from the browser\n' });
    expect(wakes).toEqual([]);

    // Turn 2: lookup_customer escalates mid-turn to the function lane and settles back.
    await sessions.send(sessionId, 'who is customer cus_42?');
    await drive(sessionId);
    state = await sessions.inspect(sessionId);
    expect(currentLane(state)).toBe('browser');
    expect(wakes.map((w) => [w.from, w.to])).toEqual([
      ['browser', 'function'],
      ['function', 'browser'],
    ]);
    const lookup = state.effectOrder.find((e) => e.name === 'tool.lookup_customer')!;
    expect(lookup.status).toBe('completed');
    expect(String(lookup.output)).toContain('server-side (function lane)');
    const record = await customerRecord(SECRET, 'cus_42');
    expect(String(lookup.output)).toContain(record.name);

    // Turn 3: run_on_machine escalates to the sandbox, which sees the
    // browser's file; the file it writes comes back into the log.
    await sessions.send(sessionId, 'count the lines in notes.txt on a real machine');
    await drive(sessionId);
    state = await sessions.inspect(sessionId);
    expect(currentLane(state)).toBe('browser');
    expect(wakes.slice(2).map((w) => [w.from, w.to])).toEqual([
      ['browser', 'sandbox'],
      ['sandbox', 'browser'],
    ]);
    expect(sandbox.commands).toEqual([
      { sandbox: sandboxNameFor(sessionId), command: 'wc -l < notes.txt > count.txt && cat notes.txt' },
    ]);
    const exec = String(state.effectOrder.find((e) => e.name === 'tool.run_on_machine')!.output);
    expect(exec).toContain('exit code: 0');
    expect(exec).toContain('hello from the browser');
    expect(exec).toContain('workspace files updated from the sandbox: /workspace/count.txt');

    // Turn 4: back in the browser, which restores the sandbox lane's checkpoint.
    await sessions.send(sessionId, 'without tools: what have we done?');
    await drive(sessionId);
    state = await sessions.inspect(sessionId);

    // One run, one log, a handoff at each move, a checkpoint per turn.
    expect(state.runId).toBe(sessionId);
    expect(state.effectOrder.map((e) => e.name)).toEqual([
      'turn', 'model', 'tool.write_file', 'model', 'checkpoint',
      'turn', 'model', 'handoff', 'tool.lookup_customer', 'model', 'checkpoint', 'handoff',
      'turn', 'model', 'handoff', 'tool.run_on_machine', 'model', 'checkpoint', 'handoff',
      'turn', 'model', 'checkpoint',
    ]);
    expect(state.effectOrder.every((e) => e.status === 'completed')).toBe(true);
    expect(state.submissions.every((s) => state.placed.has(s.id))).toBe(true);
    expect(filesFromState(state)).toEqual({
      '/workspace/notes.txt': 'hello from the browser\n',
      '/workspace/count.txt': expect.stringMatching(/^\s*1\s*$/),
    });
    const lanes = ['browser', ...state.effectOrder.filter((e) => e.name === 'handoff').map((e) => (e.output as HandoffOutput).to)];
    expect(lanes).toEqual(['browser', 'function', 'browser', 'sandbox', 'browser']);

    // No divergence anywhere: each model call ran once, in the lane that
    // held the session; an escalated turn replayed the response that asked
    // for the tool from the tape instead of calling the model again.
    expect(logs.filter((m) => m.includes('restart'))).toEqual([]);
    expect(requests.map((r) => r.lane)).toEqual(['browser', 'browser', 'browser', 'function', 'browser', 'sandbox', 'browser']);
    // Every lane built the same system prompt, tool list, and model: the
    // parts of the request the tape relies on.
    const shape = (b: any) => JSON.stringify({ system: b.prompt[0], tools: b.tools });
    expect(new Set(requests.map((r) => shape(r.body))).size).toBe(1);
    expect(requests[0]!.body.prompt[0].content).toContain(HYBRID_SYSTEM_PROMPT.slice(0, 60));
    expect(new Set(requests.map((r) => r.model))).toEqual(new Set(['anthropic/claude-opus-5.5-fast']));

    // One continuous fx history: each lane's request saw everything before it.
    const said = (i: number) => JSON.stringify(requests[i]!.body.prompt);
    expect(said(3)).toContain('save a note');
    expect(said(3)).toContain('hello from the browser');
    expect(said(3)).toContain(record.name);
    expect(said(5)).toContain('cus_42 is on the plan shown.');
    expect(said(6)).toContain('Saved notes.txt.');
    expect(said(6)).toContain(record.name);
    expect(said(6)).toContain('count.txt');
  }
}
