import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRunQueueNamespace, parseQueueName, QueuePrefix, ValidQueueName, type World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { ulid } from 'ulid';
import { afterEach, describe, expect, it } from 'vitest';
import { durableSessions, encode, OWNER_QUEUE, QUEUE_NAME, QUEUE_PREFIX, recoverSessions, SessionLog } from './index.ts';
import { harnessOfQueue, workflowNameFor } from './names.ts';
import { EXECUTION_CONTEXT, LEGACY_QUEUE_PREFIX, PI_WAKE_QUEUE, QUEUE_NAMESPACE, QUEUE_TOPIC } from './queue.ts';
import type { DriveContext, Harness } from './types.ts';

describe('the kernel queue', () => {
  it('is a namespace of its own on the World queue, apart from the Workflow SDK default prefix', () => {
    expect(QUEUE_NAMESPACE).toBe('harness');
    expect(QUEUE_PREFIX).toBe('__harness_wkf_workflow_');
    expect(QueuePrefix.parse(QUEUE_PREFIX)).toBe(QUEUE_PREFIX);
    expect(QUEUE_TOPIC).toBe('__harness_wkf_workflow_*');
    for (const name of [QUEUE_NAME, OWNER_QUEUE, PI_WAKE_QUEUE]) {
      expect(ValidQueueName.parse(name)).toBe(name);
      expect(parseQueueName(name).prefix).toBe(QUEUE_PREFIX);
      // The Workflow SDK's consumer takes its prefix: none of ours starts with it.
      expect(name.startsWith(LEGACY_QUEUE_PREFIX)).toBe(false);
    }
    expect([QUEUE_NAME, OWNER_QUEUE, PI_WAKE_QUEUE]).toEqual(['__harness_wkf_workflow_session', '__harness_wkf_workflow_owner', '__harness_wkf_workflow_pi']);
    expect(getRunQueueNamespace(EXECUTION_CONTEXT)).toBe('harness');
  });

  it("reads the harness from a recovery delivery on the kernel's prefix and on the old one, and from none of the kernel's own queues", () => {
    expect(harnessOfQueue(`${QUEUE_PREFIX}${workflowNameFor('pi-durable')}`)).toBe('pi-durable');
    expect(harnessOfQueue('__harness_wkf_workflow_workflow//durable-harness@0.0.1//pi')).toBe('pi');
    expect(harnessOfQueue(`${LEGACY_QUEUE_PREFIX}${workflowNameFor('codex')}`)).toBe('codex');
    for (const queue of [QUEUE_NAME, OWNER_QUEUE, PI_WAKE_QUEUE, '__harness_wkf_workflow_hybrid_function', '__harness_wkf_workflow_workflow//./src/x//pi']) {
      expect(harnessOfQueue(queue)).toBeUndefined();
    }
  });
});

/** Each message: one `model` effect that answers its text. */
function answer(): Harness {
  return {
    name: 'answer',
    async drive(ctx: DriveContext) {
      let turn = ctx.state().effectOrder.length;
      for (const s of ctx.pending()) {
        await ctx.effect(`model:${turn++}`, { name: 'model', replay: 'safe', input: s.text, placed: [s.id] }, async () => `re: ${s.text}`);
      }
    },
  };
}

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

async function local(dataDir: string, recoverActiveRuns: boolean): Promise<LocalWorld> {
  const world = createWorld({ dataDir, recoverActiveRuns });
  worlds.push(world);
  return world;
}

/** A run as another consumer creates it (a Workflow SDK workflow, libfx, or a session from before the namespace). */
async function foreignRun(w: World, workflowName: string, harness?: string): Promise<string> {
  const runId = `wrun_${ulid()}`;
  await w.events.create(runId, {
    eventType: 'run_created',
    specVersion: w.specVersion,
    eventData: { deploymentId: await w.getDeploymentId(), workflowName, input: encode(harness ? { harness } : {}) },
  } as never);
  const log = new SessionLog(w, runId);
  await log.refresh();
  await log.write({ eventType: 'run_started' });
  if (harness) await log.write({ eventType: 'hook_created', correlationId: `hook_${ulid()}`, eventData: { token: `harness:${runId}:inbox`, isWebhook: false } } as never);
  return runId;
}

