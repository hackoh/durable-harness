import { after } from 'next/server';
import { arm, eventPayload, liveStream, submit, view } from '@/lib/pi-durable';

export const maxDuration = 800;

/**
 * A pi-durable session's routes, under `/api/pi-durable/<id>`:
 * - `GET /<id>` the session as the page shows it (`?known=<eventCount>` answers `{ unchanged }`)
 * - `GET /<id>/events` its event log rows (one per journal commit), `GET /<id>/events/<eventId>` one commit
 * - `GET /<id>/live` server-sent events: text deltas of the committed partial, tool starts, commits
 * - `POST /<id>/messages` `{ text, kind, requestId }`, `POST /<id>/chaos` a crash spec
 */
export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const [id, what, eventId] = (await params).path;
  if (!id) return new Response('not found', { status: 404 });
  if (what === 'live') return liveStream(id, request.signal);
  if (what === 'events' && eventId) return Response.json({ payload: await eventPayload(id, eventId) });
  const v = await view(id);
  if (what === 'events') return Response.json({ events: v.events, ...(v.events.length ? { cursor: v.events.at(-1)!.eventId } : {}) });
  const known = new URL(request.url).searchParams.get('known');
  if (known !== null && known === `${v.view.eventCount}:${v.chaos.length}`) return Response.json({ unchanged: true });
  return Response.json({ ...v.view, version: `${v.view.eventCount}:${v.chaos.length}`, commits: v.snap.commits });
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const [id, what] = (await params).path;
  if (!id) return new Response('not found', { status: 404 });
  const body = (await request.json().catch(() => ({}))) as Record<string, any>;
  if (what === 'messages') {
    const kind = body.kind === 'steer' || body.kind === 'followUp' ? body.kind : 'prompt';
    const submissionId = await submit(id, String(body.text ?? ''), kind, String(body.requestId ?? crypto.randomUUID()), (work) => after(work));
    return Response.json({ submissionId });
  }
  if (what === 'chaos') {
    const at = body.at === 'model' || body.at === 'any' ? body.at : 'tool';
    const afterMs = Math.min(600_000, Math.max(0, Number(body.afterMs ?? 1500)));
    await arm(id, { at, afterMs, ...(body.silent === true ? { silent: true } : {}) });
    return Response.json({ ok: true });
  }
  return new Response('not found', { status: 404 });
}
