import { randomBytes } from 'node:crypto';
import type { World } from '@workflow/world';
import { harnessOf } from 'harness-world';
import { mintRunToken, RUN_TOKEN_HEADER, runOf, verifyRunToken, type WorldCall } from 'harness-world-remote/server';

/**
 * A tab's capability: a token bound to one run id (harness-world-remote's
 * run tokens), checked by `/api/world` (and `/api/session-host`) on every
 * call and by `/api/gateway` on every model call. It replaces the project
 * OIDC token `/api/token` used to hand the tab (docs/workspaces.md §8).
 *
 * A token is issued (`POST /api/hybrid/session-token`) for a hybrid
 * session's run, or for a run id the server World does not have yet: a
 * session the tab is about to create, or one whose log lives in the
 * browser (the Tab modes, which only call `/api/gateway`). The app is behind
 * Vercel Authentication and its session routes already serve any session
 * to its visitors, so what the token limits is what the tab's credential
 * reaches (one run, for an hour), not who may open a hybrid session.
 */

/** The hybrid harness names (harness-world-hybrid's), spelled here so naming them loads nothing. */
export const HYBRID_HARNESSES: readonly string[] = ['hybrid', 'hybrid-fx'];

/** A run id as harness-world mints one: `wrun_` and a ULID. */
export const isRunId = (id: unknown): id is string => typeof id === 'string' && /^wrun_[0-9A-HJKMNP-TV-Z]{26}$/.test(id);

const g = globalThis as { __harnessTabSecret?: string };

/**
 * The server-only secret run tokens are derived from: `HARNESS_TAB_SECRET`,
 * else a secret the deployment already has (the sandbox host's or the
 * CRM's; harness-world-remote derives its own key from it). Off Vercel with
 * none, one per process (local dev). On Vercel with none: undefined, and
 * every run-scoped call is refused (instances must agree on the secret).
 */
export function tabSecret(): string | undefined {
  const configured = process.env.HARNESS_TAB_SECRET ?? process.env.HYBRID_HOST_SECRET ?? process.env.HYBRID_CRM_SECRET;
  if (configured) return configured;
  if (process.env.VERCEL) return undefined;
  return (g.__harnessTabSecret ??= randomBytes(32).toString('base64url'));
}

/** The stream `/api/gateway` records a session's spend in: the tab may not write it. */
export const spendStreamName = (runId: string) => `${runId}_spend`;
/** Streams only the server writes on a hybrid run: the spend, and the unsafe tools' side-effect ledger. */
const SERVER_STREAMS = (runId: string) => new Set([spendStreamName(runId), `${runId}_ledger`]);

/** Whether the server World has the run: its harness name, or `null` when it has no such run. */
export async function runHarness(world: World, runId: string): Promise<string | null | undefined> {
  try {
    const run = await world.runs.get(runId, { resolveData: 'none' } as never);
    return harnessOf((run as { workflowName?: string }).workflowName) ?? '';
  } catch (err) {
    const e = err as { name?: string; status?: number; statusCode?: number };
    if (e?.name === 'WorkflowRunNotFoundError' || e?.status === 404 || e?.statusCode === 404) return null;
    throw err;
  }
}

export type IssueResult = { ok: true; token: string; expiresAt: number } | { ok: false; status: number; error: string };

/** A token for `runId`: a hybrid session's run, or one the server World does not have yet. */
export async function issueRunToken(world: World, runId: unknown): Promise<IssueResult> {
  if (!isRunId(runId)) return { ok: false, status: 400, error: 'expected { runId: "wrun_<ulid>" }' };
  const secret = tabSecret();
  if (!secret) return { ok: false, status: 503, error: 'no HARNESS_TAB_SECRET (or other server secret) on this deployment' };
  const harness = await runHarness(world, runId);
  if (harness !== null && !HYBRID_HARNESSES.includes(harness ?? '')) return { ok: false, status: 403, error: 'not a hybrid session' };
  const { token, expiresAt } = await mintRunToken(secret, runId);
  return { ok: true, token, expiresAt };
}

/** The run a request's token is for, if it has a valid one. */
export async function tokenRun(request: Request): Promise<string | undefined> {
  const secret = tabSecret();
  if (!secret) return undefined;
  return (await verifyRunToken(secret, request.headers.get(RUN_TOKEN_HEADER) ?? ''))?.runId;
}

/**
 * What `/api/world` refuses even on the token's own run: a `run_created`
 * for anything but a hybrid harness, a hook whose token is not the run's
 * own (`harness:<runId>:…`), and a write to a stream only the server writes.
 */
export function admitTabCall(call: WorldCall, runId: string): boolean {
  if (call.op === 'events.create') {
    const data = call.args[1] as { eventType?: unknown; eventData?: { workflowName?: unknown; token?: unknown } } | undefined;
    if (data?.eventType === 'run_created') return HYBRID_HARNESSES.includes(harnessOf(String(data.eventData?.workflowName ?? '')) ?? '');
    if (data?.eventType === 'hook_created') return typeof data.eventData?.token === 'string' && data.eventData.token.startsWith(`harness:${runId}:`);
    return true;
  }
  if (call.op === 'streams.write' || call.op === 'streams.writeMulti' || call.op === 'streams.close') {
    return !SERVER_STREAMS(runId).has(String(call.args[1]));
  }
  return true;
}

export { RUN_TOKEN_HEADER, runOf };
