import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DriveContext, durableSessions, type Harness } from 'harness-world';
import { legacyWorkflowNameFor } from 'harness-world/names';
import { afterAll, describe, expect, it } from 'vitest';
import { durableAgent, getWorld } from '../src/index.ts';

/** Per message: one `model` effect that answers `<name>:<text>`. */
function answer(name: string): Harness {
  return {
    name,
    async drive(ctx: DriveContext) {
      let turn = ctx.state().effectOrder.length;
      for (const s of ctx.pending()) {
        await ctx.effect(`model:${turn++}`, { name: 'model', replay: 'safe', input: s.text, placed: [s.id] }, async () => `${name}:${s.text}`);
      }
    },
  };
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Sessions from before durable-harness had a queue namespace and its run
 * names (`workflow//harness-world//harness:<harness>`, and a bare
 * `harness:<harness>` from earlier still), left mid-turn by a dead process:
 * the restarted server's World re-enqueues them on durable-harness's prefix,
 * and with several agents in the process each goes to its own harness's.
 */
describe('sessions with older run names and no recorded namespace, after a restart (world-local)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'durable-harness-recovery-names-'));
  const worlds: LocalWorld[] = [];
  afterAll(async () => {
    for (const w of worlds) await w.close?.();
    await ((await getWorld()) as LocalWorld).close?.();
  });

  it('each is recovered by its own agent', async () => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';
    process.env.WORKFLOW_LOCAL_DATA_DIR = dataDir;
    const dead = createWorld({ dataDir, recoverActiveRuns: false });
    worlds.push(dead);
    // The dead process's World: its wakes are lost, and its runs carry the older name and no namespace.
    const older = (name: string) =>
      new Proxy(dead, {
        get(target, key) {
          if (key === 'queue') return async () => ({ messageId: 'msg_dropped' });
          if (key !== 'events') return (target as never)[key];
          return new Proxy(target.events, {
            get: (events, method) =>
              method === 'create'
                ? (runId: string | null, params: { eventType: string; eventData?: Record<string, unknown> }, opts?: unknown) => {
                    if (params.eventType === 'run_created') {
                      const { executionContext: _, ...eventData } = params.eventData ?? {};
                      params = { ...params, eventData: { ...eventData, workflowName: name } };
                    }
                    return events.create(runId, params as never, opts as never);
                  }
                : (events as never)[method],
          });
        },
      }) as unknown as World;
    const ids: Record<string, string> = {};
    for (const [label, name] of [
      ['legacy', legacyWorkflowNameFor('echo')],
      ['bare', 'harness:echo'],
    ] as const) {
      const sessions = durableSessions({ world: older(name), harness: answer('echo') });
      const { sessionId } = await sessions.start();
      await sessions.send(sessionId, label);
      ids[label] = sessionId;
    }

    const echo = durableAgent({ harness: answer('echo') });
    durableAgent({ harness: answer('other') });
    const world = await getWorld();
    for (const [label, sessionId] of Object.entries(ids)) {
      const run = await world.runs.get(sessionId);
      expect((run as { executionContext?: unknown }).executionContext).toBeUndefined();
      const state = await until(async () => {
        const s = await echo.sessions.inspect(sessionId);
        return s.effectOrder.some((e) => e.status === 'completed') ? s : undefined;
      });
      expect(state.effectOrder.map((e) => e.output)).toEqual([`echo:${label}`]);
    }
  }, 60_000);
});
