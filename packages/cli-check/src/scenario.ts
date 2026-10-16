import type { World } from '@workflow/world';
import { type DurableSessions, effectStreamName, kernelStreamNames, pendingSubmissions, type SessionState, workflowNameFor } from 'harness-world';
import type { SessionExpect, Truth } from './invariants.ts';
import type { Storage } from './worlds.ts';

/**
 * A scenario drives real sessions of one harness on one World, with a
 * scripted model, and hands each settled session to the check: its run id,
 * what the CLI should show for it, and how to read the ground truth.
 */

export interface SessionUnderTest {
  runId: string;
  expect: Omit<SessionExpect, 'phase'>;
  /** What the World API (and the kernel's fold, for kernel sessions) says now. */
  truth(): Promise<Truth>;
  /** The harness's own way to close the session (`run_completed`). Undefined: it has none. */
  close?(): Promise<void>;
}

export interface ScenarioRun {
  session: SessionUnderTest;
  /** Stop everything the run started (World instances, fake servers, children). */
  dispose(): Promise<void>;
}

export interface SessionSpec {
  /** `basic` (two turns, a tool call in the first) or `recovered` (a crash mid-tool, then recovery). */
  label: string;
  /** Why this session cannot run here (a missing binary), or undefined. */
  skip?(): string | undefined;
  run(storage: Storage): Promise<ScenarioRun>;
}

export interface Scenario {
  /** Short name, used in file names, known-issue keys and the report. */
  name: string;
  title: string;
  /** False: a failure is reported but does not fail CI (`CLI_CHECK_NONBLOCKING=1` runs it). */
  blocking: boolean;
  /** Why this scenario cannot run here (a missing binary or platform addon), or undefined. */
  skip?(): string | undefined;
  sessions: SessionSpec[];
}

export async function until<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value !== undefined && value !== false) return value;
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function allPages<T>(page: (cursor?: string) => Promise<{ data: T[]; cursor?: string | null; hasMore: boolean }>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const p = await page(cursor);
    out.push(...p.data);
    if (!p.hasMore || !p.cursor) return out;
    cursor = p.cursor;
  }
}

export async function eventCount(world: World, runId: string): Promise<number> {
  const events = await allPages((cursor) => world.events.list({ runId, pagination: { limit: 100, ...(cursor ? { cursor } : {}) } } as never));
  return events.length;
}

/** The World API's view of a run, plus the kernel's fold when there is one. */
export async function worldTruth(world: World, runId: string, sessions?: DurableSessions): Promise<Truth> {
  const [steps, events, streams, state] = await Promise.all([
    allPages((cursor) => world.steps.list({ runId, resolveData: 'none', pagination: { limit: 100, ...(cursor ? { cursor } : {}) } } as never)),
    eventCount(world, runId),
    world.streams.list(runId).catch(() => [] as string[]),
    sessions?.inspect(runId),
  ]);
  const chunksOf = async (name: string) => ((await world.streams.getInfo(runId, name).catch(() => ({ tailIndex: -1 }))).tailIndex ?? -1) + 1;
  // Streams the kernel or a harness writes under names it knows, which a World could leave out of its listing.
  const expected = [
    ...kernelStreamNames(runId),
    `${runId}_ledger`,
    `${runId}_blobs`,
    ...(steps as { stepId: string }[]).map((s) => effectStreamName(runId, s.stepId)),
  ].filter((name) => !streams.includes(name));
  const chunks = await Promise.all([...streams, ...expected].map(async (name) => [name, await chunksOf(name)] as const));
  const streamChunks = Object.fromEntries(chunks);
  return {
    steps: (steps as { stepId: string; stepName: string; status: string }[]).map((s) => ({ stepId: s.stepId, stepName: s.stepName, status: s.status })),
    eventCount: events,
    streams,
    streamChunks,
    unlistedStreams: expected.filter((name) => streamChunks[name]! > 0),
    ...(state
      ? {
          kernel: {
            effects: state.effectOrder.map((e) => ({ stepId: e.stepId, name: e.name, status: e.status })),
            ignored: [...state.superseded, ...state.fenced],
          },
        }
      : {}),
  };
}

/**
 * Wait until a kernel session is settled: nothing pending in its inbox, no
 * effect running, `done(state)` true, then (with `drain`) nothing more due in
 * the World's queue, and then no new event for `quietMs` (the drive's
 * trailing writes have landed).
 */
export async function settled(
  world: World,
  sessions: DurableSessions,
  runId: string,
  done: (state: SessionState) => boolean,
  options: { timeoutMs?: number; quietMs?: number; what?: string; drain?: () => Promise<void> } = {}
): Promise<SessionState> {
  await until(
    async () => {
      const state = await sessions.inspect(runId);
      const ignored = new Set([...state.superseded, ...state.fenced]);
      const busy = state.effectOrder.some((e) => !ignored.has(e.stepId) && (e.status === 'pending' || e.status === 'running'));
      return pendingSubmissions(state).length === 0 && !busy && done(state) ? state : undefined;
    },
    options.timeoutMs ?? 60_000,
    options.what ?? `${runId} to settle`
  );
  if (options.drain) {
    // A late redelivery (worlds.ts, OpenWorld.drained) writes; let it land and settle too.
    await options.drain();
    await until(
      async () => {
        const state = await sessions.inspect(runId);
        const ignored = new Set([...state.superseded, ...state.fenced]);
        return state.effectOrder.some((e) => !ignored.has(e.stepId) && (e.status === 'pending' || e.status === 'running')) ? undefined : state;
      },
      options.timeoutMs ?? 60_000,
      `${options.what ?? runId} after the queue drained`
    );
  }
  await quiet(world, runId, options.quietMs ?? 600);
  return sessions.inspect(runId);
}

/** Wait until a run's event log has not grown for `ms`. */
export async function quiet(world: World, runId: string, ms: number): Promise<void> {
  let n = await eventCount(world, runId);
  let since = Date.now();
  while (Date.now() - since < ms) {
    await new Promise((r) => setTimeout(r, Math.min(150, ms)));
    const m = await eventCount(world, runId);
    if (m !== n) {
      n = m;
      since = Date.now();
    }
  }
}

/** The session a kernel scenario hands to the check: truth and close through its sessions and World. */
export function kernelSession(
  world: () => World,
  sessions: () => DurableSessions,
  runId: string,
  expect: Omit<SessionExpect, 'phase' | 'workflowName' | 'inputHarness' | 'hookToken' | 'hookPayload'> & { harness: string; hookPayload?: SessionExpect['hookPayload'] }
): SessionUnderTest {
  const { harness, ...rest } = expect;
  return {
    runId,
    expect: {
      workflowName: workflowNameFor(harness),
      inputHarness: harness,
      hookToken: `harness:${runId}:inbox`,
      hookPayload: 'submission',
      ...rest,
    },
    truth: () => worldTruth(world(), runId, sessions()),
    close: async () => {
      await sessions().close(runId);
      await quiet(world(), runId, 400);
    },
  };
}

/** Effect names every kernel session may write besides its harness's own. */
export const KERNEL_EFFECTS = 'recover|restart|chaos|handoff|steer';
