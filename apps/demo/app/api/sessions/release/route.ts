import { closeUnusedSpares } from '@/lib/spares';

/**
 * `POST { ids }` (the page's `pagehide` beacon): close pre-created sessions
 * the tab never used. A session that got any submission is left alone.
 */
export async function POST(request: Request) {
  const { ids } = (await request.json().catch(() => ({}))) as { ids?: unknown };
  return Response.json({ closed: await closeUnusedSpares(ids) });
}
