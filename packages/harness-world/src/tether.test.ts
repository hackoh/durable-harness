import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import {
  armTether,
  commitHandoff,
  commitHost,
  currentLane,
  type DriveContext,
  type DriverOptions,
  deliver,
  durableSessions,
  EffectFailure,
  type HandoffOutput,
  type Harness,
  hostAnchors,
  hostOf,
  type Lane,
  type LaneOptions,
  QUEUE_PREFIX,
  type SessionState,
  SessionLog,
  serveHostDrive,
  type TetherOptions,
  tetherDelivery,
} from './index.ts';
import { hostProcess } from './testing/index.ts';

/**
 * The sandbox lane's tether (tether.ts): a queue delivery that holds its
 * message (the queue library extends the lease, not us) and an open request
 * to the VM's daemon while the daemon drives. The connection is the
 * callback: a daemon that lets go ends the stream, a VM that dies resets it.
 * These are the old backstop's "a host that went quiet" scenarios, with the
 * quiet replaced by the connection.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const forever = () => new Promise<never>(() => {});

let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(20);
  }
}

interface Script {
  model(): Promise<unknown>;
  tool(): Promise<unknown>;
  ran: string[];
}

function scripted(s: Script): Harness {
  return {
    name: 'scripted',
    async drive(ctx: DriveContext) {
      for (const sub of ctx.state().submissions.filter((x) => x.kind === 'prompt')) {
        if (ctx.isMemoized(`tool:${sub.id}`)) continue;
        await ctx.effect(`model:${sub.id}`, { name: 'model', replay: 'safe', input: sub.text, placed: [sub.id] }, async () => (s.ran.push('model'), s.model()));
        await ctx.effect(`tool:${sub.id}`, { name: 'tool.slow', replay: 'safe', input: sub.text }, async () => (s.ran.push('tool'), s.tool()));
      }
    },
  };
}

function lanes(serves: Lane[], wakes: Array<{ to: Lane; handoff: HandoffOutput }>): LaneOptions {
  return {
    serves,
    settle: 'browser',
    available: (l: Lane, st: SessionState) => l !== 'sandbox' || !!hostOf(st),
    async wake(_runId, to, handoff) {
      wakes.push({ to, handoff });
    },
  };
}

/**
 * A VM with a daemon in it: `tether(daemon)` is how a server reaches its
 * `POST /drive` (in process here), `kill()` is the VM dying (the daemon's
 * World calls never return, every open connection to it resets), and
 * `blip()` resets the open connections once without anything dying.
 */
function vm(base: LocalWorld) {
  const proc = hostProcess(base);
  let up = true;
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const attaches: string[] = [];
  const reset = (why: string) => {
    for (const c of open) {
      try {
        c.error(new TypeError(`terminated: ${why}`));
      } catch {}
    }
    open.clear();
  };
  return {
    proc,
    attaches,
    tether(daemon: DriverOptions): TetherOptions {
      return {
        async attach(runId, signal) {
          attaches.push(runId);
          if (!up) throw new TypeError('fetch failed: connect ECONNREFUSED');
          const inner = serveHostDrive(proc.world, runId, () => deliver(daemon, runId)).body!.getReader();
          let controller!: ReadableStreamDefaultController<Uint8Array>;
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              open.add(c);
            },
            async pull(c) {
              const { value, done } = await inner.read();
              if (!open.has(c)) return;
              if (done) {
                open.delete(c);
                c.close();
              } else c.enqueue(value);
            },
            cancel() {
              open.delete(controller);
              void inner.cancel();
            },
          });
          // The client's own abort (its deadline): the response body errors, as fetch's does.
          signal.addEventListener('abort', () => {
            if (!open.delete(controller)) return;
            try {
              controller.error(new DOMException('This operation was aborted', 'AbortError'));
            } catch {}
          });
          return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
        },
        async probe() {
          return up;
        },
        probeRetryMs: 10,
      };
    },
    kill() {
      up = false;
      proc.kill();
      reset('other side closed');
    },
    blip() {
      reset('a proxy dropped the connection');
    },
  };
}

