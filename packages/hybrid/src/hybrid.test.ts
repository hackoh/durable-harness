import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Context, createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
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
import { afterEach, describe, expect, it } from 'vitest';
import {
  customerRecord,
  FakeSandboxProvider,
  HYBRID_HARNESS,
  HYBRID_SYSTEM_PROMPT,
  hybridHandsOf,
  hybridHarness,
  hybridSystemPrompt,
  hybridTools,
  sandboxNameFor,
  syncIn,
  syncOut,
} from './index.ts';

const SECRET = 'test-crm-secret';

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

/** Everything a message says, flattened, for "did the model see X" checks. */
const textOf = (context: Context) => JSON.stringify(context.messages);

describe('hybrid session', () => {
  it('runs one session across browser, function, and sandbox lanes on one log', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-hybrid-')), recoverActiveRuns: false });
    // sessions.send() also wakes the default queue; this test plays every
    // lane's delivery by hand, so swallow those.
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));

    // The model, shared by every lane like AI Gateway would be.
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const streamFn = models.streamSimple.bind(models);

    let lane: Lane = 'browser';
    const modelLanes: Lane[] = [];
    const seen: Record<string, string> = {};
    const respond =
      (tag: string, reply: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
        modelLanes.push(lane);
        seen[tag] = textOf(context);
        return reply;
      };
    faux.setResponses([
      // Turn 1, in the browser: a file.
      respond('t1a', fauxAssistantMessage(fauxToolCall('write_file', { path: 'notes.txt', content: 'hello from the browser\n' }), { stopReason: 'toolUse' })),
      respond('t1b', fauxAssistantMessage(fauxText('Saved notes.txt.'))),
      // Turn 2: a backend-only tool. The call is decided in the browser...
      respond('t2a', fauxAssistantMessage(fauxToolCall('lookup_customer', { query: 'cus_42' }), { stopReason: 'toolUse' })),
      // ...and the turn finishes in the function lane.
      respond('t2b', fauxAssistantMessage(fauxText('cus_42 is on the plan shown.'))),
      // Turn 3: a real system. Decided in the browser, run in the sandbox.
      respond(
        't3a',
        fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'wc -l < notes.txt > count.txt && cat notes.txt' }), {
          stopReason: 'toolUse',
        })
      ),
      respond('t3b', fauxAssistantMessage(fauxText('notes.txt has 1 line; see count.txt.'))),
    ]);

    const sandbox = new FakeSandboxProvider();
    const harnessFor = (tools: HostTool[]) => hybridHarness({ lane: 'browser', model, streamFn, tools });
    const browserHarness = harnessFor(hybridTools({ lane: 'browser', isolation: 'process' }));
    const functionHarness = harnessFor(hybridTools({ lane: 'function', secrets: { crmSecret: SECRET }, isolation: 'process' }));
    const sandboxHarness = harnessFor(hybridTools({ lane: 'sandbox', secrets: { crmSecret: SECRET }, sandbox, isolation: 'process' }));

    // Each lane's wake lands in one queue that the test pumps, standing in
    // for the tab's log watcher (browser) and the server queue (the rest).
    const wakes: { to: Lane; handoff: HandoffOutput }[] = [];
    const queue: Lane[] = [];
    const driver = (serves: Lane, harness: typeof browserHarness): DriverOptions => ({
      world: world!,
      harness,
      lanes: {
        serves: [serves],
        settle: 'browser',
        async wake(_runId, to, handoff) {
          wakes.push({ to, handoff });
          queue.push(to);
        },
      },
    });
    const drivers: Record<Lane, DriverOptions> = {
      browser: driver('browser', browserHarness),
      function: driver('function', functionHarness),
      sandbox: driver('sandbox', sandboxHarness),
    };
    const drive = async (runId: string, first: Lane = 'browser') => {
      queue.push(first);
      while (queue.length > 0) {
        lane = queue.shift()!;
        await deliver(drivers[lane], runId);
      }
    };

    const sessions = durableSessions({ world, harness: browserHarness });
    const { sessionId } = await sessions.start({ harness: HYBRID_HARNESS, prompt: 'save a note' });

    // Turn 1: entirely in the browser, no handoff.
    await drive(sessionId);
    let state = await sessions.inspect(sessionId);
    expect(harnessOf(state.workflowName)).toBe(HYBRID_HARNESS);
    expect(currentLane(state)).toBe('browser');
    expect(filesFromState(state)).toEqual({ '/workspace/notes.txt': 'hello from the browser\n' });
    expect(wakes).toEqual([]);

    // Turn 2: lookup_customer escalates browser -> function, runs there, settles back.
    await sessions.send(sessionId, 'who is customer cus_42?');
    await drive(sessionId);
    state = await sessions.inspect(sessionId);
    expect(currentLane(state)).toBe('browser');
    expect(wakes.map((w) => [w.handoff.from, w.to])).toEqual([
      ['browser', 'function'],
      ['function', 'browser'],
    ]);
    const lookup = state.effectOrder.find((e) => e.name === 'tool.lookup_customer')!;
    expect(lookup.status).toBe('completed');
    expect(lookup.output).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('server-side (function lane)') }] });
    const record = await customerRecord(SECRET, 'cus_42');
    expect(JSON.stringify(lookup.output)).toContain(record.name);

    // Turn 3: run_on_machine escalates browser -> sandbox. The sandbox sees the
    // browser's file, and the file it creates comes back into the log.
    await sessions.send(sessionId, 'count the lines in notes.txt on a real machine');
    await drive(sessionId);
    state = await sessions.inspect(sessionId);
    expect(currentLane(state)).toBe('browser');
    expect(wakes.slice(2).map((w) => [w.handoff.from, w.to])).toEqual([
      ['browser', 'sandbox'],
      ['sandbox', 'browser'],
    ]);
    expect(sandbox.commands).toEqual([
      { sandbox: sandboxNameFor(sessionId), command: 'wc -l < notes.txt > count.txt && cat notes.txt' },
    ]);
    const exec = state.effectOrder.find((e) => e.name === 'tool.run_on_machine')!;
    const execText = JSON.stringify(exec.output);
    expect(execText).toContain('exit code: 0');
    expect(execText).toContain('hello from the browser');
    expect(execText).toContain('workspace files updated from the sandbox: /workspace/count.txt');
    expect(filesFromState(state)).toEqual({
      '/workspace/notes.txt': 'hello from the browser\n',
      '/workspace/count.txt': expect.stringMatching(/^\s*1\s*$/),
    });

    // One run, one log: every lane's work is in it, with a handoff at each move.
    expect(state.runId).toBe(sessionId);
    // A tool's files ride on its own outcome (the virtual workspace's
    // manifest), and the machine command runs attached: no fs, park or
    // settle steps.
    expect(state.effectOrder.map((e) => e.name)).toEqual([
      'model',
      'tool.write_file',
      'model',
      'model',
      'handoff',
      'tool.lookup_customer',
      'model',
      'handoff',
      'model',
      'handoff',
      'tool.run_on_machine',
      'model',
      'handoff',
    ]);
    expect(exec.docs?.map((d) => d.kind)).toEqual(['hw.workspace']);
    expect(state.effectOrder.every((e) => e.status === 'completed')).toBe(true);
    expect(state.submissions.every((s) => state.placed.has(s.id))).toBe(true);

    // Each model call ran once, in the lane that held the session then; an
    // escalation replays the model step that asked for the tool from the log
    // instead of calling the model again.
    expect(faux.state.callCount).toBe(6);
    expect(modelLanes).toEqual(['browser', 'browser', 'browser', 'function', 'browser', 'sandbox']);

    // One continuous Pi transcript: the function and sandbox lanes' model
    // calls saw everything the browser lane did before them.
    expect(seen.t2b).toContain('save a note');
    expect(seen.t2b).toContain('wrote 23 bytes to /workspace/notes.txt');
    expect(seen.t2b).toContain('who is customer cus_42?');
    expect(seen.t2b).toContain(record.name);
    expect(seen.t3a).toContain('cus_42 is on the plan shown.');
    expect(seen.t3b).toContain('save a note');
    expect(seen.t3b).toContain('Saved notes.txt.');
    expect(seen.t3b).toContain('hello from the browser');
  });

  it('moves function -> sandbox inside one server turn when the server serves both lanes', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-hybrid-')), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let lastContext = '';
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('lookup_customer', { query: 'globex' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'echo "$(cat customer.txt 2>/dev/null || echo none)"' }), {
        stopReason: 'toolUse',
      }),
      (context) => {
        lastContext = textOf(context);
        return fauxAssistantMessage(fauxText('done'));
      },
    ]);
    const common = { model: faux.getModel(), streamFn: models.streamSimple.bind(models) };
    const sandbox = new FakeSandboxProvider();
    const queue: Lane[] = [];
    const wake = async (_: string, to: Lane) => void queue.push(to);
    // The tab, and one server route that drives both server lanes (the demo's shape).
    const tab: DriverOptions = {
      world,
      harness: hybridHarness({ ...common, lane: 'browser', tools: hybridTools({ lane: 'browser', isolation: 'process' }) }),
      lanes: { serves: ['browser'], settle: 'browser', wake },
    };
    const server: DriverOptions = {
      world,
      harness: hybridHarness({ ...common, lane: 'sandbox', tools: hybridTools({ lane: 'sandbox', secrets: { crmSecret: SECRET }, sandbox, isolation: 'process' }) }),
      lanes: { serves: ['function', 'sandbox'], settle: 'browser', wake },
    };
    const sessions = durableSessions({ world, harness: tab.harness });
    const { sessionId } = await sessions.start({ prompt: 'look up globex, then check the sandbox' });
    queue.push('browser');
    while (queue.length) await deliver(queue.shift() === 'browser' ? tab : server, sessionId);

    const state = await sessions.inspect(sessionId);
    const handoffs = state.effectOrder
      .filter((e) => e.name === 'handoff')
      .map((e) => [(e.output as HandoffOutput).from, (e.output as HandoffOutput).to]);
    expect(handoffs).toEqual([
      ['browser', 'function'],
      ['function', 'sandbox'],
      ['sandbox', 'browser'],
    ]);
    expect(currentLane(state)).toBe('browser');
    expect(state.effectOrder.find((e) => e.name === 'tool.lookup_customer')?.status).toBe('completed');
    expect(state.effectOrder.find((e) => e.name === 'tool.run_on_machine')?.status).toBe('completed');
    expect(lastContext).toContain((await customerRecord(SECRET, 'globex')).name);
    expect(faux.state.callCount).toBe(3);
  });

  it('advertises the same tools in every lane', () => {
    const shape = (tools: HostTool[]) =>
      tools.map(({ name, description, inputSchema, replay, requires, needs }) => ({ name, description, inputSchema, replay, requires, needs }));
    const browser = shape(hybridTools({ lane: 'browser' }));
    expect(shape(hybridTools({ lane: 'function', secrets: { crmSecret: 'x' } }))).toEqual(browser);
    expect(shape(hybridTools({ lane: 'sandbox', sandbox: new FakeSandboxProvider() }))).toEqual(browser);
    expect(browser.map((t) => [t.name, t.requires, t.needs])).toEqual([
      ['bash', undefined, undefined],
      ['read_file', undefined, undefined],
      ['write_file', undefined, undefined],
      ['edit_file', undefined, undefined],
      ['list_files', undefined, undefined],
      ['unsafe_send_email', 'function', ['secrets']],
      ['unsafe_make_payment', 'function', ['secrets']],
      ['lookup_customer', 'function', ['secrets']],
      ['run_on_machine', 'sandbox', ['machine']],
    ]);
  });

  it("gives each session the tools and the system prompt of the hands its run_created recorded", async () => {
    const names = (hands?: 'none' | 'virtual' | 'ephemeral' | 'machine') => hybridTools({ lane: 'browser', ...(hands ? { hands } : {}) }).map((t) => t.name);
    const workspace = ['bash', 'read_file', 'write_file', 'edit_file', 'list_files'];
    const backend = ['unsafe_send_email', 'unsafe_make_payment', 'lookup_customer'];
    expect(names()).toEqual([...workspace, ...backend, 'run_on_machine']);
    expect(names('machine')).toEqual(names());
    expect(names('virtual')).toEqual([...workspace, ...backend]);
    expect(names('ephemeral')).toEqual([...workspace, ...backend]);
    expect(names('none')).toEqual(backend);
    // The shell names run_on_machine only next to it; an in-memory workspace says its files don't last.
    const bash = (hands: 'virtual' | 'ephemeral' | 'machine') => hybridTools({ lane: 'browser', hands }).find((t) => t.name === 'bash')!.description;
    expect(bash('machine')).toContain('run_on_machine');
    expect(bash('virtual')).not.toContain('run_on_machine');
    expect(bash('ephemeral')).toMatch(/until the end of this turn/);
    // A session from before the hands axis (no config.hands) replays with the prompt it had.
    expect(hybridSystemPrompt()).toBe(HYBRID_SYSTEM_PROMPT);
    expect(hybridSystemPrompt('machine')).toBe(HYBRID_SYSTEM_PROMPT);
    for (const hands of ['none', 'virtual', 'ephemeral'] as const) expect(hybridSystemPrompt(hands)).not.toContain('run_on_machine');
    expect(hybridHandsOf({ config: { hands: 'none' } })).toBe('none');
    expect(hybridHandsOf({ config: { home: 'browser' } })).toBe('machine');
    expect(hybridHandsOf({ config: { hands: 'sandbox' } })).toBe('machine');

    // Driven: each session's model sees its own hands' tools, from one harness.
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-hybrid-')), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    // The provider's request (its system messages carry the prompt and the tool declarations).
    const seen: string[] = [];
    const reply = (context: Context) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxText('ok'));
    };
    faux.setResponses([reply, reply]);
    const harness = hybridHarness({ model: faux.getModel(), streamFn: models.streamSimple.bind(models), lane: 'browser', tools: (hands) => hybridTools({ lane: 'browser', hands, isolation: 'process' }) });
    const opts: DriverOptions = { world, harness, lanes: { serves: ['browser'], settle: 'browser', wake: async () => {} } };
    const sessions = durableSessions({ world, harness });
    const none = await sessions.start({ prompt: 'hi', config: { hands: 'none' } });
    await deliver(opts, none.sessionId);
    const legacy = await sessions.start({ prompt: 'hi' });
    await deliver(opts, legacy.sessionId);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('There is no workspace in this session');
    expect(seen[0]).toContain('"lookup_customer"');
    expect(seen[0]).not.toContain('"write_file"');
    expect(seen[0]).not.toContain('"run_on_machine"');
    expect(seen[1]).toContain('"write_file"');
    expect(seen[1]).toContain('"run_on_machine"');
    expect(seen[1]).not.toContain('There is no workspace in this session');
  });

  it('refuses to run backend tools in the browser even if called directly', async () => {
    const tools = hybridTools({ lane: 'browser' });
    const io = { signal: new AbortController().signal, progress() {}, ctx: { lane: 'browser' } as never };
    await expect(tools.find((t) => t.name === 'lookup_customer')!.execute({ query: 'x' }, io)).rejects.toThrow(/browser/);
    await expect(tools.find((t) => t.name === 'run_on_machine')!.execute({ command: 'ls' }, io)).rejects.toThrow(/browser lane/);
    // A function lane without a provider says so, before anything runs.
    const server = hybridTools({ lane: 'function' });
    await expect(server.find((t) => t.name === 'run_on_machine')!.execute({ command: 'ls' }, { ...io, ctx: { lane: 'function' } as never })).rejects.toThrow(/no sandbox provider/);
  });
});

