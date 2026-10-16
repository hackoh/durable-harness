import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import {
  commitHost,
  currentLane,
  deliver,
  type DriverOptions,
  durableSessions,
  type HandoffOutput,
  hostOf,
  type Lane,
  type LaneOptions,
  laneAvailable,
  ownerCheck,
  parkedRecords,
  QUEUE_PREFIX,
  SessionLog,
  type SessionState,
  type TetherOptions,
  tetherDelivery,
} from 'harness-world';
import { FakeSandboxProvider, hybridHarness, hybridTools, sandboxOwnerPolicy } from 'harness-world-hybrid';
import { hostProcess, piSetup } from 'harness-world-hybrid/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from './host.ts';
import { LocalSandboxProvider } from './local-sandbox.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(25);
  }
}

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

const SECRET = 'host-secret';

async function setup(responses: Parameters<typeof piSetup>[0], opts: { daemonWorld?: (w: LocalWorld) => LocalWorld } = {}) {
  world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-host-')), recoverActiveRuns: false });
  world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
  const w = world;
  const pi = piSetup(responses);
  const base = await mkdtemp(join(tmpdir(), 'hw-vm-'));
  const vm = new LocalSandboxProvider({ name: 'vm1', sessionId: 'sess1', base });
  const remote = new FakeSandboxProvider();
  const woken: Lane[] = [];
  const pending: Promise<unknown>[] = [];
  // The app's function lane: only `function`, machine tools remotely (a fake VM).
  const fnLanes: LaneOptions = {
    serves: ['function'],
    settle: 'browser',
    available: (l, st) => laneAvailable(st, l),
    async wake(runId, to) {
      woken.push(to);
      if (to === 'sandbox') await host.handle(wakeRequest(runId));
      if (to === 'function') pending.push(deliver(fn, runId));
    },
  };
  const fn: DriverOptions = {
    world: w,
    harness: hybridHarness({ ...pi, lane: 'function', tools: hybridTools({ lane: 'function', sandbox: remote, secrets: { crmSecret: 'crm' } }), lanes: fnLanes }),
    owners: [sandboxOwnerPolicy({ provider: vm, pollWaitMs: 100 })],
    log: (m: string, f?: unknown) => process.env.HDEBUG && console.log('FN', m, JSON.stringify(f)),
  };
  const tabLanes: LaneOptions = {
    serves: ['browser'],
    settle: 'browser',
    available: (l, st) => laneAvailable(st, l),
    async wake(runId, to) {
      woken.push(to);
      if (to === 'sandbox') await host.handle(wakeRequest(runId));
      if (to === 'function') pending.push(deliver(fn, runId));
    },
  };
  const tab: DriverOptions = { world: w, harness: hybridHarness({ ...pi, lane: 'browser', lanes: tabLanes }) };
  const host: Host = createHost({
    world: opts.daemonWorld?.(w) ?? w,
    vm: 'vm1',
    sessionId: 'sess1',
    bootId: 'boot1',
    version: 'test',
    secret: SECRET,
    sandbox: vm,
    appOrigin: 'https://app.test',
    harnesses: (tools, lanes) => [hybridHarness({ ...pi, lane: 'sandbox', tools, lanes })],
    log: (m, f) => process.env.HDEBUG && console.log('HOST', m, JSON.stringify(f)),
    // The function lane's drive route, in-process.
    fetch: (async (_url: string, init: RequestInit) => {
      const { runId, lane } = JSON.parse(String(init.body)) as { runId: string; lane: Lane };
      woken.push(lane);
      pending.push(deliver(fn, runId));
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });
  const sessions = durableSessions({ world: w, harness: tab.harness });
  const { sessionId } = await sessions.start({ harness: 'hybrid' });
  const log = new SessionLog(w, sessionId);
  await log.refresh();
  // As the app does: `/attach`, then the host fact.
  const attached = await host.handle(
    new Request('http://vm.test/attach', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ runId: sessionId }) })
  );
  if (attached.status !== 200) throw new Error(`attach answered ${attached.status}`);
  await commitHost(log, { lane: 'sandbox', url: 'http://vm.test', vm: 'vm1', bootId: 'boot1', version: 'test', at: Date.now() });
  const inspect = () => sessions.inspect(sessionId);
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      await host.idle();
      while (pending.length) await pending.shift();
      await host.idle();
      if (!pending.length) {
        const st = await inspect();
        if (!st.effectOrder.some((e) => e.status === 'running' || e.status === 'pending') && currentLane(st) === 'browser') return st;
      }
      await sleep(20);
    }
    const st = await inspect();
    throw new Error(`never settled: ${currentLane(st)} ${JSON.stringify(st.effectOrder.map((e) => [e.name, e.status, (e.input as { reason?: string })?.reason ?? '']))}`);
  };
  return { w, sessions, sessionId, tab, fn, host, vm, woken, inspect, settled, pending };
}

