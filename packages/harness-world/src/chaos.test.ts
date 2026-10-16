import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { armedChaos, decodeLine, type DriveContext, durableSessions, EffectFailure, type Harness, liveStreamName, QUEUE_PREFIX, readJsonLines, vercelAnchors } from './index.ts';
import { hostProcess, leasedWorld } from './testing/index.ts';

/** One slow `replay: 'never'` tool per prompt. */
function slowTool(ms: number): Harness {
  return {
    name: 'slow',
    async drive(ctx: DriveContext) {
      for (const s of ctx.pending()) {
        try {
          await ctx.effect(
            `tool:${s.id}`,
            { name: 'tool.slow', replay: 'never', input: s.text, placed: [s.id] },
            async (io) => {
              io.progress({ started: s.text });
              await new Promise((r) => setTimeout(r, ms));
              return 'done';
            }
          );
        } catch (err) {
          if (!(err instanceof EffectFailure)) throw err;
        }
      }
    },
  };
}

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

describe('chaos', () => {
  it('crashes mid-tool, and the next delivery recovers at once (the crash record proves the drive dead)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hw-chaos-'));
    const worldA = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(worldA);
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    const a = durableSessions({ world: worldA, harness: slowTool(60_000), chaos: true, crash: () => crashed() });
    worldA.registerHandler(QUEUE_PREFIX, a.handler);
    const { sessionId } = await a.start();
    await a.chaos(sessionId, { at: 'tool', afterMs: 200 });
    await a.send(sessionId, 'first');
    await died;
    await worldA.close?.(); // the process is gone

    const worldB = createWorld({ dataDir, recoverActiveRuns: true });
    worlds.push(worldB);
    const b = durableSessions({ world: worldB, harness: slowTool(10), chaos: true });
    worldB.registerHandler(QUEUE_PREFIX, b.handler);
    await worldB.start?.();
    const start = Date.now();
    let state = await b.inspect(sessionId);
    while (state.effectOrder.find((e) => e.name === 'tool.slow')?.status !== 'failed') {
      if (Date.now() - start > 10_000) throw new Error('not recovered');
      await new Promise((r) => setTimeout(r, 50));
      state = await b.inspect(sessionId);
    }
    expect(state.effectOrder.map((e) => [e.name, e.status])).toEqual([
      ['tool.slow', 'failed'],
      ['chaos', 'completed'],
    ]);
    expect(state.effectOrder[0]!.error).toMatchObject({ interrupted: true, partial: [{ started: 'first' }] });
    // The crash fired once: a later tool call runs normally.
    await b.send(sessionId, 'second');
    while ((state = await b.inspect(sessionId)).effectOrder.at(-1)?.status !== 'completed' || state.effectOrder.length < 3) {
      if (Date.now() - start > 15_000) throw new Error('second turn did not run');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state.effectOrder.at(-1)).toMatchObject({ name: 'tool.slow', status: 'completed', output: 'done' });
  });

  it('a direct drive crashed mid-tool: its last act hands the session to a continuation, which recovers at once', async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-chaos-')), recoverActiveRuns: false });
    worlds.push(world);
    // Process A drives directly (the drive route); process B serves the queue.
    const proc = hostProcess(world);
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    const logs: string[] = [];
    const a = durableSessions({ world: proc.world, harness: slowTool(60_000), chaos: true, crash: () => (proc.kill(), crashed()) });
    const b = durableSessions({ world, harness: slowTool(10), log: (m) => logs.push(m) });
    world.registerHandler(QUEUE_PREFIX, b.handler);
    await world.start?.();
    const { sessionId } = await b.start();
    await b.chaos(sessionId, { at: 'tool', afterMs: 300 });
    await a.send(sessionId, 'first', 'prompt', { wake: 'backstop' });
    void a.drive(sessionId).catch(() => {});
    await died;
    const crashedAt = Date.now();
    for (;;) {
      const state = await b.inspect(sessionId);
      if (state.effectOrder.find((e) => e.name === 'tool.slow')?.status === 'failed') break;
      if (Date.now() - crashedAt > 8000) throw new Error('not recovered');
      await new Promise((r) => setTimeout(r, 50));
    }
    // The continuation is due ~1s after the crash: no deadline, no lease.
    expect(Date.now() - crashedAt).toBeLessThan(4000);
    const state = await b.inspect(sessionId);
    // Handed over by the dead drive itself: recovered (fenced) as its own.
    expect(state.effectOrder.find((e) => e.name === 'recover')?.input).toMatchObject({ continues: expect.stringMatching(/^deadline:direct_/) });
  }, 20_000);

  it('the recovery re-announces a crash whose own live event the dying process lost', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hw-chaos-'));
    const world = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(world);
    // The dying process's stream writes never land (the SIGKILL took them).
    let dying = true;
    const write = world.streams.write.bind(world.streams);
    world.streams.write = (async (runId: string, name: string, chunk: any) => {
      const lines = new TextDecoder().decode(chunk).split('\n').filter(Boolean);
      if (dying && lines.some((l) => (decodeLine(l) as { type?: string } | null)?.type === 'chaos')) return;
      return write(runId, name, chunk);
    }) as typeof world.streams.write;
    const proc = hostProcess(world);
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    const a = durableSessions({ world: proc.world, harness: slowTool(60_000), chaos: true, crash: () => (proc.kill(), crashed()) });
    const b = durableSessions({ world, harness: slowTool(10) });
    world.registerHandler(QUEUE_PREFIX, b.handler);
    await world.start?.();
    const { sessionId } = await b.start();
    await b.chaos(sessionId, { at: 'tool', afterMs: 200 });
    await a.send(sessionId, 'first', 'prompt', { wake: 'backstop' });
    void a.drive(sessionId).catch(() => {});
    await died;
    dying = false;
    const start = Date.now();
    let events: any[] = [];
    while (!events.some((e) => e?.type === 'chaos')) {
      if (Date.now() - start > 10_000) throw new Error('the crash was never announced');
      await new Promise((r) => setTimeout(r, 50));
      events = await readJsonLines(world, sessionId, liveStreamName(sessionId));
    }
    const chaos = events.findIndex((e) => e?.type === 'chaos');
    expect(events[chaos]).toMatchObject({ reannounced: true, effect: 'tool.slow' });
    // Announced before the recovery that it explains.
    expect(events.findIndex((e) => e?.type === 'mark' && e.name === 'recover.start')).toBeGreaterThan(chaos);
  });

  it('a silent kill (no proof, no continuation) of a queue delivery: the queue redelivers the same message once its lease lapses, and that delivery recovers it, fenced', async () => {
    const base = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-chaos-')), recoverActiveRuns: false });
    worlds.push(base);
    const world = leasedWorld(base, { visibilityMs: 300 });
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    const logs: string[] = [];
    const s = durableSessions({ world, harness: slowTool(60_000), anchors: vercelAnchors(), chaos: true, crash: () => crashed(), log: (m) => logs.push(m) });
    const { sessionId } = await s.start();
    await s.chaos(sessionId, { at: 'tool', afterMs: 300, silent: true });
    await s.send(sessionId, 'first');
    const first = world.broker.deliver()!;
    // The send's own wake lands while it drives: this process drives it once more, and it acks.
    await world.broker.deliver()!.done;
    await died;
    first.kill(); // the instance is gone: no more renewals, nothing it calls returns
    const crashedAt = Date.now();
    // Nothing else stands behind the session: only the queue's redelivery.
    expect(world.broker.available()).toHaveLength(0);
    let again;
    while (!(again = world.broker.deliver())) {
      if (Date.now() - crashedAt > 5000) throw new Error('never redelivered');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(again.messageId).toBe(first.messageId);
    expect(again.attempt).toBe(2);
    await again.done;
    const state = await s.inspect(sessionId);
    expect(state.effectOrder.find((e) => e.name === 'tool.slow')).toMatchObject({ status: 'failed', error: { interrupted: true } });
    // Recovered by its own redelivery (a `recover` step fenced the epoch), not by the crash record.
    expect(state.effectOrder.some((e) => e.name === 'recover')).toBe(true);
    expect(state.effectOrder.find((e) => e.name === 'chaos')?.output).toMatchObject({ silent: true });
    expect(Date.now() - crashedAt).toBeLessThan(2000);
  }, 20_000);

  it('a silent kill of a direct drive (Vercel): its companion, delayed past the drive\'s deadline, recovers it', async () => {
    const base = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-chaos-')), recoverActiveRuns: false });
    worlds.push(base);
    // Queue "seconds" are 100 ms here, so the companion (deadline + 5 s) is due ~0.6 s after a 300 ms drive's deadline.
    const world = leasedWorld(base, { visibilityMs: 300, secondMs: 100 });
    const proc = hostProcess(world);
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    const logs: string[] = [];
    const common = { harness: slowTool(60_000), anchors: vercelAnchors(), directDriveMs: 1500, deadlineMarginMs: 200 };
    const a = durableSessions({ world: proc.world, ...common, chaos: true, crash: () => (proc.kill(), crashed()) });
    const b = durableSessions({ world, ...common, log: (m, f) => (logs.push(m), process.env.DBG && console.log(Date.now() % 100000, m, JSON.stringify(f))) });
    const { sessionId } = await b.start();
    await b.chaos(sessionId, { at: 'tool', afterMs: 300, silent: true });
    await a.send(sessionId, 'first', 'prompt', { wake: 'backstop' });
    void a.drive(sessionId).catch(() => {});
    await died;
    const crashedAt = Date.now();
    // The companion is the only message.
    const companion = world.broker.sent().filter((m) => (m.payload as { input?: { companion?: boolean } }).input?.companion);
    expect(companion).toHaveLength(1);
    const delivered = await world.broker.drain({ timeoutMs: 6000 });
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    const state = await b.inspect(sessionId);
    expect(state.effectOrder.find((e) => e.name === 'tool.slow')).toMatchObject({ status: 'failed', error: { interrupted: true } });
    expect(state.effectOrder.some((e) => e.name === 'recover')).toBe(true);
    // Not before the drive's deadline: until then the dead drive could not be told from a live one.
    expect(Date.now() - crashedAt).toBeLessThan(5000);
  }, 20_000);

  it("a direct drive's companion that lands before the drive's deadline goes back to the queue instead of acking", async () => {
    const base = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-chaos-')), recoverActiveRuns: false });
    worlds.push(base);
    const world = leasedWorld(base, { visibilityMs: 300, secondMs: 50 });
    const logs: string[] = [];
    let release!: () => void;
    const tool = new Promise<void>((r) => (release = r));
    const harness: Harness = {
      name: 'slow',
      async drive(ctx) {
        for (const s of ctx.pending()) {
          await ctx.effect(`tool:${s.id}`, { name: 'tool.slow', replay: 'never', input: s.text, placed: [s.id] }, async () => {
            await tool;
            return 'done';
          });
        }
      },
    };
    // Process A drives directly; process B serves the queue.
    const proc = hostProcess(world);
    const a = durableSessions({ world: proc.world, harness, anchors: vercelAnchors(), directDriveMs: 3000 });
    const s = durableSessions({ world, harness, anchors: vercelAnchors(), directDriveMs: 3000, log: (m) => logs.push(m) });
    const { sessionId } = await s.start();
    await a.send(sessionId, 'first', 'prompt', { wake: 'backstop' });
    const driving = a.drive(sessionId);
    // Deliver the companion early (a queue may), while the drive runs.
    const companion = world.broker.sent().find((m) => (m.payload as { input?: { companion?: boolean } }).input?.companion)!;
    companion.availableAt = 0;
    while (!(await s.inspect(sessionId)).effectOrder.some((e) => e.name === 'tool.slow')) await new Promise((r) => setTimeout(r, 20));
    await world.broker.deliver(companion.messageId)!.done;
    expect(logs).toContain('defer: a direct drive is within its deadline');
    // It sent itself again, past the deadline.
    expect(world.broker.sent().filter((m) => (m.payload as { input?: { companion?: boolean } }).input?.companion)).toHaveLength(2);
    release();
    await driving;
    expect((await s.inspect(sessionId)).effectOrder.find((e) => e.name === 'tool.slow')?.status).toBe('completed');
  }, 20_000);
});

