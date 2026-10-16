import { getWorld } from '@/lib/world';

/**
 * The raw event log, exactly as the World stores it, without payloads.
 * `?after=<cursor>` returns only events past a previous read, so a page
 * polling a live session appends instead of rereading.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const after = new URL(request.url).searchParams.get('after') ?? undefined;
  const world = await getWorld();
  const events = [];
  let cursor = after;
  for (;;) {
    const page = await world.events.list({
      runId: id,
      pagination: { sortOrder: 'asc', limit: 1000, ...(cursor ? { cursor } : {}) },
      resolveData: 'none',
    });
    events.push(...page.data);
    if (page.cursor) cursor = page.cursor;
    if (!page.hasMore) break;
  }
  return Response.json({
    events: events.map((e) => {
      const data = 'eventData' in e ? (e.eventData as Record<string, unknown> | undefined) : undefined;
      return {
        eventId: e.eventId,
        eventType: e.eventType,
        correlationId: 'correlationId' in e ? e.correlationId : undefined,
        stepName: typeof data?.stepName === 'string' ? data.stepName : undefined,
        createdAt: e.createdAt,
      };
    }),
    cursor,
  });
}
