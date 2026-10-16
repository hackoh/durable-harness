import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DriveContext, EffectFailure, type Harness, type HostTool, hostToolIO, type SessionState, Yield } from 'harness-world';

/** One tool call: what a scripted prompt asks for. */
export interface Call {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * A harness with no model: every prompt is a tool call as JSON (or a list of
 * them, run concurrently, the way the AI SDK runs one step's calls, or
 * `{ seq: [...] }`, run one after another in one drive). A call that failed
 * is a result, as a model would see it; a released call reruns on the next
 * drive.
 */
export function scripted(tools: HostTool[]): Harness {
  return {
    name: 'scripted',
    async drive(ctx: DriveContext) {
      for (const s of ctx.state().submissions) {
        if (s.kind !== 'prompt' || !s.text || ctx.state().withdrawn.has(s.id)) continue;
        const parsed = JSON.parse(s.text) as Call | Call[] | { seq: Call[] };
        const calls = 'seq' in parsed ? parsed.seq : Array.isArray(parsed) ? parsed : [parsed];
        const runCall = async (call: Call, i: number) => {
          const tool = tools.find((t) => t.name === call.tool);
          if (!tool) throw new Error(`no tool ${call.tool}`);
          try {
            await ctx.effect(
              calls.length === 1 ? `tool:${s.id}` : `tool:${s.id}:${i}`,
              { name: `tool.${tool.name}`, replay: tool.replay, input: call.input, placed: [s.id] },
              (io) => tool.execute(call.input, hostToolIO(io, ctx))
            );
          } catch (err) {
            if (!(err instanceof EffectFailure)) throw err;
          }
        };
        if ('seq' in parsed) for (const [i, call] of calls.entries()) await runCall(call, i);
        else await Promise.all(calls.map(runCall));
      }
    },
  };
}

/**
 * A harness with no model whose prompts are lists of calls (JSON), run one
 * after another, that yields (as a drive out of budget does) right after
 * the first call it ran itself: so a turn's first call runs in one drive and
 * the rest in the next (in this process or another).
 */
export function yieldingAfterFirst(tools: HostTool[]): Harness {
  return {
    name: 'yielding',
    async drive(ctx: DriveContext) {
      for (const sub of ctx.state().submissions) {
        if (sub.kind !== 'prompt' || !sub.text || ctx.state().withdrawn.has(sub.id)) continue;
        const calls = JSON.parse(sub.text) as Call[];
        for (const [i, call] of calls.entries()) {
          const key = `tool:${sub.id}:${i}`;
          const memo = ctx.isMemoized(key);
          const tool = tools.find((t) => t.name === call.tool);
          if (!tool) throw new Error(`no tool ${call.tool}`);
          try {
            await ctx.effect(key, { name: `tool.${tool.name}`, replay: tool.replay, input: call.input, placed: [sub.id] }, (io) => tool.execute(call.input, hostToolIO(io, ctx)));
          } catch (err) {
            if (!(err instanceof EffectFailure)) throw err;
          }
          if (!memo && i === 0) throw new Yield('budget');
        }
      }
    },
  };
}

export const toolRecords = (s: SessionState) => s.effectOrder.filter((e) => e.name.startsWith('tool.'));

export async function until(fn: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A world-local store, and a way to open it (as another process would). */
export async function localStore(prefix = 'hw-hands-'): Promise<{ dataDir: string; open(opts?: { recover?: boolean }): LocalWorld; closeAll(): Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const opened: LocalWorld[] = [];
  return {
    dataDir,
    open(opts = {}) {
      const w = createWorld({ dataDir, recoverActiveRuns: opts.recover ?? false });
      opened.push(w);
      return w;
    },
    async closeAll() {
      for (const w of opened.splice(0)) await w.close?.();
    },
  };
}

type World = DriveContext['world'];
type Event = Awaited<ReturnType<World['events']['list']>>['data'][number];

/** Every event of a run, in log order. */
export async function allEvents(world: World, runId: string): Promise<Event[]> {
  const out: Event[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await world.events.list({ runId, pagination: { sortOrder: 'asc', limit: 1000, ...(cursor ? { cursor } : {}) }, resolveData: 'none' });
    out.push(...page.data);
    if (!page.hasMore || !page.cursor) return out;
    cursor = page.cursor;
  }
}
