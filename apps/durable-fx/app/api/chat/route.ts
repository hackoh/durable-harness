import { agent } from '@/lib/agent';

const ndjson = { 'content-type': 'application/x-ndjson' };

/**
 * POST ?sessionId= with the prompt as the body: the turn as NDJSON, one event
 * per line, each with a `cursor`. No `sessionId` starts a new session; its id
 * is on the first line. The route only queues the prompt: the turn runs in
 * the wake route withDurableHarness generates (next.config.ts) and keeps
 * going if this response ends.
 */
export async function POST(request: Request) {
  const sessionId = new URL(request.url).searchParams.get('sessionId') ?? undefined;
  // Check here that the caller may use this session.
  const turn = agent.session(sessionId).prompt(await request.text());
  return new Response(turn.readable, { headers: ndjson });
}

/** GET ?sessionId=&cursor=: the session's events after `cursor`, from any server, staying open for new ones. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const sessionId = params.get('sessionId');
  const cursor = Number(params.get('cursor') ?? 0);
  if (!sessionId) return new Response('sessionId is required', { status: 400 });
  if (!Number.isSafeInteger(cursor) || cursor < 0) return new Response('cursor must be a non-negative integer', { status: 400 });
  // The same check as POST.
  return new Response(agent.session(sessionId).stream(cursor), { headers: ndjson });
}
