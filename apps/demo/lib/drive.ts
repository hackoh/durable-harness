import { createDriveRoute, type DriveRequest, type DriveRoute } from 'harness-world';
import { after } from 'next/server';
import { getDrillSessions, getSessions } from './sessions';

/**
 * The drive route: the function lane is driven in the
 * invocation that received the submission or the wake, under `after()`
 * (Vercel's `waitUntil`), instead of a queue hop to the flow route. The
 * drive holds no queue message, so it runs under a deadline (harness-world's
 * `directDriveMs`) and stops writing by then; one queue message delayed past
 * that deadline is its companion: if this invocation dies mid-turn, the
 * companion recovers the session; if the turn finished, it finds nothing.
 *
 * `HARNESS_DRIVE=queue` turns it off (every wake is a plain queue message,
 * as before), and a request can ask for either with `drive: 'http' | 'queue'`.
 */
export type DriveMode = 'http' | 'queue';

export function driveMode(requested?: unknown): DriveMode {
  if (requested === 'http' || requested === 'queue') return requested;
  return process.env.HARNESS_DRIVE === 'queue' ? 'queue' : 'http';
}

/**
 * One per process (on `globalThis`: Next compiles route handlers into
 * separate module graphs). A wake that finds a session already driving here
 * makes that drive run once more when it ends (it may be past its last
 * inbox read).
 */
const g = globalThis as { __harnessDriveRoute?: DriveRoute; __harnessDrillRoute?: DriveRoute };
const route = (g.__harnessDriveRoute ??= createDriveRoute({
  after: (work) => after(work),
  drive: async (runId, meta) => (await getSessions()).drive(runId, meta),
  log: (message, fields) => console.log(`[harness] ${message}`, fields ?? {}),
}));

/** Drive `runId` here, after the response is sent. Returns false if this process already drives it (it then drives again). */
export function driveAfterResponse(runId: string, why: string, request: Omit<DriveRequest, 'why'> = {}): boolean {
  return route.drive(runId, { why, ...request });
}

/** Work to finish after the response (the submit's hint and mark flushes, the companion). */
export function waitUntil(work: Promise<unknown>): void {
  after(() => work.then(() => {}, () => {}));
}

/** The drill route's drives (`/api/drill`): the same, on the sessions that fire every armed crash. */
const drill = (g.__harnessDrillRoute ??= createDriveRoute({
  after: (work) => after(work),
  drive: async (runId, meta) => (await getDrillSessions()).drive(runId, meta),
  log: (message, fields) => console.log(`[harness] drill: ${message}`, fields ?? {}),
}));

/** Drive `runId` in this (drill) invocation, after the response. */
export function driveDrillAfterResponse(runId: string, why: string, request: Omit<DriveRequest, 'why'> = {}): boolean {
  return drill.drive(runId, { why, ...request });
}

/**
 * Ask the drill route to drive the session (`POST /api/drill { runId, lane }`)
 * from a server route that found an armed crash (the hybrid drive route): a
 * request to this same deployment, through its protection with the
 * automation bypass. Resolves once the drill route accepted it.
 */
export async function forwardToDrill(runId: string, lane: 'function'): Promise<boolean> {
  const host = process.env.VERCEL_URL;
  if (!host) return false;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const res = await fetch(`https://${host}/api/drill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}) },
    body: JSON.stringify({ runId, lane }),
    cache: 'no-store',
  }).catch(() => undefined);
  void res?.body?.cancel().catch(() => {});
  return !!res?.ok;
}
