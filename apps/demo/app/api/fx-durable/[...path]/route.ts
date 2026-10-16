import type { ChaosSpec } from 'harness-world-demo-ui';
import type { FxSide } from 'harness-world-demo-ui/fx-view';
import { arm, chaosLines, fxSession, marks, refuseDisabled, refuseSession, workspaceSummary } from '@/lib/fx-durable';

// The stream stays open while the page follows the session.
export const maxDuration = 800;

/**
 * An fx (libfx durable) session's routes, under `/api/fx-durable/<id>`:
 * - `GET /<id>/stream?cursor=<n>` the session's stream from `cursor` on
 *   (libfx's `session.stream`, NDJSON); the page builds its view from it
 * - `GET /<id>/side` what the app records beside libfx (`FxSide`): the crash
 *   stream, and the newest workspace record with how many there are (the page
 *   polls this, so it does not send every snapshot)
 * - `GET /<id>/marks` the session's timing marks as they are written (NDJSON)
 * - `POST /<id>/messages` `{ text, kind, requestId, chaos? }`, `POST /<id>/chaos` a crash spec
 *   (404 when `id` is another kind of run in this World: see `refuseSession`)
 *
 * A session's World run exists from its first prompt (libfx reads and writes
 * nothing before), so a crash armed on a session that has none yet comes
 * with its first message and is armed once libfx has accepted it.
 */

/**
 * A live NDJSON stream's headers. `content-encoding: identity` keeps the
 * platform from compressing it: a compressed stream is buffered, so a turn's
 * lines would reach the page only when the next turn pushed them through.
 */
const NDJSON_STREAM = { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache, no-transform', 'content-encoding': 'identity', 'x-accel-buffering': 'no' };

const crashSpec = (body: Record<string, any>): ChaosSpec => ({
  at: body.at === 'model' || body.at === 'any' ? body.at : 'tool',
  afterMs: Math.min(600_000, Math.max(0, Number(body.afterMs ?? 1500))),
});
export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const disabled = refuseDisabled();
  if (disabled) return disabled;
  const [id, what] = (await params).path;
  if (!id) return new Response('not found', { status: 404 });
  if (what === 'stream') {
    const cursor = Number(new URL(request.url).searchParams.get('cursor') ?? 0);
    return new Response((await fxSession(id)).stream(Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0), {
      headers: NDJSON_STREAM,
    });
  }
  if (what === 'marks') {
    const encoder = new TextEncoder();
    const lines = marks(id, request.signal);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await lines.next().catch(() => ({ value: undefined, done: true as const }));
        if (done) controller.close();
        else controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      },
      cancel() {
        void lines.return(undefined);
      },
    });
    return new Response(body, { headers: NDJSON_STREAM });
  }
  if (what === 'side') {
    const [chaos, workspace] = await Promise.all([chaosLines(id), workspaceSummary(id)]);
    return Response.json({ chaos, workspace } satisfies FxSide);
  }
  return new Response('not found', { status: 404 });
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const disabled = refuseDisabled();
  if (disabled) return disabled;
  const [id, what] = (await params).path;
  if (!id || (what !== 'messages' && what !== 'chaos')) return new Response('not found', { status: 404 });
  const refused = await refuseSession(id);
  if (refused) return refused;
  const body = (await request.json().catch(() => ({}))) as Record<string, any>;
  if (what === 'messages') {
    const session = await fxSession(id);
    const text = String(body.text ?? '');
    let submissionId: string | null = null;
    if (body.kind === 'steer') await session.steer(text);
    else {
      const messageId = typeof body.requestId === 'string' ? body.requestId : crypto.randomUUID();
      ({ messageId: submissionId } = await session.prompt(text, { messageId }).accepted);
    }
    // With crashes off (HARNESS_CHAOS=0) the prompt still goes; its crash is dropped.
    if (body.chaos && typeof body.chaos === 'object') await arm(id, crashSpec(body.chaos));
    return Response.json({ submissionId });
  }
  if (!(await arm(id, crashSpec(body)))) return Response.json({ error: 'crashes are off on this server (HARNESS_CHAOS=0)' }, { status: 409 });
  return Response.json({ ok: true });
}