/**
 * The production race (wrun_01M3MY8N24PN5K5M5RCT3TBF68): a "next step" crash
 * armed at 1.5s fired just as the model step completed. The old timer
 * flushed, then wrote its chaos step while the drive went on to commit the
 * model's result and open the next checkpoint; the crash record named the
 * finished model step, so recovery leased the open checkpoint for 61s.
 */
describe('chaos: a crash timed to fire as the step completes', () => {
  /** Per prompt: a model step that takes exactly `modelMs`, then a checkpoint. */
  function turns(modelMs: number, seen: string[]): Harness {
    return {
      name: 'turns',
      async drive(ctx: DriveContext) {
        // Every prompt, memoized ones replay: an interrupted turn resumes.
        for (const s of ctx.state().submissions.filter((x) => x.kind === 'prompt')) {
          await ctx.effect(`model:${s.id}`, { name: 'model', replay: 'safe', input: s.text, placed: [s.id] }, async () => {
            seen.push(`model:${s.text}`);
            await new Promise((r) => setTimeout(r, modelMs));
            return `answer to ${s.text}`;
          });
          await ctx.effect(`checkpoint:${s.id}`, { name: 'checkpoint', replay: 'safe', input: null }, async () => ({ turn: s.text }));
        }
      },
    };
  }
  /** A World whose chaos intent lands 20ms late, like the production log. */
  function slowChaos(world: LocalWorld): LocalWorld {
    return new Proxy(world, {
      get(t, key) {
        if (key !== 'events') return (t as never)[key];
        return new Proxy(t.events, {
          get(e, k) {
            if (k !== 'create') return (e as never)[k];
            return async (runId: string, req: { eventType: string; eventData?: { stepName?: string } }, params: unknown) => {
              if (req.eventType === 'step_started' && req.eventData?.stepName?.endsWith('//chaos')) await new Promise((r) => setTimeout(r, 20));
              return t.events.create(runId, req as never, params as never);
            };
          },
        });
      },
    });
  }

  it('either the crash wins and nothing after it commits, or the step wins and the crash stays armed; recovery is immediate either way', async () => {
    for (const modelMs of [200, 150]) {
      const dataDir = await mkdtemp(join(tmpdir(), 'hw-chaos-race-'));
      const worldA = createWorld({ dataDir, recoverActiveRuns: false });
      worlds.push(worldA);
      worldA.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
      let crashes = 0;
      const seen: string[] = [];
      // afterMs 200: with modelMs 200 the crash timer (armed first) fires in
      // the same tick the model finishes; with 150 the model finishes first.
      const a = durableSessions({ world: slowChaos(worldA), harness: turns(modelMs, seen), chaos: true, crash: () => void crashes++ });
      const { sessionId } = await a.start();
      await a.chaos(sessionId, { at: 'any', afterMs: 200 });
      await a.send(sessionId, 'one');
      const { deliver } = await import('./driver.ts');
      const first = deliver({ world: slowChaos(worldA), harness: turns(modelMs, seen), chaos: true, crash: () => void crashes++ }, sessionId);
      const state = await (async () => {
        for (let i = 0; i < 200; i++) {
          const s = await a.inspect(sessionId);
          if (crashes > 0 || s.effectOrder.some((e) => e.name === 'checkpoint' && e.status === 'completed')) return s;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('neither crashed nor finished');
      })();
      if (modelMs === 200) {
        // The crash won: its step names a running target and this drive; the
        // model's result and the next checkpoint never landed after it.
        expect(crashes).toBe(1);
        await new Promise((r) => setTimeout(r, 100));
        const after = await a.inspect(sessionId);
        const chaos = after.effectOrder.find((e) => e.name === 'chaos')!;
        const model = after.effectOrder.find((e) => e.name === 'model')!;
        expect(chaos.input).toMatchObject({ v: 2, kind: 'process', crashedDuring: model.key, stepId: model.stepId, driver: model.driver });
        expect(model.status).toBe('running');
        expect(after.effectOrder.some((e) => e.name === 'checkpoint')).toBe(false);
        // A new process: every intent the dead drive left is proven dead by
        // the crash record. No waiting, no recover step.
        const worldB = createWorld({ dataDir, recoverActiveRuns: false });
        worlds.push(worldB);
        worldB.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
        const start = Date.now();
        const next = await deliver({ world: worldB, harness: turns(10, seen) }, sessionId);
        expect(next).toBeUndefined();
        expect(Date.now() - start).toBeLessThan(3000);
        const done = await durableSessions({ world: worldB, harness: turns(10, seen) }).inspect(sessionId);
        expect(done.effectOrder.some((e) => e.name === 'recover')).toBe(false);
        expect(done.effectOrder.find((e) => e.name === 'checkpoint')?.status).toBe('completed');
        expect(done.effectOrder.find((e) => e.name === 'model')).toMatchObject({ status: 'completed', attempt: 2 });
      } else {
        // The step won: no chaos step at all, the crash is still armed, and
        // it takes the next matching effect instead.
        await first;
        expect(crashes).toBe(0);
        expect(state.effectOrder.some((e) => e.name === 'chaos')).toBe(false);
        expect(armedChaos(state)).toBeDefined();
        await a.send(sessionId, 'two');
        const second = deliver({ world: worldA, harness: turns(1000, seen), chaos: true, crash: () => void crashes++ }, sessionId);
        for (let i = 0; i < 200 && crashes === 0; i++) await new Promise((r) => setTimeout(r, 10));
        expect(crashes).toBe(1);
        void second;
      }
      await worldA.close?.();
    }
  });

  it('an intent the dead drive wrote that landed after its crash record is resolved at once, without a recover step', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hw-chaos-inflight-'));
    const world = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(world);
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({ ok: true }));
    const seen: string[] = [];
    let crashes = 0;
    const a = durableSessions({ world, harness: turns(5000, seen), chaos: true, crash: () => void crashes++ });
    const { sessionId } = await a.start();
    await a.chaos(sessionId, { at: 'model', afterMs: 50 });
    await a.send(sessionId, 'one');
    const { deliver } = await import('./driver.ts');
    const dead = hostProcess(world);
    void deliver({ world: dead.world, harness: turns(5000, seen), chaos: true, crash: () => (dead.kill(), void crashes++) }, sessionId);
    for (let i = 0; i < 200 && crashes === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(crashes).toBe(1);
    // A write from the dead drive that was already on the wire lands late:
    // a checkpoint intent, after the chaos step, naming the dead drive.
    const { SessionLog } = await import('./session-log.ts');
    const { encode } = await import('./codec.ts');
    const { stepNameFor } = await import('./names.ts');
    const late = new SessionLog(world, sessionId);
    await late.refresh();
    const chaos = late.state.effectOrder.find((e) => e.name === 'chaos')!;
    const driver = (chaos.input as { driver: string }).driver;
    await late.write({
      eventType: 'step_started',
      correlationId: 'step_late_checkpoint',
      eventData: { stepName: stepNameFor('checkpoint'), input: encode({ key: 'checkpoint:late', replay: 'safe', input: null, epoch: 0, drv: driver }) },
    });
    const start = Date.now();
    const next = await deliver({ world, harness: turns(10, seen) }, sessionId);
    expect(next).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(3000);
    const state = await a.inspect(sessionId);
    expect(state.effectOrder.some((e) => e.name === 'recover')).toBe(false);
    expect(state.effects.get('checkpoint:late')?.status).not.toBe('running');
    expect(state.effectOrder.find((e) => e.name === 'model')).toMatchObject({ status: 'completed', attempt: 2 });
  });
});