describe('sandbox sync', () => {
  it('writes only changed files, removes what the log deleted, and leaves untracked files alone', async () => {
    const provider = new FakeSandboxProvider();
    const sbx = await provider.open('wrun_ABC');
    expect(sbx.name).toBe('hybrid-wrun-abc');
    await sbx.writeFiles([
      { path: '/workspace/same.txt', content: 'same' },
      { path: '/workspace/stale.txt', content: 'old' },
      { path: '/workspace/gone.txt', content: 'bye' },
      { path: '/workspace/build.log', content: 'untracked' },
      { path: '/workspace/node_modules/x/index.js', content: 'dep' },
    ]);
    const fold = new Map([
      ['/workspace/same.txt', 'same'],
      ['/workspace/stale.txt', 'new'],
      ['/workspace/fresh.txt', 'fresh'],
    ]);
    const tracked = new Set([...fold.keys(), '/workspace/gone.txt']);
    const synced = await syncIn(sbx, '/workspace', fold, tracked);
    expect(synced.written.sort()).toEqual(['/workspace/fresh.txt', '/workspace/stale.txt']);
    expect(synced.removed).toEqual(['/workspace/gone.txt']);
    expect(await sbx.readTextFile('/workspace/build.log')).toBe('untracked');

    await sbx.exec('echo more >> same.txt && rm fresh.txt && echo x > node_modules/x/index.js', { cwd: '/workspace' });
    const back = await syncOut(sbx, '/workspace', synced.baseline);
    expect(back.files).toEqual({ '/workspace/same.txt': 'samemore\n', '/workspace/fresh.txt': null });
  });
});