async function setup(s: Script, extra: Partial<DriverOptions> = {}, harness: Harness = scripted(s)) {
  world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-tether-')), recoverActiveRuns: false });
  const wakes: Array<{ to: Lane; handoff: HandoffOutput }> = [];
  const logs: string[] = [];
  const machine = vm(world);
  const daemon: DriverOptions = { world: machine.proc.world, harness, lanes: lanes(['sandbox'], wakes), anchors: hostAnchors({ boot: 'boot_1' }), log: (m) => logs.push(`daemon ${m}`) };
  const tether = machine.tether(daemon);
  const serverOptions: DriverOptions = { world, harness, lanes: lanes(['function'], wakes), log: (m) => logs.push(m), ...extra };
  const server = durableSessions({ ...serverOptions, tether });
  const { sessionId } = await server.start({});
  // The session lives in the sandbox lane on vm1 (as a handoff to it leaves it).
  const log = new SessionLog(world, sessionId);
  await log.refresh();
  await commitHost(log, { lane: 'sandbox', url: 'https://vm1.example', vm: 'vm1', bootId: 'boot_1', version: 'v', at: Date.now() });
  await commitHandoff(log, { from: 'browser', to: 'sandbox', reason: 'test' }, log.state.epoch);
  // Submissions' wakes go to lanes.wake (the daemon's `/wake`): nothing on the queue drives it.
  world.registerHandler(QUEUE_PREFIX, async () => Response.json({}));
  await server.send(sessionId, 'go');
  const delivery = () => tetherDelivery(serverOptions, sessionId, { anchor: { k: 'msg', m: 'msg_tether' }, attempt: 1 }, tether);
  return { server, sessionId, machine, daemon, tether, serverOptions, delivery, wakes, logs, inspect: () => server.inspect(sessionId) };
}

const handoffs = (st: SessionState) => st.effectOrder.filter((e) => e.name === 'handoff').map((e) => (e.input as HandoffOutput).to);

describe('a tether holds the delivery while the daemon drives', () => {
  it('and acks when the daemon lets go: no takeover, nothing marked lost', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s: Script = { model: async () => (await gate, 'plan'), tool: async () => 'ran', ran: [] };
    const { delivery, machine, inspect, logs } = await setup(s);
    let done = false;
    const tethered = delivery().then(() => (done = true));
    await until(async () => ((await inspect()).effectOrder.find((e) => e.name === 'model')?.status === 'running' ? true : undefined));
    await sleep(100);
    expect(done).toBe(false);
    release();
    await tethered;
    const state = await inspect();
    expect(state.effectOrder.find((e) => e.name === 'tool.slow')).toMatchObject({ status: 'completed', driver: expect.any(String) });
    expect(handoffs(state)).toEqual(['sandbox', 'browser']);
    expect(hostOf(state)).toMatchObject({ vm: 'vm1' });
    expect(logs).toContain('tether: the daemon let go');
    expect(machine.attaches).toHaveLength(1);
  });

  it('attaches to a drive already under way (a /wake got there first), and waits for all of it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s: Script = { model: async () => (await gate, 'plan'), tool: async () => 'ran', ran: [] };
    const { delivery, daemon, sessionId, inspect } = await setup(s);
    const woken = deliver(daemon, sessionId);
    await until(async () => ((await inspect()).effectOrder.find((e) => e.name === 'model')?.status === 'running' ? true : undefined));
    let done = false;
    const tethered = delivery().then(() => (done = true));
    await sleep(100);
    expect(done).toBe(false);
    release();
    await Promise.all([woken, tethered]);
    expect(s.ran).toEqual(['model', 'tool']);
    expect((await inspect()).effectOrder.find((e) => e.name === 'tool.slow')).toMatchObject({ status: 'completed' });
  });

  it('arrives through the session queue (a `tether` message) on a handler given `tether`', async () => {
    const s: Script = { model: async () => 'plan', tool: async () => 'ran', ran: [] };
    const { server, sessionId, inspect, logs } = await setup(s);
    world!.registerHandler(QUEUE_PREFIX, server.handler);
    await armTether(world!, sessionId, `${sessionId}:tether:test`);
    await until(async () => (logs.includes('tether: the daemon let go') ? true : undefined));
    expect(handoffs(await inspect())).toEqual(['sandbox', 'browser']);
  });
});

