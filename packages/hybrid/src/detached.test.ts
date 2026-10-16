import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { currentLane, deliver, type EffectRecord, type SessionState } from 'harness-world';
import { filesFromState } from 'harness-world-hands';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hybridHarness } from './harness.ts';
import { sandboxNameFor, SYNC_LIMITS } from './sandbox-sync.ts';
import { hostProcess, hybridSetup, type HybridSetup, laneOptions, sleep, textOf, until } from './testing.ts';
import { commandSeconds, hybridTools } from './tools.ts';

/**
 * `run_on_machine`, attached: the call syncs the session's virtual
 * workspace (`virtual({ durable: true })`, the `hw.workspace` manifest)
 * into its own VM, runs the command, waits for it, and syncs what it
 * changed back, inside the call. The files ride on the call's own outcome
 * (`io.docs`): no `fs`, `park` or `settle` steps. (Ported from the detached
 * `sandbox_exec`, whose tests these replace.)
 */

let setup: HybridSetup | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await setup?.world.close?.();
  setup = undefined;
});

const execOf = (state: SessionState) => state.effectOrder.filter((e) => e.name === 'tool.run_on_machine');
const textOfRecord = (e: EffectRecord | undefined) => JSON.stringify(e?.output ?? e?.error ?? null);

/** A command on the machine, then a text answer. */
function machineTurn(command: string, answer = 'done', extra: Record<string, unknown> = {}) {
  return [
    fauxAssistantMessage(fauxToolCall('run_on_machine', { command, ...extra }), { stopReason: 'toolUse' as const }),
    fauxAssistantMessage(fauxText(answer)),
  ];
}

