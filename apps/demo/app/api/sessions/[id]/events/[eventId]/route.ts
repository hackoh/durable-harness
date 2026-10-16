import { decode } from 'harness-world';
import { getWorld } from '@/lib/world';

/** One event's payload, decoded: fetched only when the page selects the event. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; eventId: string }> }) {
  const { id, eventId } = await params;
  const world = await getWorld();
  const event = await world.events.get(id, eventId, { resolveData: 'all' });
  const data = 'eventData' in event ? (event.eventData as Record<string, unknown> | undefined) : undefined;
  const raw = data?.input ?? data?.result ?? data?.error ?? data?.payload ?? data?.output;
  let payload: unknown;
  try {
    payload = raw === undefined ? undefined : decode(raw as never);
  } catch {
    payload = '<binary>';
  }
  return Response.json({ payload: payload ?? null });
}
