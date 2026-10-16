import type { HarnessOption } from 'harness-world-demo-ui';
import { FX_DURABLE } from 'harness-world-demo-ui/fx-view';
import type { Durability } from 'libfx';
import { localDataDir, worldName } from './world';

// Which World fx (libfx durable) keeps its sessions in. Apart from
// lib/fx-durable.ts so that /api/sessions can list the harness without
// loading libfx.

/**
 * Why fx (libfx durable) cannot run on this server, if it cannot.
 *
 * libfx's sessions have to live in the app's World: the session list,
 * `refuseSession`, and the crash, workspace and mark streams all read and
 * write the app's World (lib/world.ts), by the session's id. libfx sends its
 * queue messages under the `libfx` namespace, apart from this app's own
 * workflows, so it needs an instance of its own on the app's storage, and
 * `fxDurability` gives it one:
 * - HARNESS_WORLD=vercel: libfx's `vercel()`, the same Vercel World. Where
 *   VERCEL is set that is libfx's own default.
 * - HARNESS_WORLD=local: the app's own world-local (the Workflow release the
 *   app pins, lib/world.ts) on the app's data directory, passed to libfx's
 *   `world()` with the options libfx's `local()` uses. Not `local()` itself:
 *   it bundles world-local 5.0.2, whose flat files the app's world-local
 *   (5.1, per-run directories) refuses or wipes at start, so the two could
 *   not share a directory. A second instance of the same world-local on one
 *   directory is safe (run-file locks and stream chunk ids are module-wide,
 *   each event is an exclusive create), and each instance's queue is in
 *   memory and delivers only its own messages (both start with
 *   `recoverActiveRuns: false`; the app's sessions are re-enqueued on the
 *   kernel's prefix by instrumentation.ts, libfx's runs never).
 * - HARNESS_WORLD=postgres: libfx would take a world-postgres instance with
 *   `namespace: 'libfx'` through `world()` (libfx/durable-world), but
 *   world-postgres delivers a prefix with no route registered
 *   for it to /.well-known/workflow/v1/flow, which nothing in this app
 *   serves, so libfx's would never reach `agent.wakeHandler()`. Refused until
 *   libfx's World registers its route: the harness list shows this reason,
 *   and the routes answer 409 with it.
 */
export function fxDurableDisabledReason(): string | undefined {
  if (worldName() === 'postgres') {
    return "fx (libfx durable) is off on this server (HARNESS_WORLD=postgres): world-postgres delivers libfx's queue messages to /.well-known/workflow/v1/flow, which nothing in this app serves, so they would never reach libfx.";
  }
  return undefined;
}

/** The 409 every fx (libfx durable) route answers when it cannot run here (see `fxDurableDisabledReason`). */
export function refuseDisabled(): Response | undefined {
  const reason = fxDurableDisabledReason();
  return reason ? Response.json({ error: reason }, { status: 409 }) : undefined;
}

/** The harness list's entry for fx (libfx durable) when it cannot run here, with the reason (`/api/sessions?include=process`). */
export function fxDurableOption(): HarnessOption | undefined {
  const reason = fxDurableDisabledReason();
  return reason ? { value: FX_DURABLE, label: 'fx (libfx durable)', title: reason, modes: ['server'], disabledReason: reason } : undefined;
}

/** libfx's durability on the app's World (see `fxDurableDisabledReason`); undefined for libfx's own default. */
export async function fxDurability(): Promise<Durability | undefined> {
  if (worldName() === 'local') {
    const [{ world }, { createWorld }, { hostname }] = await Promise.all([import('libfx/durable-world'), import('@workflow/world-local'), import('node:os')]);
    const host = hostname();
    // libfx's `local()`, on the app's world-local: a lease names its holder's
    // process, so a session whose holder died is free at once, and nothing
    // renews a lease (libfx renews one only when it cannot tell). The model's
    // credential is the app's (lib/model.ts): the project's OIDC token from
    // `vercel env pull`, or AI_GATEWAY_API_KEY.
    return world(() => createWorld({ dataDir: localDataDir(), recoverActiveRuns: false }), {
      name: 'local',
      gatewayKey: async () => (await import('./model')).gatewayKey(),
      livenessKnown: true,
      queueDurable: false,
      pollMs: 250,
      holderInfo: () => ({ pid: process.pid, host }),
      alive(lease) {
        const pid = lease.pid;
        if (lease.host !== host || typeof pid !== 'number' || !Number.isSafeInteger(pid)) return null;
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
      },
    });
  }
  return process.env.VERCEL ? undefined : (await import('libfx/durable-vercel')).vercel();
}