describe('run_on_machine', () => {
  it('settles the files it brings back with its outcome: one step, its manifest edit on it, no fs, park or settle', async () => {
    setup = await hybridSetup([
      fauxAssistantMessage(fauxToolCall('write_file', { path: 'a.txt', content: 'one\n' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'cat a.txt && echo two > b.txt' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('ok')),
    ]);
    await setup.sessions.send(setup.sessionId, 'go');
    await setup.drive();
    const state = await setup.inspect();
    const [exec] = execOf(state);
    expect(exec).toMatchObject({ status: 'completed' });
    const text = textOfRecord(exec);
    expect(text).toContain('exit code: 0');
    expect(text).toContain('one');
    expect(text).toContain('workspace files updated from the sandbox: /workspace/b.txt');
    // The manifest edit rode on the call's own step_completed.
    expect(exec!.docs?.map((d) => d.kind)).toEqual(['hw.workspace']);
    expect(state.effectOrder.map((e) => e.name).filter((n) => ['fs', 'park', 'settle', 'detach'].includes(n))).toEqual([]);
    expect(filesFromState(state)).toEqual({ '/workspace/a.txt': 'one\n', '/workspace/b.txt': 'two\n' });
    expect(setup.sandbox.commands).toEqual([{ sandbox: sandboxNameFor(setup.sessionId), command: 'cat a.txt && echo two > b.txt' }]);
    expect(currentLane(state)).toBe('browser');
  });

  it('a call whose outcome never landed brought nothing back: its retry runs from the log and its files land once', async () => {
    setup = await hybridSetup([
      fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'echo made > made.txt' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('ok')),
    ]);
    const { sessions, sessionId, sandbox, server } = setup;
    await sessions.send(sessionId, 'go');
    await deliver({ world: setup.world, harness: hybridHarness({ ...setup.pi, lane: 'browser', tools: hybridTools({ lane: 'browser', isolation: 'process' }) }), lanes: laneOptions(['browser'], []) }, sessionId);
    expect(currentLane(await sessions.inspect(sessionId))).toBe('sandbox');
    // The function dies the moment it writes the call's outcome: the command
    // ran and its file came back into the call's workspace, but nothing landed.
    const fn = hostProcess(setup.world, (r) => r?.eventType === 'step_completed' && !!r.eventData?.stepName?.endsWith('//tool.run_on_machine'));
    void deliver({ ...server, world: fn.world }, sessionId, { anchor: { k: 'msg', m: 'msg_first' } });
    await until(async () => (fn.dead ? true : undefined));
    let state = await sessions.inspect(sessionId);
    expect(execOf(state)[0]).toMatchObject({ status: 'running' });
    expect(filesFromState(state)['/workspace/made.txt']).toBeUndefined();
    // The queue redelivers the same message: the intent is released and retried at once.
    for (let i = 0; i < 30; i++) {
      if (!(await deliver(server, sessionId, { anchor: { k: 'msg', m: 'msg_first' }, attempt: 2 + i }))) break;
      await sleep(100);
    }
    await setup.deliverQueued();
    state = await sessions.inspect(sessionId);
    const [retried] = execOf(state);
    expect(retried).toMatchObject({ status: 'completed' });
    expect(retried!.retryOf).toBeDefined();
    expect(sandbox.commands.filter((c) => c.command === 'echo made > made.txt')).toHaveLength(2);
    expect(filesFromState(state)['/workspace/made.txt']).toBe('made\n');
  });

  it('a retry kills the command its cut-off attempt left running before it syncs', async () => {
    setup = await hybridSetup(machineTurn('echo long-running job'), { prepare: (sb) => sb.hold('long-running job') });
    const { sessions, sessionId, sandbox, server } = setup;
    await sessions.send(sessionId, 'go');
    await deliver(setup.tab, sessionId);
    setup.queue.length = 0;
    // The function dies while the command runs.
    const fn = hostProcess(setup.world);
    void deliver({ ...server, world: fn.world }, sessionId, { anchor: { k: 'msg', m: 'msg_first' } });
    await until(async () => (sandbox.commands.length === 1 ? true : undefined));
    await sleep(50);
    fn.kill();
    const orphan = `cmd_${sandbox.commands[0]!.sandbox}_0`;
    // Its redelivery retries the call.
    const retry = (async () => {
      for (let i = 0; i < 30; i++) {
        if (!(await deliver(server, sessionId, { anchor: { k: 'msg', m: 'msg_first' }, attempt: 2 + i }))) break;
        await sleep(100);
      }
    })();
    await until(async () => (sandbox.commands.length === 2 ? true : undefined));
    expect(sandbox.kills).toContain(orphan);
    sandbox.release('long-running job');
    await retry;
    await setup.deliverQueued();
    const state = await sessions.inspect(sessionId);
    const [first] = execOf(state);
    expect(first).toMatchObject({ status: 'completed' });
    expect(first!.retryOf).toBeDefined();
    expect(textOfRecord(first)).toContain('exit code: 0');
  });

  it('a configured callback makes it fail before anything runs', async () => {
    setup = await hybridSetup(machineTurn('echo should-not-run'), { push: true });
    await setup.sessions.send(setup.sessionId, 'go');
    await setup.drive();
    const state = await setup.inspect();
    const [exec] = execOf(state);
    expect(exec).toMatchObject({ status: 'failed' });
    expect(exec!.error?.message).toMatch(/push callback configured.*callback: undefined.*Nothing ran/);
    expect(setup.sandbox.created).toBe(0);
    expect(setup.sandbox.commands).toEqual([]);
    // The model got the error as the call's result and went on.
    expect(setup.pi.faux.state.callCount).toBe(2);
  });

  it('refuses synced paths outside /workspace: a forged manifest line is never read or recorded', async () => {
    setup = await hybridSetup(machineTurn('echo new > new.txt'));
    const { sandbox } = setup;
    const bad = ['/workspace/../etc/passwd', '/etc/shadow', '/workspace//double.txt', '/workspace/./dot.txt', '/workspace/a\nb.txt', '/workspace/..'];
    const reads: string[] = [];
    const open = sandbox.open.bind(sandbox);
    vi.spyOn(sandbox, 'open').mockImplementation(async (id) => {
      const handle = await open(id);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'manifest') {
            return async (...args: Parameters<typeof handle.manifest>) => {
              const real = await handle.manifest(...args);
              // After the command (the VM has new.txt), the VM's manifest names paths outside the root.
              if (real.has('/workspace/new.txt')) for (const p of bad) real.set(p, { hash: 'f'.repeat(64), size: 4 });
              return real;
            };
          }
          if (key === 'readTextFile') {
            return async (path: string) => {
              reads.push(path);
              return bad.includes(path) ? 'stolen' : handle.readTextFile(path);
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    await setup.sessions.send(setup.sessionId, 'go');
    await setup.drive();
    const state = await setup.inspect();
    const [exec] = execOf(state);
    expect(exec).toMatchObject({ status: 'completed' });
    expect(filesFromState(state)).toEqual({ '/workspace/new.txt': 'new\n' });
    expect(reads.filter((p) => bad.includes(p))).toEqual([]);
    expect(textOfRecord(exec)).toContain('not copied back (not a path under /workspace)');
  });

  it('a timeout that does not fit in the call fails with the seconds left, before anything runs', async () => {
    // A 60 s invocation: its drives' deadline is 45 s out, the call keeps 10 s.
    setup = await hybridSetup(
      [
        fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'npm test', timeoutSeconds: 600 }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'echo short' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('ok')),
      ],
      { maxInvocationMs: 60_000, marginMs: 10_000 }
    );
    await setup.sessions.send(setup.sessionId, 'go');
    await setup.drive();
    const state = await setup.inspect();
    const [refused, ran] = execOf(state);
    expect(refused).toMatchObject({ status: 'failed' });
    expect(refused!.error?.interrupted).toBeUndefined();
    expect(refused!.error?.message).toMatch(/a 600 s timeout does not fit in this call: .* about (3[0-9]) s left .*Nothing ran\. Ask for at most \1 s/);
    // Only the second call ran, with its timeout capped to what was left.
    expect(setup.sandbox.commands.map((c) => c.command)).toEqual(['echo short']);
    const job = JSON.parse((await (await setup.sandbox.open(setup.sessionId)).readTextFile(`/tmp/harness/${ran!.stepId}/job.json`))!);
    expect(job.timeoutSeconds).toBeLessThanOrEqual(35);
    expect(job.timeoutSeconds).toBeGreaterThanOrEqual(30);
    expect(ran).toMatchObject({ status: 'completed' });
  });

  it('caps a timeout to the time left, and refuses one when nothing is left', () => {
    expect(commandSeconds(undefined, 1800, Infinity, 10_000)).toBe(120);
    expect(commandSeconds(undefined, 1800, 40, 10_000)).toBe(40);
    expect(commandSeconds(30, 1800, 40, 10_000)).toBe(30);
    expect(() => commandSeconds(41, 1800, 40, 10_000)).toThrow(/a 41 s timeout does not fit.*about 40 s left \(10 s kept/);
    expect(() => commandSeconds(undefined, 1800, 3, 10_000)).toThrow(/no time left.*Nothing ran/);
    expect(() => commandSeconds(2000, 1800, Infinity, 10_000)).toThrow(/at most 1800/);
    expect(() => commandSeconds(0, 1800, Infinity, 10_000)).toThrow(/at least 1/);
  });

  it('a command past its own timeout comes back timed out', async () => {
    setup = await hybridSetup(machineTurn('sleep-forever', 'ok', { timeoutSeconds: 1 }), { prepare: (sb) => sb.hold('sleep-forever') });
    await setup.sessions.send(setup.sessionId, 'go');
    await setup.drive();
    const [exec] = execOf(await setup.inspect());
    expect(exec).toMatchObject({ status: 'completed' });
    expect(textOfRecord(exec)).toContain('exit code: 124 (timed out after 1s)');
  });

  it('VM lost mid-command: the call runs it again on a new VM from the log\'s workspace, exactly like one clean run', async () => {
    let afterLoss = '';
    setup = await hybridSetup([
      fauxAssistantMessage(fauxToolCall('write_file', { path: 'notes.md', content: 'from the log\n' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'echo scratch > scratch.txt && echo notes >> notes.md' }), { stopReason: 'toolUse' }),
      (context) => {
        afterLoss = textOf(context);
        return fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'cat notes.md; ls' }), { stopReason: 'toolUse' });
      },
      fauxAssistantMessage(fauxText('notes.md has both lines.')),
    ]);
    await setup.sessions.send(setup.sessionId, 'write notes, then use the machine');
    setup.sandbox.lose(setup.sessionId, 'run');
    await setup.drive();
    const state = await setup.inspect();
    const [first, again] = execOf(state);
    expect(first).toMatchObject({ status: 'completed' });
    expect(textOfRecord(first)).toContain('running it again on a new one');
    expect(afterLoss).not.toContain('interrupted');
    expect(setup.sandbox.invalidated).toContain(setup.sessionId);
    expect(setup.sandbox.created).toBe(2);
    expect(again).toMatchObject({ status: 'completed' });
    // One clean run's result: the line appended once, against the log's notes.md.
    expect(textOfRecord(again)).toContain('from the log\\nnotes');
    expect(filesFromState(state)['/workspace/notes.md']).toBe('from the log\nnotes\n');
    expect(filesFromState(state)['/workspace/scratch.txt']).toBe('scratch\n');
    expect(currentLane(state)).toBe('browser');
  });

  it('reconnects when the VM is gone before the command starts, and runs it exactly once', async () => {
    setup = await hybridSetup(machineTurn('echo once'));
    setup.sandbox.lose(setup.sessionId, 'start');
    await setup.sessions.send(setup.sessionId, 'run it');
    await setup.drive();
    const exec = execOf(await setup.inspect())[0]!;
    expect(exec.status).toBe('completed');
    expect(textOfRecord(exec)).toContain('once');
    expect(setup.sandbox.commands.filter((c) => c.command === 'echo once')).toHaveLength(1);
    expect(setup.sandbox.created).toBe(2);
  });

  it('a file the log deleted is gone from the VM before the next command; what the log never had stays', async () => {
    setup = await hybridSetup([
      fauxAssistantMessage(fauxToolCall('write_file', { path: 'a.txt', content: 'a\n' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'mkdir -p node_modules/x && echo dep > node_modules/x/i.js && ls' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'rm a.txt' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'ls; cat node_modules/x/i.js' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('ok')),
    ]);
    await setup.sessions.send(setup.sessionId, 'go');
    await setup.drive();
    const state = await setup.inspect();
    const [, second] = execOf(state);
    expect(second).toMatchObject({ status: 'completed' });
    expect(textOfRecord(second)).not.toContain('a.txt');
    expect(textOfRecord(second)).toContain('dep');
    expect(filesFromState(state)).toEqual({});
  });

  it('copies back no more than the sync budget', async () => {
    setup = await hybridSetup(machineTurn(`for i in $(seq 1 ${SYNC_LIMITS.maxFiles + 5}); do echo $i > f$i.txt; done`));
    await setup.sessions.send(setup.sessionId, 'go');
    await setup.drive();
    const state = await setup.inspect();
    expect(execOf(state)[0]).toMatchObject({ status: 'completed' });
    expect(Object.keys(filesFromState(state))).toHaveLength(SYNC_LIMITS.maxFiles);
    expect(textOfRecord(execOf(state)[0])).toContain('changed in the sandbox only');
  });
});

describe('run_on_machine VMs', () => {
  it('are named hybrid-<runId>, never a dh- name (the session\'s sandbox() VM)', async () => {
    const { VercelSandboxProvider } = await import('./sandbox.ts');
    expect(sandboxNameFor('wrun_01ABC')).toBe('hybrid-wrun-01abc');
    expect(() => new VercelSandboxProvider({ namePrefix: 'dh' })).toThrow(/dh- names are the session's sandbox\(\) VM/);
    expect(() => new VercelSandboxProvider({ namePrefix: 'DH-x' })).toThrow(/refused/);
    expect(new VercelSandboxProvider({ namePrefix: 'hybrid' }).callback).toBeUndefined();
  });
});

describe('run_on_machine on fx', () => {
  it('fx re-runs the turn from the tape to the tool, which runs attached and returns its string', async () => {
    const { createWorld } = await import('@workflow/world-local');
    const { createFxEngine } = await import('libfx');
    const { durableSessions, QUEUE_PREFIX } = await import('harness-world');
    const { FakeSandboxProvider, hybridFxHarness, HYBRID_FX_HARNESS } = await import('./index.ts');
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-fx-machine-')), recoverActiveRuns: false });
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
    const { gateway, calls } = scriptedGateway([
      () => [
        { type: 'tool-call', toolCallId: 's1', toolName: 'run_on_machine', input: { command: 'echo fx-long && echo x > fx.txt' } },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
      ],
      (body) => [
        { type: 'text-delta', delta: body.includes('exit code: 0') ? 'fx saw the result' : 'no result' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ],
    ]);
    const sandbox = new FakeSandboxProvider();
    const queue: import('harness-world').Lane[] = [];
    const harness = (lane: 'browser' | 'sandbox') =>
      hybridFxHarness({
        lane,
        createFxEngine: createFxEngine as never,
        apiKey: 'test',
        fetch: gateway,
        tools: hybridTools(lane === 'sandbox' ? { lane, sandbox, isolation: 'process' } : { lane, isolation: 'process' }),
      });
    const tab = { world, harness: harness('browser'), lanes: laneOptions(['browser'], queue) };
    const server = { world, harness: harness('sandbox'), lanes: laneOptions(['function', 'sandbox'], queue) };
    try {
      const sessions = durableSessions({ world, harness: tab.harness });
      const { sessionId } = await sessions.start({ harness: HYBRID_FX_HARNESS, prompt: 'run it on the machine' });
      queue.push('browser');
      while (queue.length) await deliver(queue.shift() === 'browser' ? tab : server, sessionId);
      const state = await sessions.inspect(sessionId);
      const exec = execOf(state)[0]!;
      expect(typeof exec.output).toBe('string');
      expect(exec.output).toContain('exit code: 0');
      expect(filesFromState(state)['/workspace/fx.txt']).toBe('x\n');
      expect(calls()).toBe(2);
      expect(state.effectOrder.filter((e) => e.name === 'checkpoint' && e.status === 'completed')).toHaveLength(1);
      expect(currentLane(state)).toBe('browser');
    } finally {
      await world.close?.();
    }
  });

  // The Function lane restores a checkpoint the tab may have written (the
  // tab writes the same run): never with the native addon. Node needs JSPI
  // for libfx's wasm build (Node 24 has it).
  it.runIf(typeof WebAssembly !== 'undefined' && 'Suspending' in WebAssembly)(
    'a checkpoint the tab wrote never reaches native libfx: the function lane restores it on the wasm backend',
    async () => {
      const { createWorld } = await import('@workflow/world-local');
      const { createFxEngine } = await import('libfx');
      const { durableSessions, QUEUE_PREFIX } = await import('harness-world');
      const { hybridFxHarness, HYBRID_FX_HARNESS } = await import('./index.ts');
      const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-fx-restore-')), recoverActiveRuns: false });
      world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
      const { gateway } = scriptedGateway([
        // Turn 1, in the tab: a reply, then its checkpoint (the tab's).
        () => [{ type: 'text-delta', delta: 'hello' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }],
        // Turn 2: a backend-only tool, so the function lane restores turn 1's checkpoint.
        () => [
          { type: 'tool-call', toolCallId: 'l1', toolName: 'lookup_customer', input: { query: 'cus_1' } },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
        ],
        () => [{ type: 'text-delta', delta: 'found' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }],
      ]);
      const engines: { lane: string; restore: boolean; backend: unknown }[] = [];
      const spying = (lane: string) => (async (options: Record<string, unknown>) => {
        engines.push({ lane, restore: options.checkpoint !== undefined, backend: options.backend });
        return (createFxEngine as (o: unknown) => Promise<unknown>)(options);
      }) as never;
      const queue: import('harness-world').Lane[] = [];
      const tab = {
        world,
        harness: hybridFxHarness({ lane: 'browser', createFxEngine: spying('browser'), apiKey: 'test', fetch: gateway, tools: hybridTools({ lane: 'browser', isolation: 'process' }) }),
        lanes: laneOptions(['browser'], queue),
      };
      const fn = {
        world,
        harness: hybridFxHarness({
          lane: 'function',
          createFxEngine: spying('function'),
          apiKey: 'test',
          fetch: gateway,
          tools: hybridTools({ lane: 'function', secrets: { crmSecret: 'crm' }, isolation: 'process' }),
        }),
        lanes: laneOptions(['function'], queue),
      };
      try {
        const sessions = durableSessions({ world, harness: tab.harness });
        const { sessionId } = await sessions.start({ harness: HYBRID_FX_HARNESS, prompt: 'hi' });
        const drive = async () => {
          queue.push('browser');
          while (queue.length) await deliver(queue.shift() === 'browser' ? tab : fn, sessionId);
        };
        await drive();
        await sessions.send(sessionId, 'look up cus_1');
        await drive();
        const state = await sessions.inspect(sessionId);
        expect(state.effectOrder.find((e) => e.name === 'tool.lookup_customer')).toMatchObject({ status: 'completed' });
        expect(state.effectOrder.filter((e) => e.name === 'checkpoint' && e.status === 'completed')).toHaveLength(2);
        const restores = engines.filter((e) => e.lane === 'function' && e.restore);
        expect(restores.length).toBeGreaterThan(0);
        expect(restores.every((e) => e.backend === 'wasm')).toBe(true);
        expect(engines.filter((e) => e.lane === 'function' && e.restore && e.backend !== 'wasm')).toEqual([]);
      } finally {
        await world.close?.();
      }
    }
  );
});

type Part = Record<string, unknown>;
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };

/** AI Gateway, scripted: each POST gets the next reply. */
function scriptedGateway(replies: ((body: string) => Part[])[]) {
  let calls = 0;
  const sse = (parts: Part[]) =>
    new Response([...parts.map((p) => `data: ${JSON.stringify(p)}`), 'data: [DONE]', ''].join('\n\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const gateway: typeof fetch = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ object: 'list', data: [] });
    calls++;
    const next = replies.shift();
    if (!next) throw new Error('unexpected model request');
    return sse(next(String(init?.body)));
  };
  return { gateway, calls: () => calls };
}
