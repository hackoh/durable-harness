import type { World } from '@workflow/world';
import { deliver, type DriverOptions, durableSessions, type Harness, inBandFenceSupported, vercelAnchors } from 'harness-world';
import { encode } from 'harness-world/codec';
import { getWorld, worldName } from '@/lib/world';

export const maxDuration = 120;

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A ULID (time, then randomness): run ids and anchors for the drill. */
function ulid(): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++, t = Math.floor(t / 32)) time = B32[t % 32] + time;
  let rest = '';
  for (const b of crypto.getRandomValues(new Uint8Array(16))) rest += B32[b % 32];
  return time + rest;
}

/**
 * The World's in-band writer fence, exercised inside a Function against this
 * deployment's World. Every run it makes is cancelled
 * at the end; nothing is queued (the World's queue is stubbed).
 *
 * - `?scenario=repro`: a stale-writer repro, before and after: A loads, B appends, A
 *   appends from its stale view, first with `eventCount` (bump and report),
 *   then in-band at the World's count (a snapshot, or a probe's counters on a
 *   World that lists none).
 * - `?scenario=kernel` (default): two drives of one harness-world session
 *   that each loaded and decided race their first write; the World refuses
 *   one, which stops (`yield: superseded`) and writes nothing.
 */
export async function GET(request: Request) {
  const scenario = new URL(request.url).searchParams.get('scenario') ?? 'kernel';
  const base = await getWorld();
  const world = quiet(base);
  const made: string[] = [];
  try {
    const result = scenario === 'repro' ? await repro(world, made) : await kernel(world, made);
    return Response.json(
      { scenario, world: worldName(), fence: inBandFenceSupported(base), region: process.env.VERCEL_REGION ?? null, sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null, ...result, runs: made },
      { headers: { 'cache-control': 'no-store' } }
    );
  } finally {
    for (const runId of made) await base.events.create(runId, { eventType: 'run_cancelled' } as never).catch(() => {});
  }
}

