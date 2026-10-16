/**
 * World contract probes (`GET /probe`, only with HARNESS_PROBES=1): what the
 * Cloudflare World accepts and reports where Worlds differ. Each probe runs against a fresh run of
 * its own and reports what happened; nothing here asserts.
 */
import type { World } from '@workflow/world';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();
const enc = new TextEncoder();

async function attempt(fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    const e = error as Error & { status?: number };
    return { ok: false, error: `${e.name}: ${e.message}`.slice(0, 300), ...(e.status ? { status: e.status } : {}) };
  }
}

async function newRun(world: World) {
  const runId = `wrun_${ulid()}`;
  await world.events.create(runId, {
    eventType: 'run_created',
    specVersion: world.specVersion,
    eventData: { deploymentId: await world.getDeploymentId(), workflowName: 'workflow//harness-world//harness:probe', input: enc.encode('null') },
  } as never);
  await world.events.create(runId, { eventType: 'run_started' } as never, { eventCount: 1 } as never);
  return runId;
}

export async function probeWorld(world: World) {
  const out: Record<string, unknown> = {};

  // Correlation ids world-vercel refuses (it takes only step_/hook_/wait_/attr_ + a ULID).
  {
    const runId = await newRun(world);
    out.hookIdNotUlid = await attempt(() =>
      world.events.create(runId, { eventType: 'hook_created', correlationId: `hook_journal_${ulid()}`, eventData: { token: `probe:${runId}:a` } } as never, { eventCount: 2 } as never)
    );
    out.stepIdArbitrary = await attempt(() =>
      world.events.create(runId, { eventType: 'step_created', correlationId: 'not-a-step-id', eventData: { stepName: 'probe', input: enc.encode('1') } } as never)
    );
  }

  // Payloads world-vercel's client refuses (it takes only bytes).
  {
    const runId = await newRun(world);
    const stepId = `step_${ulid()}`;
    await world.events.create(runId, { eventType: 'step_created', correlationId: stepId, eventData: { stepName: 'probe', input: enc.encode('1') } } as never);
    out.jsonStringPayload = await attempt(async () => {
      await world.events.create(runId, { eventType: 'step_started', correlationId: stepId } as never);
      const r = await world.events.create(runId, { eventType: 'step_completed', correlationId: stepId, eventData: { result: JSON.stringify({ a: 1 }) } } as never);
      const back = await world.events.get(runId, (r as { event: { eventId: string } }).event.eventId, { resolveData: 'all' } as never);
      return { storedAs: typeof (back as { eventData?: { result?: unknown } }).eventData?.result };
    });
  }

  // Bump and report: a write from a stale view commits at the next slot and reports what it skipped.
  {
    const runId = await newRun(world);
    const r = (await world.events.create(runId, { eventType: 'hook_created', correlationId: `hook_${ulid()}`, eventData: { token: `probe:${runId}:b` } } as never, {
      eventCount: 0,
    } as never)) as { event?: { eventId: string }; events?: unknown[] };
    out.staleWrite = { committedAt: r.event?.eventId, reportedSkipped: r.events?.length ?? null };
  }

  // Streams: a stream nobody wrote, and the read cursor.
  {
    const runId = await newRun(world);
    out.missingStreamInfo = await attempt(() => world.streams.getInfo(runId, `${runId}_nothing`));
    out.missingStreamChunks = await attempt(() => world.streams.getChunks(runId, `${runId}_nothing`, {}));
    await world.streams.write(runId, `${runId}_s`, enc.encode('one\n'));
    await world.streams.write(runId, `${runId}_s`, enc.encode('two\n'));
    out.streamPage = await attempt(async () => {
      const page = await world.streams.getChunks(runId, `${runId}_s`, { limit: 1 });
      return { chunks: page.data.length, cursor: page.cursor, hasMore: page.hasMore, done: (page as { done?: boolean }).done };
    });
    out.streamList = await attempt(() => world.streams.list(runId));
  }

  // Listing, which stock dashboards and `workflow inspect` use.
  out.runsList = await attempt(() => world.runs.list({ pagination: { limit: 1 } } as never));
  out.hooksListNoRun = await attempt(() => world.hooks.list({ pagination: { limit: 1 } } as never));

  // Hook lookups the kernel uses for caller identities.
  {
    const runId = await newRun(world);
    const token = `probe:${runId}:inbox`;
    const hookId = `hook_${ulid()}`;
    await world.events.create(runId, { eventType: 'hook_created', correlationId: hookId, eventData: { token } } as never, { eventCount: 2 } as never);
    out.hookByToken = await attempt(async () => {
      const hook = await world.hooks.getByToken(token);
      return { sameRun: hook.runId === runId, sameHook: hook.hookId === hookId, resumeCapabilities: (hook as { resumeCapabilities?: unknown }).resumeCapabilities ?? null };
    });
  }

  out.capabilities = world.capabilities ?? null;
  out.specVersion = world.specVersion;
  return out;
}

/**
 * Queue probe: `{ input: { kind: 'probe-tick' } }` messages append one chunk
 * to `<runId>_ticks`, so a caller can count deliveries (idempotency keys).
 */
export function probeRoute(world: World) {
  return (message: unknown): Promise<unknown> | undefined => {
    const { runId, input } = message as { runId?: string; input?: { kind?: string } };
    if (!runId || input?.kind !== 'probe-tick') return undefined;
    return world.streams.write(runId, `${runId}_ticks`, enc.encode('tick\n')).then(() => undefined);
  };
}

/** Enqueue two ticks with one idempotency key, the second after the first was delivered. */
export async function probeIdempotency(world: World) {
  const runId = await newRun(world);
  const key = `probe-key-${ulid()}`;
  const queue = '__wkf_workflow_probe' as never;
  const count = async () => (await world.streams.getChunks(runId, `${runId}_ticks`, {})).data.length;
  const first = await world.queue(queue, { runId, input: { kind: 'probe-tick' } } as never, { idempotencyKey: key });
  const dup = await world.queue(queue, { runId, input: { kind: 'probe-tick' } } as never, { idempotencyKey: key });
  await new Promise((r) => setTimeout(r, 1500));
  const afterPending = await count();
  const later = await world.queue(queue, { runId, input: { kind: 'probe-tick' } } as never, { idempotencyKey: key });
  await new Promise((r) => setTimeout(r, 1500));
  return {
    sameMessageWhilePending: first.messageId === dup.messageId,
    deliveriesAfterTwoSendsWhilePending: afterPending,
    sameMessageAfterDelivery: first.messageId === later.messageId,
    deliveriesAfterAThirdSendWithTheKey: await count(),
  };
}
