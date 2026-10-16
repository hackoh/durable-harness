import { type DriveContext, decodeLine, encodeLine, type HostTool } from 'harness-world';
import { monotonicFactory } from 'ulid';
import { TOOL_SPECS, UNSAFE_CONFIRM_MS, type UnsafeToolName, unsafeResultText } from './specs.ts';

/**
 * Two deliberately non-idempotent example tools: `unsafe_send_email` and
 * `unsafe_make_payment`. Every workspace tool is safe to rerun (its only
 * effect is on the workspace, which a retry rebuilds from the log); these
 * are the counter-example, there to exercise the `replay: 'never'` path.
 *
 * Each call appends one record to a ledger that lives outside both the
 * session's workspace and its event log: a World stream named per session
 * (`<runId>_ledger`). Nothing the kernel does can take a record back, so a
 * second execution of one call shows up as a second record for the same
 * call. The side effect happens first; then the tool waits for the
 * (simulated) provider to confirm. A crash in that window is the case that
 * matters: the effect happened, its result did not reach the log, and the
 * kernel must not run it again.
 */

const ulid = monotonicFactory();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ledgerStreamName = (runId: string) => `${runId}_ledger`;

/** One external side effect. */
export interface LedgerRecord {
  /** The side effect's own id (a message or payment id). */
  ref: string;
  tool: UnsafeToolName;
  /** The tool call's memo key: the same across every attempt of one call. */
  callKey: string;
  /** The step (attempt) that performed it. */
  stepId?: string;
  input: Record<string, unknown>;
  /** ms since the epoch. */
  at: number;
}

async function appendLedger(ctx: DriveContext, record: LedgerRecord): Promise<void> {
  // Awaited: the side effect is done once this returns, whatever happens next.
  await ctx.world.streams.write(ctx.runId, ledgerStreamName(ctx.runId), encoder.encode(`${encodeLine(record)}\n\n`));
}

/** Every ledger record of a session, in the order they were written. */
export async function readLedger(world: DriveContext['world'], runId: string): Promise<LedgerRecord[]> {
  let buffer = '';
  let cursor: string | undefined;
  try {
    for (;;) {
      const page = await world.streams.getChunks(runId, ledgerStreamName(runId), cursor ? { cursor } : {});
      for (const chunk of page.data) buffer += decoder.decode(chunk.data, { stream: true });
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
  } catch {
    return [];
  }
  const out: LedgerRecord[] = [];
  for (const line of buffer.split('\n')) {
    if (!line) continue;
    try {
      out.push(decodeLine(line) as LedgerRecord);
    } catch {}
  }
  return out;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

export interface UnsafeToolsOptions {
  /** How long to wait for the simulated confirmation. Default `UNSAFE_CONFIRM_MS`. */
  confirmMs?: number;
}

function unsafeTool(name: UnsafeToolName, options: UnsafeToolsOptions): HostTool<Record<string, unknown>> {
  return {
    ...TOOL_SPECS[name],
    // Not safe to rerun: a second run is a second email / payment. After a
    // crash mid-call the model is told the outcome is unknown instead.
    replay: 'never',
    async execute(input, io) {
      const state = io.ctx.state();
      const callKey = (io.stepId && state.effectOrder.find((e) => e.stepId === io.stepId)?.key) ?? io.stepId ?? 'unknown';
      const ref = `${name === 'unsafe_send_email' ? 'msg' : 'pay'}_${ulid().slice(-10).toLowerCase()}`;
      await appendLedger(io.ctx, { ref, tool: name, callKey, ...(io.stepId ? { stepId: io.stepId } : {}), input, at: Date.now() });
      io.progress({ sideEffect: ref, phase: 'confirming' });
      await sleep(options.confirmMs ?? UNSAFE_CONFIRM_MS, io.signal);
      return unsafeResultText(name, input, ref);
    },
  };
}

/** `unsafe_send_email` and `unsafe_make_payment` (`replay: 'never'`). */
export function unsafeTools(options: UnsafeToolsOptions = {}): HostTool[] {
  return [unsafeTool('unsafe_send_email', options), unsafeTool('unsafe_make_payment', options)];
}