describe('a VM that dies', () => {
  it('mid-model: the tether takes the session to a function, marks the host lost, and the turn finishes there', async () => {
    const s: Script = { model: forever, tool: async () => 'ran', ran: [] };
    const { delivery, machine, inspect, logs, wakes } = await setup(s);
    const tethered = delivery();
    await until(async () => ((await inspect()).effectOrder.find((e) => e.name === 'model')?.status === 'running' ? true : undefined));
    s.model = async () => 'plan';
    const diedAt = Date.now();
    machine.kill();
    await tethered;
    const recoveredMs = Date.now() - diedAt;
    const state = await inspect();
    expect(recoveredMs).toBeLessThan(3000);
    expect(state.effectOrder.find((e) => e.name === 'handoff' && (e.input as HandoffOutput).from === 'sandbox')?.input).toMatchObject({
      to: 'function',
      reason: expect.stringContaining('sandbox host lost'),
    });
    expect(hostOf(state)).toBeUndefined();
    expect(state.effectOrder.find((e) => e.name === 'model')).toMatchObject({ status: 'completed', output: 'plan', retryOf: expect.any(String) });
    expect(state.effectOrder.find((e) => e.name === 'tool.slow')).toMatchObject({ status: 'completed' });
    expect(handoffs(state)).toEqual(['sandbox', 'function', 'browser']);
    expect(logs).toContain('tether: took over from a lost sandbox host');
    expect(wakes.at(-1)?.to).toBe('browser');
  });

  it('before the tether reached it: the daemon never answers, so the session is taken over at once', async () => {
    const s: Script = { model: async () => 'plan', tool: async () => 'ran', ran: [] };
    const { delivery, machine, inspect } = await setup(s);
    machine.kill();
    await delivery();
    const state = await inspect();
    expect(hostOf(state)).toBeUndefined();
    expect(handoffs(state)).toEqual(['sandbox', 'function', 'browser']);
    expect(s.ran).toEqual(['model', 'tool']);
  });
});

describe('a connection that fails while the VM lives', () => {
  it('re-attaches after a blip (the daemon answers its health check) and takes nothing over', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s: Script = { model: async () => (await gate, 'plan'), tool: async () => 'ran', ran: [] };
    const { delivery, machine, inspect, logs } = await setup(s);
    const tethered = delivery();
    await until(async () => ((await inspect()).effectOrder.find((e) => e.name === 'model')?.status === 'running' ? true : undefined));
    machine.blip();
    await until(async () => (machine.attaches.length === 2 ? true : undefined));
    release();
    await tethered;
    const state = await inspect();
    expect(logs).toContain('tether: re-attaching after a connection error');
    expect(handoffs(state)).toEqual(['sandbox', 'browser']);
    expect(hostOf(state)).toMatchObject({ vm: 'vm1' });
    // The daemon's one drive ran the turn once.
    expect(s.ran).toEqual(['model', 'tool']);
  });

  it('rotates before the delivery\'s own deadline: a fresh tether is queued, and the daemon keeps driving undisturbed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s: Script = { model: async () => (await gate, 'plan'), tool: async () => 'ran', ran: [] };
    const { delivery, inspect, logs } = await setup(s, { maxInvocationMs: 400 });
    const queued: Array<{ input?: unknown; key?: string }> = [];
    const queue = world!.queue.bind(world!);
    world!.queue = (async (...args: Parameters<typeof queue>) => {
      queued.push({ input: (args[1] as { input?: unknown }).input, ...(args[2]?.idempotencyKey ? { key: args[2].idempotencyKey } : {}) });
      return queue(...args);
    }) as typeof queue;
    const startedAt = Date.now();
    await delivery();
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(logs).toContain('tether: rotated');
    expect(queued).toContainEqual({ input: { kind: 'tether' }, key: expect.stringContaining(':rotate') });
    release();
    // The daemon's drive finishes the turn and hands back on its own.
    const state = await until(async () => {
      const st = await inspect();
      return st.effectOrder.filter((e) => e.name === 'handoff' && e.status === 'completed').length === 2 ? st : undefined;
    });
    expect(state.effectOrder.find((e) => e.name === 'tool.slow')).toMatchObject({ status: 'completed' });
    expect(handoffs(state)).toEqual(['sandbox', 'browser']);
  });

  it('a session that left the sandbox lane before its tether landed gets an ordinary delivery', async () => {
    const s: Script = { model: async () => 'plan', tool: async () => 'ran', ran: [] };
    const { delivery, sessionId, machine, inspect } = await setup(s);
    const log = new SessionLog(world!, sessionId);
    await log.refresh();
    await commitHandoff(log, { from: 'sandbox', to: 'function', reason: 'test' }, log.state.epoch);
    await delivery();
    expect(machine.attaches).toEqual([]);
    expect(currentLane(await inspect())).toBe('browser');
    expect(s.ran).toEqual(['model', 'tool']);
  });
});