/** `world`, with every `queue()` call recorded and not sent. */
function recording(world: World): { world: World; sent: { queueName: string; runId: unknown }[] } {
  const sent: { queueName: string; runId: unknown }[] = [];
  const proxy = new Proxy(world, {
    get(target, key) {
      if (key === 'queue') {
        return async (queueName: string, message: { runId?: unknown }) => {
          sent.push({ queueName, runId: message?.runId });
          return { messageId: `msg_${ulid()}` };
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { world: proxy, sent };
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('sessions on the kernel namespace', () => {
  it("record it on their run, so the World knows the run's consumer", async () => {
    const world = await local(await mkdtemp(join(tmpdir(), 'harness-world-queue-')), false);
    const sessions = durableSessions({ world, harness: answer() });
    const { sessionId } = await sessions.start();
    const run = await world.runs.get(sessionId);
    expect(run.executionContext).toEqual({ queueNamespace: 'harness' });
    expect(getRunQueueNamespace(run.executionContext)).toBe(QUEUE_NAMESPACE);
  });

  it("recoverSessions re-enqueues only harness sessions, each on the kernel's prefix; `unrecorded` only those from before the namespace", async () => {
    const world = await local(await mkdtemp(join(tmpdir(), 'harness-world-queue-')), false);
    const sessions = durableSessions({ world, harness: answer() });
    const fresh = (await sessions.start()).sessionId;
    const old = await foreignRun(world, workflowNameFor('answer'), 'answer');
    const workflow = await foreignRun(world, 'workflow//./src/jobs/order//processOrder');
    const libfx = await foreignRun(world, 'libfx/session');
    const { world: spy, sent } = recording(world);

    expect(await recoverSessions(spy)).toBe(2);
    expect(sent.sort((a, b) => String(a.runId).localeCompare(String(b.runId)))).toEqual(
      [fresh, old].sort().map((runId) => ({ queueName: `${QUEUE_PREFIX}${workflowNameFor('answer')}`, runId }))
    );
    expect(sent.map((s) => s.runId)).not.toContain(workflow);
    expect(sent.map((s) => s.runId)).not.toContain(libfx);

    sent.length = 0;
    expect(await recoverSessions(spy, { unrecorded: true })).toBe(1);
    expect(sent).toEqual([{ queueName: `${QUEUE_PREFIX}${workflowNameFor('answer')}`, runId: old }]);
  });

  it("a restart resumes a session whose wake the dead process never delivered, through the kernel's prefix (world-local, its own recovery off)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'harness-world-queue-'));
    // The first process: a prompt lands in the log, and the process dies before its wake is delivered.
    const first = await local(dataDir, false);
    const { world: dropping, sent } = recording(first);
    const a = durableSessions({ world: dropping, harness: answer() });
    const { sessionId } = await a.start();
    await a.send(sessionId, 'hi');
    expect(sent.map((s) => s.queueName)).toContain(QUEUE_NAME);
    expect((await a.inspect(sessionId)).effectOrder).toEqual([]);

    // The next process: a World on the same directory, recovery by the kernel.
    const next = await local(dataDir, false);
    const b = durableSessions({ world: next, harness: answer() });
    const queues: string[] = [];
    next.registerHandler(QUEUE_PREFIX, async (request) => {
      queues.push(request.headers.get('x-vqs-queue-name') ?? '');
      return b.handler(request);
    });
    await next.start?.();
    expect(await recoverSessions(next)).toBe(1);
    const state = await until(async () => {
      const s = await b.inspect(sessionId);
      return s.effectOrder.some((e) => e.status === 'completed') ? s : undefined;
    }, 20_000);
    expect(state.effectOrder.map((e) => e.output)).toEqual(['re: hi']);
    expect(queues[0]).toBe(`${QUEUE_PREFIX}${workflowNameFor('answer')}`);
  });

  it("a World's own recovery (another consumer's instance on the directory) sends a session back to the kernel's prefix, not the Workflow SDK's", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'harness-world-queue-'));
    const ours = await local(dataDir, false);
    const sessions = durableSessions({ world: ours, harness: answer() });
    const { sessionId } = await sessions.start();
    // A second instance with its default recovery on, as the Workflow SDK's would be.
    const theirs = await local(dataDir, true);
    const delivered: string[] = [];
    theirs.registerHandler(QUEUE_PREFIX, async (request) => {
      delivered.push(`${request.headers.get('x-vqs-queue-name')} ${(await request.clone().json()).runId}`);
      return Response.json({ ok: true });
    });
    theirs.registerHandler(LEGACY_QUEUE_PREFIX, async (request) => {
      delivered.push(`workflow-sdk ${request.headers.get('x-vqs-queue-name')}`);
      return Response.json({ ok: true });
    });
    await theirs.start?.();
    await until(async () => (delivered.length > 0 ? true : undefined));
    expect(delivered).toEqual([`${QUEUE_PREFIX}${workflowNameFor('answer')} ${sessionId}`]);
  });
});