/** `base` with its queue recorded instead of sent: these sessions belong to no route. */
function quiet(base: World): World & { queued: unknown[] } {
  const queued: unknown[] = [];
  return new Proxy(base, {
    get(target, key) {
      if (key === 'queued') return queued;
      if (key === 'queue') return async (name: string, payload: unknown) => (queued.push({ name, payload }), { messageId: `msg_${ulid()}` });
      const value = (target as unknown as Record<string | symbol, unknown>)[key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as World & { queued: unknown[] };
}

/** Another handle on the same World (another process's: its own drive registry). */
const another = (world: World): World =>
  new Proxy(world, {
    get(target, key) {
      const value = (target as unknown as Record<string | symbol, unknown>)[key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as World;

const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;
const errOf = (e: unknown) => {
  const x = e as { name?: string; status?: number; seq?: number; seqInBand?: number; message?: string };
  return { name: x?.name, status: x?.status, seq: x?.seq, seqInBand: x?.seqInBand, message: String(x?.message ?? e).slice(0, 200) };
};

async function kernel(world: World, made: string[]) {
  const calls = { model: 0, tool: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let arrived = 0;
  // Both drives get as far as their first write (each having loaded and decided) before either writes.
  const harness: Harness = {
    name: 'fence-drill',
    async drive(ctx) {
      for (const sub of ctx.pending()) {
        if (++arrived === 2) release();
        await Promise.race([gate, new Promise((r) => setTimeout(r, 10_000))]);
        await ctx.effect(`model:${sub.id}`, { name: 'model', replay: 'safe', input: sub.text, placed: [sub.id] }, async () => (calls.model++, 'plan'));
        await ctx.effect(`tool:${sub.id}`, { name: 'tool.slow', replay: 'never', input: sub.text }, async () => (calls.tool++, 'ran'));
      }
    },
  };
  const sessions = durableSessions({ world, harness });
  const { sessionId } = await sessions.start({ harness: 'fence-drill', prompt: 'go' });
  made.push(sessionId);
  const logs: Array<{ drive: string; m: string; f?: Record<string, unknown> }> = [];
  const opts = (w: World, drive: string): DriverOptions => ({ world: w, harness, anchors: vercelAnchors(), contendedDelaySeconds: 1, hints: false, log: (m, f) => logs.push({ drive, m, ...(f ? { f } : {}) }) });
  const t = performance.now();
  await Promise.all([
    deliver(opts(another(world), 'a'), sessionId, { anchor: { k: 'msg', m: `msg_a_${ulid()}` } }),
    deliver(opts(another(world), 'b'), sessionId, { anchor: { k: 'msg', m: `msg_b_${ulid()}` } }),
  ]);
  const total = ms(t);
  const state = await sessions.inspect(sessionId);
  const fence = logs.filter((l) => l.m.startsWith('in-band fence') || l.m === 'yield: superseded' || l.m === 'superseded');
  const refusedBy = logs.filter((l) => l.m === 'in-band fence: a write was refused').map((l) => l.drive);
  const stopped = [...new Set(logs.filter((l) => l.m === 'yield: superseded').map((l) => l.drive))];
  const drivers = new Set(state.effectOrder.map((r) => r.driver).filter(Boolean));
  return {
    ok: refusedBy.length === 1 && stopped.length === 1 && stopped[0] === refusedBy[0] && calls.model === 1 && calls.tool === 1 && drivers.size === 1,
    calls,
    refusedBy,
    stopped,
    driversInLog: drivers.size,
    superseded: state.superseded.size,
    effects: state.effectOrder.map((r) => ({ name: r.name, status: r.status, driver: r.driver })),
    fenceLog: fence,
    totalMs: total,
  };
}

async function repro(world: World, made: string[]) {
  const deploymentId = await world.getDeploymentId();
  const newRun = async () => {
    const runId = `wrun_${ulid()}`;
    made.push(runId);
    await world.events.create(runId, { eventType: 'run_created', specVersion: world.specVersion, eventData: { deploymentId, workflowName: 'libfx/session', input: encode([]) } } as never);
    await world.events.create(runId, { eventType: 'run_started', eventData: {} } as never);
    return runId;
  };
  const attr = (i: number | string, by: string) => ({ eventType: 'attr_set', eventData: { changes: [{ key: `libfx.k${i}`, value: by }], writer: { type: 'workflow' } } }) as never;
  const create = world.events.create.bind(world.events) as (runId: string, data: never, params?: Record<string, unknown>) => Promise<{ event?: { eventId: string }; events?: unknown[] }>;
  const listAll = async (runId: string) => {
    const page = (await world.events.list({ runId, pagination: { sortOrder: 'asc', limit: 1000 }, resolveData: 'all' })) as { data: Array<{ eventId: string; eventType: string; eventData?: { changes?: Array<{ value?: string }> } }>; snapshot?: { seq: number; seqInBand: number } };
    return page;
  };
  /** A writer's load: the log and its in-band count (the snapshot, or a refused probe's counters, adopted once the listing covers `seq`). */
  const load = async (runId: string) => {
    let page = await listAll(runId);
    let counters = page.snapshot;
    let source = 'snapshot';
    let probeMs: number | undefined;
    if (!counters) {
      source = 'probe';
      const t = performance.now();
      await create(runId, attr('probe', 'probe'), { inBand: true, expectedSeqInBand: Number.MAX_SAFE_INTEGER }).catch((e: { name?: string; seq?: number; seqInBand?: number }) => {
        if (e?.name === 'InBandSupersededError' && typeof e.seq === 'number' && typeof e.seqInBand === 'number') counters = { seq: e.seq, seqInBand: e.seqInBand };
      });
      probeMs = ms(t);
      page = await listAll(runId);
    }
    if (!counters || page.data.length < counters.seq) throw new Error('no in-band count covered by the listing');
    return { count: counters.seqInBand, events: page.data.length, source, ...(probeMs !== undefined ? { probeMs } : {}) };
  };
  const slot = (r?: { event?: { eventId: string } }) => Number(/(\d+)$/.exec(r?.event?.eventId ?? '')?.[1] ?? NaN);
  const by = (page: Awaited<ReturnType<typeof listAll>>) => page.data.filter((e) => e.eventType === 'attr_set').map((e) => `slot ${Number(/(\d+)$/.exec(e.eventId)?.[1])} by ${e.eventData?.changes?.[0]?.value}`);

  // Before: his scenario 3, as he ran it.
  const r1 = await newRun();
  const viewA = (await listAll(r1)).data.length;
  const b1 = await create(r1, attr(1, 'B'), { eventCount: viewA });
  const a1 = await create(r1, attr(2, 'A (stale)'), { eventCount: viewA }).then(
    (r) => ({ accepted: true, slot: slot(r), skippedReported: r.events?.length ?? 0 }),
    (e) => ({ accepted: false, error: errOf(e) })
  );
  const before = { aLoaded: viewA, bSlot: slot(b1), a: a1, log: by(await listAll(r1)), fenced: !a1.accepted };

  // After: the same writes, in-band at the World's count.
  const r2 = await newRun();
  const a = await load(r2);
  const b = await load(r2);
  let t = performance.now();
  const b2 = await create(r2, attr(1, 'B'), { eventCount: b.events, inBand: true, expectedSeqInBand: b.count });
  const bMs = ms(t);
  t = performance.now();
  const a2 = await create(r2, attr(2, 'A (stale)'), { eventCount: a.events, inBand: true, expectedSeqInBand: a.count }).then(
    (r) => ({ accepted: true, slot: slot(r) }),
    (e) => ({ accepted: false, error: errOf(e) })
  );
  const aMs = ms(t);
  const log2 = by(await listAll(r2));
  const after = { aLoad: a, bLoad: b, bSlot: slot(b2), bWriteMs: bMs, a: a2, aWriteMs: aMs, log: log2, fenced: !a2.accepted && !log2.some((l) => l.includes('stale')) };
  return { ok: !before.fenced && after.fenced, before, after };
}