describe('a daemon that escalated and then died mid-sibling', () => {
  it("the tether it is still holding hands the sibling over (the next lane finds it covered), and a function finishes the turn", async () => {
    // One turn: two tool calls at once in the VM, one of which needs a function (an escalation).
    const harness: Harness = {
      name: 'scripted',
      async drive(ctx) {
        const placed = ctx.pending().map((x) => x.id);
        if (!placed.length && !ctx.state().effects.has('model:0')) return;
        await ctx.effect('model:0', { name: 'model', replay: 'safe', input: null, placed }, async () => 'two tools');
        await Promise.all([
          ctx.effect('tool:vm', { name: 'tool.vm', replay: 'never', input: null }, forever).catch((err) => {
            if (!(err instanceof EffectFailure)) throw err;
          }),
          ctx.effect('tool:secret', { name: 'tool.secret', replay: 'safe', input: null, requires: 'function' }, async () => 'secret'),
        ]);
      },
    };
    const s: Script = { model: async () => 'plan', tool: async () => 'ran', ran: [] };
    const { delivery, machine, inspect, logs, wakes } = await setup(s, {}, harness);
    const tethered = delivery();
    // The daemon escalates to a function while tool:vm keeps running in the VM.
    await until(async () => (wakes.some((w) => w.to === 'function') ? true : undefined));
    const diedAt = Date.now();
    machine.kill();
    await tethered;
    const recoveredMs = Date.now() - diedAt;
    const state = await inspect();
    expect(logs).toContain('tether: handing over what a lost sandbox host left running');
    expect(state.effects.get('tool:vm')).toMatchObject({ status: 'failed', error: { interrupted: true } });
    expect(state.effects.get('tool:secret')).toMatchObject({ status: 'completed', output: 'secret' });
    expect(hostOf(state)).toBeUndefined();
    expect(state.effectOrder.filter((e) => e.status === 'running')).toEqual([]);
    expect(recoveredMs).toBeLessThan(3000);
  });

  it('a tether that lands after the escalation still attaches while the daemon runs the sibling', async () => {
    let finish!: (v: string) => void;
    const harness: Harness = {
      name: 'scripted',
      async drive(ctx) {
        const placed = ctx.pending().map((x) => x.id);
        if (!placed.length && !ctx.state().effects.has('model:0')) return;
        await ctx.effect('model:0', { name: 'model', replay: 'safe', input: null, placed }, async () => 'two tools');
        await Promise.all([
          ctx.effect('tool:vm', { name: 'tool.vm', replay: 'never', input: null }, () => new Promise<string>((r) => (finish = r))),
          ctx.effect('tool:secret', { name: 'tool.secret', replay: 'safe', input: null, requires: 'function' }, async () => 'secret'),
        ]);
      },
    };
    const s: Script = { model: async () => 'plan', tool: async () => 'ran', ran: [] };
    const { delivery, daemon, sessionId, machine, inspect, wakes } = await setup(s, {}, harness);
    // A /wake got there first: the daemon drives and escalates before any tether lands.
    const woken = deliver(daemon, sessionId);
    await until(async () => (wakes.some((w) => w.to === 'function') ? true : undefined));
    expect(currentLane(await inspect())).toBe('function');
    let done = false;
    const tethered = delivery().then(() => (done = true));
    await until(async () => (machine.attaches.length === 1 ? true : undefined));
    await sleep(50);
    expect(done).toBe(false);
    finish('vm done');
    await Promise.all([woken, tethered]);
    expect((await inspect()).effects.get('tool:vm')).toMatchObject({ status: 'completed', output: 'vm done' });
  });
});