const wakeRequest = (runId: string) =>
  new Request('http://vm.test/wake', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ runId }) });

const handoffs = (st: SessionState) =>
  st.effectOrder.filter((e) => e.name === 'handoff').map((e) => `${(e.input as HandoffOutput).from}>${(e.input as HandoffOutput).to}`);

describe('the in-VM host', () => {
  it('moves tab -> sandbox (commands run on its machine) -> function (secret) -> sandbox -> tab', async () => {
    const s = await setup([
      fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'echo machine > m.txt; uname -s' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('lookup_customer', { query: 'cus_42' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'cat m.txt' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('all done')),
    ]);
    await s.sessions.send(s.sessionId, 'go');
    await deliver(s.tab, s.sessionId);
    const st = await s.settled();
    expect(handoffs(st)).toEqual(['browser>sandbox', 'sandbox>function', 'function>sandbox', 'sandbox>browser']);
    const execs = st.effectOrder.filter((e) => e.name === 'tool.run_on_machine');
    expect(execs.map((e) => e.status)).toEqual(['completed', 'completed']);
    expect(JSON.stringify(execs[1]!.output)).toContain('machine');
    // Each machine command ran attached, on the daemon's machine: nothing parked.
    expect(st.effectOrder.filter((e) => e.name === 'park')).toHaveLength(0);
    expect(JSON.stringify(st.effectOrder.find((e) => e.name === 'tool.lookup_customer')?.output)).toContain('function lane');
    // The workspace file the command wrote came back into the fold.
    expect(await s.vm.handle.readTextFile('/workspace/m.txt')).toBe('machine\n');
    // Health answers without the secret; control calls need it.
    expect((await s.host.handle(new Request('http://vm.test/health'))).status).toBe(200);
    expect((await s.host.handle(new Request('http://vm.test/wake', { method: 'POST', body: '{}' }))).status).toBe(401);
  });

  it('a daemon killed mid-command: its tether takes the session to a function, which runs the safe call again, and the model sees success', async () => {
    let daemon: ReturnType<typeof hostProcess> | undefined;
    const s = await setup(
      [
        fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'sleep 1; echo survived' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('ok')),
      ],
      {
        // The daemon dies the moment it would record the command's outcome.
        daemonWorld: (w) =>
          (daemon = hostProcess(w, (r) => r.eventType === 'step_completed' && /tool\.run_on_machine/.test(r.eventData?.stepName ?? ''))).world as LocalWorld,
      }
    );
    // The app's tether: `POST /drive` held open; a VM that dies resets it.
    const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const tether: TetherOptions = {
      async attach(runId) {
        if (daemon?.dead) throw new TypeError('fetch failed: connect ECONNREFUSED');
        const res = await s.host.handle(
          new Request('http://vm.test/drive', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ runId }) })
        );
        const inner = res.body!.getReader();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              open.add(c);
            },
            async pull(c) {
              const { value, done } = await inner.read();
              if (!open.has(controller)) return;
              if (done) {
                open.delete(controller);
                c.close();
              } else c.enqueue(value);
            },
          }),
          { status: res.status }
        );
      },
      probe: async () => !daemon?.dead,
      probeRetryMs: 10,
    };
    const watcher = setInterval(() => {
      if (!daemon?.dead) return;
      for (const c of open) c.error(new TypeError('terminated: other side closed'));
      open.clear();
    }, 20);
    await s.sessions.send(s.sessionId, 'go');
    await deliver(s.tab, s.sessionId);
    // The tab handed the session to the sandbox lane; whoever did sends its tether.
    expect(currentLane(await s.inspect())).toBe('sandbox');
    const tethered = tetherDelivery(s.fn, s.sessionId, { anchor: { k: 'msg', m: 'msg_tether' }, attempt: 1 }, tether);
    await until(async () => (daemon?.dead ? true : undefined));
    const diedAt = Date.now();
    await tethered;
    clearInterval(watcher);
    let st = await s.inspect();
    expect(Date.now() - diedAt).toBeLessThan(5000);
    expect(handoffs(st)).toContain('sandbox>function');
    expect(hostOf(st)).toBeUndefined();
    // The call never reported: the function retries it (it is safe) on the
    // machine it reaches, and finishes the turn.
    for (let i = 0; i < 150; i++) {
      for (const r of parkedRecords(st.effectOrder).filter((p) => !p.settlement)) {
        await ownerCheck(s.fn, s.sessionId, { kind: 'owner-check', stepId: r.stepId, nonce: `t${i}` });
      }
      while (s.pending.length) await s.pending.shift();
      await deliver(s.fn, s.sessionId);
      while (s.pending.length) await s.pending.shift();
      st = await s.inspect();
      const exec = st.effectOrder.find((e) => e.name === 'tool.run_on_machine');
      if (exec?.status === 'completed' && currentLane(st) === 'browser') break;
      await sleep(60);
    }
    const exec = st.effectOrder.find((e) => e.name === 'tool.run_on_machine')!;
    if (exec.status !== 'completed') console.log('DEBUG', currentLane(st), JSON.stringify(st.effectOrder.map((e) => [e.name, e.status, e.settlement ? 'S' : '', e.park ? 'P' : '']), null, 0));
    expect(exec.status).toBe('completed');
    expect(JSON.stringify(exec.output)).toContain('survived');
    expect(JSON.stringify(exec.output)).toContain('exit code: 0');
  });

  it('a tether holds while the daemon drives and lets go with it: nothing is taken over', async () => {
    const s = await setup([
      fauxAssistantMessage(fauxToolCall('run_on_machine', { command: 'echo here' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('done')),
    ]);
    const tether: TetherOptions = {
      attach: async (runId) =>
        s.host.handle(new Request('http://vm.test/drive', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ runId }) })),
      probe: async () => true,
    };
    await s.sessions.send(s.sessionId, 'go');
    // The tab hands the session to the sandbox lane; its /wake starts the daemon's drive, the tether attaches to it.
    const tab = deliver(s.tab, s.sessionId);
    await until(async () => (currentLane(await s.inspect()) === 'sandbox' ? true : undefined));
    await tetherDelivery(s.fn, s.sessionId, { anchor: { k: 'msg', m: 'msg_tether' }, attempt: 1 }, tether);
    await tab;
    const st = await s.settled();
    expect(handoffs(st)).toEqual(['browser>sandbox', 'sandbox>browser']);
    expect(hostOf(st)?.bootId).toBe('boot1');
    expect(st.effectOrder.find((e) => e.name === 'tool.run_on_machine')).toMatchObject({ status: 'completed' });
  });

  it('marks nothing lost while the host drives, and routes machine work to the function once the host is lost', async () => {
    const s = await setup([fauxAssistantMessage(fauxText('hi'))]);
    const log = new SessionLog(s.w, s.sessionId);
    await log.refresh();
    expect(hostOf(log.state)?.bootId).toBe('boot1');
    expect(laneAvailable(log.state, 'sandbox')).toBe(true);
  });

  it('refuses a wake for a session it is not attached to, and a wake while its token is expired', async () => {
    let exp: number | undefined = Math.floor(Date.now() / 1000) + 3600;
    const host = createHost({
      world: createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-host-refuse-')), recoverActiveRuns: false }),
      vm: 'vm1',
      sessionId: 'sess1',
      bootId: 'boot1',
      version: 'test',
      secret: SECRET,
      sandbox: new LocalSandboxProvider({ name: 'vm1', sessionId: 'sess1', base: await mkdtemp(join(tmpdir(), 'hw-host-refuse-vm-')) }),
      harnesses: () => [],
      tokenExp: () => exp,
    });
    const r1 = await host.handle(wakeRequest('wrun_notattached'));
    expect(r1.status).toBe(409);
    exp = Math.floor(Date.now() / 1000) - 1;
    await host.handle(new Request('http://vm.test/attach', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ runId: 'wrun_x' }) }));
    const r2 = await host.handle(wakeRequest('wrun_x'));
    expect(r2.status).toBe(503);
    expect(await r2.json()).toMatchObject({ error: 'token expired' });
  });
});
