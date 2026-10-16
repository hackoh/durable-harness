import { createLocalEcho, type DurableSessions, type DurableSessionsOptions, decode } from 'harness-world';
import type { DemoClient, EventPage } from 'harness-world-demo-ui';

type World = DurableSessionsOptions['world'];

/** Reads shared by the two clients that hold a World object in the tab. */

/**
 * When this tab drives a session (This Tab, Hybrid's tab lane), its own live
 * output reaches the page at once rather than after a round trip through
 * the World's stream (over the network, one round trip per burst).
 */
const echo = createLocalEcho();

type EventLike = { eventId: string; eventType: string; createdAt: Date | string; correlationId?: string; eventData?: Record<string, unknown> };

export function eventMeta(e: EventLike): EventPage['events'][number] {
  const data = 'eventData' in e ? e.eventData : undefined;
  return {
    eventId: e.eventId,
    eventType: e.eventType,
    correlationId: 'correlationId' in e ? e.correlationId : undefined,
    stepName: typeof data?.stepName === 'string' ? data.stepName : undefined,
    createdAt: new Date(e.createdAt).toISOString(),
  };
}

export function decodePayload(e: EventLike): unknown {
  const data = e.eventData;
  const payload = data?.input ?? data?.result ?? data?.error ?? data?.payload ?? data?.output;
  if (payload === undefined) return undefined;
  try {
    return decode(payload as never);
  } catch {
    return '<binary>';
  }
}

export function worldReads(world: World, sessions: DurableSessions): Pick<DemoClient, 'events' | 'event' | 'live'> {
  const payloads = new Map<string, unknown>();
  return {
    async events(id, cursor) {
      const out: EventPage['events'] = [];
      let next = cursor;
      for (;;) {
        const page = await world.events.list({
          runId: id,
          pagination: { sortOrder: 'asc', limit: 1000, ...(next ? { cursor: next } : {}) },
          resolveData: 'none',
        });
        out.push(...page.data.map((e) => eventMeta(e as EventLike)));
        if (page.cursor) next = page.cursor;
        if (!page.hasMore) break;
      }
      return { events: out, cursor: next };
    },
    async event(id, eventId) {
      const key = `${id}:${eventId}`;
      if (payloads.has(key)) return payloads.get(key);
      const e = await world.events.get(id, eventId, { resolveData: 'all' });
      const value = decodePayload(e as EventLike);
      payloads.set(key, value);
      return value;
    },
    live(id, onEvent) {
      const abort = new AbortController();
      const off = echo.subscribe(id, onEvent);
      (async () => {
        for await (const event of sessions.live(id, { signal: abort.signal })) if (echo.fromStream(id, event)) onEvent(event);
      })().catch(() => {});
      return () => {
        abort.abort();
        off();
      };
    },
  };
}
