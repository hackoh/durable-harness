import { currentLane, SessionLog, stepNameFor } from 'harness-world';
import { createWorldHandler, runOf, runScope } from 'harness-world-remote/server';
import { wakeLane } from './hybrid';
import { admitTabCall, tabSecret } from './run-tokens';
import { getWorld } from './world';

const g = globalThis as { __harnessWorldHandler?: Promise<(req: Request) => Promise<Response>> };

const HANDOFF_STEP = stepNameFor('handoff');

/**
 * The server's World for `createRemoteWorld` in a browser tab: the handler
 * `/api/world` mounts over HTTP and `/api/session-host` serves over one
 * WebSocket. Storage and streams only: the tab keeps its own queue, and
 * server lanes are woken through /api/hybrid/drive (or /api/hybrid/wake), so
 * a hybrid session has exactly one log (world-vercel in production)
 * whichever lane is writing to it.
 *
 * Scoped to the tab's session: a call about a run is served only with that
 * run's token (`x-harness-run-token`, from `/api/hybrid/session-token`),
 * and never one that spans runs (`runs.list`, a hook by id); a run it
 * creates must be a hybrid session, and the streams only the server writes
 * stay the server's (lib/run-tokens.ts). Without a secret on the deployment
 * only the World's own description is served.
 *
 * A tab's commit that leaves work for a server lane (a handoff into it, or
 * a submission while the session is in one) also sends that lane's wake
 * from here, keyed by its cause: the tab's own wake may not land, and a tab
 * that went away is covered by its tether (tab-lost) instead. Nothing here
 * is a backstop chain: each wake is one message, for one cause.
 */
export function worldHandler(): Promise<(req: Request) => Promise<Response>> {
  g.__harnessWorldHandler ??= getWorld().then((world) =>
    createWorldHandler(world, {
      maxStreamMs: 240_000,
      authorize: authorizeTab(),
      async onCommitted(op, args, value) {
        if (op !== 'events.create') return;
        const [runId, request] = args as [string, { eventType?: string; correlationId?: string; eventData?: { stepName?: string } }];
        const submission = request?.eventType === 'hook_received';
        const handoff = request?.eventType === 'step_completed' && request.eventData?.stepName === HANDOFF_STEP;
        if (!submission && !handoff) return;
        const log = new SessionLog(world, runId);
        await log.refresh();
        const lane = currentLane(log.state);
        if (log.state.status !== 'running' || lane === 'browser') return;
        const eventId = (value as { event?: { eventId?: string } } | undefined)?.event?.eventId;
        await wakeLane(world, runId, lane, { log, key: submission ? `submission:${eventId ?? request.correlationId ?? 'unknown'}` : 'handoff' });
      },
      onError: (error, op) => console.log('[harness] /api/world hook failed', { op, error: String(error) }),
    })
  );
  return g.__harnessWorldHandler;
}

/** The tab's World access: its own run's, with its token (fail closed without a secret). */
function authorizeTab() {
  const secret = tabSecret();
  if (!secret) {
    console.log('[harness] /api/world: no HARNESS_TAB_SECRET (or other server secret): every call about a run is refused');
    return (_req: Request, call: { op: string; args: readonly unknown[] }) => runOf(call.op, call.args) === null;
  }
  return runScope({ secret, admit: admitTabCall });
}
