import { currentLane, SessionLog } from 'harness-world';
import { driveDrillAfterResponse, waitUntil } from '@/lib/drive';
import { getDrillSessions } from '@/lib/sessions';
import { getWorld } from '@/lib/world';

/**
 * Crash drills, in a Function of their own (lib/sessions.ts `drillRoute`).
 * A maxDuration no other route has (and its own `vercel.json` entry) keeps
 * this route out of every other route's Function, so the instance a drill
 * kills runs only drills: other sessions' turns and live tails are never on
 * it.
 *
 * - `POST { runId, text, kind }`: a message to a session with an armed
 *   crash (the page sends it here instead of `/api/sessions/<id>/messages`).
 *   It answers once the submission is durable, and the turn runs in this
 *   invocation after the response, where the crash fires.
 * - `POST { runId, lane: 'function' }`: drive a hybrid session's function
 *   lane here (the hybrid drive route forwards one with an armed crash).
 */
export const maxDuration = 790;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { runId?: string; text?: string; kind?: 'prompt' | 'steer' | 'followUp'; lane?: string };
  const runId = body.runId;
  if (!runId?.startsWith('wrun_')) return Response.json({ error: 'expected { runId, text } or { runId, lane }' }, { status: 400 });
  if (body.lane === 'function') {
    const accepted = driveDrillAfterResponse(runId, 'drill:function', {
      prepare: async () => {
        const log = new SessionLog(await getWorld(), runId);
        await log.refresh();
        if (log.state.status !== 'running' || currentLane(log.state) !== 'function') return false;
        return { log };
      },
    });
    return Response.json({ accepted: true, driving: accepted }, { status: 202 });
  }
  if (typeof body.text !== 'string' || !body.text) return Response.json({ error: 'text must be a non-empty string' }, { status: 400 });
  const kind = body.kind ?? 'prompt';
  const submissionId = await (await getDrillSessions()).send(runId, body.text, kind, { wake: 'backstop', waitUntil });
  driveDrillAfterResponse(runId, `drill:${kind}`);
  return Response.json({ submissionId, drive: 'drill' });
}