describe('chaos: which driver fires it', () => {
  /** A tool that waits until `release` resolves (so a crash can be armed while it runs). */
  function gatedTool(release: Promise<void>, started: () => void): Harness {
    return {
      name: 'slow',
      async drive(ctx: DriveContext) {
        for (const s of ctx.pending()) {
          try {
            await ctx.effect(`tool:${s.id}`, { name: 'tool.slow', replay: 'never', input: s.text, placed: [s.id] }, async () => {
              started();
              await release;
              await new Promise((r) => setTimeout(r, 400));
              return 'done';
            });
            // A second call in the same drive: where a crash armed mid-drive fires.
            await ctx.effect(`tool:${s.id}:2`, { name: 'tool.slow', replay: 'never', input: s.text }, async () => {
              await new Promise((r) => setTimeout(r, 400));
              return 'done';
            });
          } catch (err) {
            if (!(err instanceof EffectFailure)) throw err;
          }
        }
      },
    };
  }

  it("fire: false records nothing and kills nothing: the crash stays armed for a driver that fires it", async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-chaos-')), recoverActiveRuns: false });
    worlds.push(world);
    let crashes = 0;
    const sessions = durableSessions({ world, harness: slowTool(300), chaos: { fire: false }, crash: () => void crashes++ });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    await world.start?.();
    const { sessionId } = await sessions.start();
    await sessions.chaos(sessionId, { at: 'tool', afterMs: 100 });
    await sessions.send(sessionId, 'first');
    let state = await sessions.inspect(sessionId);
    for (const t0 = Date.now(); state.effectOrder.find((e) => e.name === 'tool.slow')?.status !== 'completed'; state = await sessions.inspect(sessionId)) {
      if (Date.now() - t0 > 10_000) throw new Error('the tool did not finish');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(crashes).toBe(0);
    expect(state.effectOrder.some((e) => e.name === 'chaos')).toBe(false);
    expect(armedChaos(state)).toBeDefined();
  });

  it("fire: 'armed-in-drive' leaves a crash armed before the drive began, and fires one armed while it runs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hw-chaos-'));
    const world = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(world);
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const sessions = durableSessions({ world, harness: gatedTool(gate, () => started()), chaos: { fire: 'armed-in-drive' }, crash: () => crashed() });
    world.registerHandler(QUEUE_PREFIX, sessions.handler);
    await world.start?.();

    // Armed before the turn: this drive leaves it alone.
    const before = await sessions.start();
    await sessions.chaos(before.sessionId, { at: 'tool', afterMs: 100 });
    release();
    await sessions.send(before.sessionId, 'first');
    let state = await sessions.inspect(before.sessionId);
    for (const t0 = Date.now(); state.effectOrder.filter((e) => e.name === 'tool.slow' && e.status === 'completed').length < 2; state = await sessions.inspect(before.sessionId)) {
      if (Date.now() - t0 > 10_000) throw new Error('the turn did not finish');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state.effectOrder.some((e) => e.name === 'chaos')).toBe(false);
    expect(armedChaos(state)).toBeDefined();

    // Armed while the drive runs: the next matching effect of that drive fires it.
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => (releaseB = r));
    let startedB!: () => void;
    const runningB = new Promise<void>((r) => (startedB = r));
    const worldB = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-chaos-')), recoverActiveRuns: false });
    worlds.push(worldB);
    const b = durableSessions({ world: worldB, harness: gatedTool(gateB, () => startedB()), chaos: { fire: 'armed-in-drive' }, crash: () => crashed() });
    worldB.registerHandler(QUEUE_PREFIX, b.handler);
    await worldB.start?.();
    const during = await b.start();
    await b.send(during.sessionId, 'second');
    await runningB;
    await b.chaos(during.sessionId, { at: 'tool', afterMs: 100 });
    releaseB();
    await died;
    state = await b.inspect(during.sessionId);
    expect(state.effectOrder.find((e) => e.name === 'chaos')).toMatchObject({ status: 'completed', output: { crashedDuring: `tool:${state.submissions.find((s) => s.kind === 'prompt')!.id}:2` } });
    void running;
  });
});

