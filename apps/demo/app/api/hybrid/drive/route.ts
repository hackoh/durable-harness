import { armedChaos, currentLane, type Lane, SessionLog } from 'harness-world';
import { driveAfterResponse, forwardToDrill } from '@/lib/drive';
import { wakeLane } from '@/lib/hybrid';
import { drillRoute, getSessions } from '@/lib/sessions';
import { getWorld } from '@/lib/world';

// The drive runs in this invocation after the 202 (see lib/drive.ts).
export const maxDuration = 800;

/**
 * `POST /api/hybrid/drive { runId, lane }`: the tab (or anything else that
 * just committed a handoff to a server lane) asks this Function to drive
 * the session now. Answers 202 at once, before any World call; results
 * reach clients through the session's `live` and hints streams.
 *
 * After the response, one log read decides whether the session is in that
 * lane. The drive then starts from that log, under a deadline, with its
 * companion (a queue message delayed past the deadline) sent first. Nothing
 * here is on the tab's path: a lost 202 is retried by the tab, and a tab
 * that went away is covered by its tether.
 *
 * `GET ?warm=1` keeps an instance (and its World, sessions and harnesses)
 * warm: the tab calls it at most once every 3 minutes while it is active.
 */
export async function POST(request: Request) {
  const { runId, lane } = (await request.json()) as { runId?: string; lane?: Lane };
  if (!runId?.startsWith('wrun_') || (lane !== 'function' && lane !== 'sandbox')) {
    return Response.json({ error: 'expected { runId, lane: "function" | "sandbox" }' }, { status: 400 });
  }
  if (lane === 'sandbox') {
    // The retired brain-in-VM lane: a session an older log left there is
    // handed to the function lane, whose wake goes out with it (lib/hybrid.ts).
    const result = await wakeLane(await getWorld(), runId, 'sandbox');
    return Response.json({ accepted: result.queued, ...result }, { status: 202 });
  }
  return Response.json({ accepted: true, driving: driveFunction(runId) }, { status: 202 });
}

function driveFunction(runId: string): boolean {
  const lane: Lane = 'function';
  return driveAfterResponse(runId, `wake:${lane}`, {
    prepare: async () => {
      const world = await getWorld();
      const log = new SessionLog(world, runId);
      await log.refresh();
      if (log.state.status !== 'running' || currentLane(log.state) !== lane) {
        console.log('[harness] drive route: not in that lane', { runId, lane, status: log.state.status, now: currentLane(log.state) });
        return false;
      }
      // An armed crash fires in a Function of its own (lib/sessions.ts `drillRoute`).
      const armed = armedChaos(log.state);
      if (drillRoute() && armed && (armed.chaos.kind ?? 'process') === 'process' && (await forwardToDrill(runId, lane))) {
        console.log('[harness] drive route: armed crash, driven by the drill route', { runId });
        return false;
      }
      // The companion behind this drive is sent by the drive itself (its deadline anchor).
      return { log };
    },
  });
}

export async function GET() {
  const t0 = Date.now();
  await getSessions();
  return Response.json({ warm: true, ms: Date.now() - t0 }, { headers: { 'cache-control': 'no-store' } });
}
