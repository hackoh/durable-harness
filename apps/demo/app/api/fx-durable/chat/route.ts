import { fxSession, newSessionId, refuseDisabled, refuseSession } from '@/lib/fx-durable';

/**
 * The two routes from the libfx durability doc, for scripts: they never run
 * the agent. `POST ?sessionId&messageId` with the prompt as the body returns
 * the turn as NDJSON; `GET ?sessionId&cursor` returns the session's stream
 * from `cursor` on, from any server, and `DELETE ?sessionId` cancels its
 * turn. A new session's id is chosen here (libfx accepts a `wrun_` id from
 * the app), so its tools know it from the first turn.
 */
export const maxDuration = 300;

// Uncompressed: a compressed stream is buffered until it ends.
const ndjson = { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache, no-transform', 'content-encoding': 'identity' };

export async function POST(request: Request) {
  const disabled = refuseDisabled();
  if (disabled) return disabled;
  const params = new URL(request.url).searchParams;
  // your auth and ownership check goes here, as in any route
  const id = params.get('sessionId');
  const refused = id ? await refuseSession(id) : undefined;
  if (refused) return refused;
  const session = await fxSession(id ?? (await newSessionId()));
  const messageId = params.get('messageId');
  const turn = session.prompt(await request.text(), messageId ? { messageId } : undefined);
  return new Response(turn.readable, { headers: ndjson });
}

export async function GET(request: Request) {
  const disabled = refuseDisabled();
  if (disabled) return disabled;
  const params = new URL(request.url).searchParams;
  const id = params.get('sessionId');
  if (!id) return Response.json({ error: 'sessionId is required' }, { status: 400 });
  // libfx's stream() throws on anything but a non-negative integer.
  const cursor = Number(params.get('cursor') ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return Response.json({ error: 'cursor must be a non-negative integer' }, { status: 400 });
  // same auth and ownership check as POST
  return new Response((await fxSession(id)).stream(cursor), { headers: ndjson });
}

/** Cancel the session's running turn (a state change, so not a GET). */
export async function DELETE(request: Request) {
  const disabled = refuseDisabled();
  if (disabled) return disabled;
  const id = new URL(request.url).searchParams.get('sessionId');
  if (!id) return Response.json({ error: 'sessionId is required' }, { status: 400 });
  // same auth and ownership check as POST
  const refused = await refuseSession(id);
  if (refused) return refused;
  await (await fxSession(id)).cancel();
  return Response.json({ cancelled: true });
}
