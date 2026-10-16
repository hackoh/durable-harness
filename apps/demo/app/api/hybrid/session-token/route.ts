import { issueRunToken } from '@/lib/run-tokens';
import { getWorld } from '@/lib/world';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/hybrid/session-token { runId }`: the tab's capability for one
 * session, `{ token, expiresAt }` (see lib/run-tokens.ts). It sends it on
 * every World call about that run (`/api/world`, `/api/session-host`) and
 * every model call it makes for it (`/api/gateway`). Issued for a hybrid
 * session's run, or a run id the server World does not have yet; 403 for
 * any other run. Never cached.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { runId?: unknown };
  const headers = { 'cache-control': 'no-store, private' };
  const result = await issueRunToken(await getWorld(), body.runId).catch((error: unknown) => {
    console.log('[harness] session token: could not read the run', { error: String(error) });
    return { ok: false as const, status: 503, error: 'could not read the run; try again' };
  });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status, headers });
  return Response.json({ token: result.token, expiresAt: result.expiresAt }, { headers });
}
