import { fxSession, newSessionId, refuseDisabled } from '@/lib/fx-durable';

/**
 * Create an fx (libfx durable) session, optionally with a first prompt. The
 * route only stores the prompt: libfx runs the turn in the wake route.
 */
export async function POST(request: Request) {
  const disabled = refuseDisabled();
  if (disabled) return disabled;
  const { prompt, requestId } = (await request.json().catch(() => ({}))) as { prompt?: string; requestId?: string };
  const sessionId = await newSessionId();
  if (prompt) await (await fxSession(sessionId)).prompt(prompt, { messageId: requestId ?? crypto.randomUUID() }).accepted;
  return Response.json({ sessionId });
}
