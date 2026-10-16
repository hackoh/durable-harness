import type { Lane } from 'harness-world';
import { wakeLane } from '@/lib/hybrid';
import { getWorld } from '@/lib/world';

/**
 * The tab calls this after it commits a handoff to a server lane: the
 * session's next step needs a backend secret (`function`) or a real machine
 * (`sandbox`). Everything the server needs is already in the log.
 */
export async function POST(request: Request) {
  const { runId, lane } = (await request.json()) as { runId?: string; lane?: Lane };
  if (!runId?.startsWith('wrun_') || (lane !== 'function' && lane !== 'sandbox')) {
    return Response.json({ error: 'expected { runId, lane: "function" | "sandbox" }' }, { status: 400 });
  }
  return Response.json(await wakeLane(await getWorld(), runId, lane));
}
