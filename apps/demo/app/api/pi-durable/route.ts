import { PI_DURABLE_HANDS } from 'harness-world-demo-ui/axes';
import { after } from 'next/server';
import { startHands } from '@/lib/hands';
import { createSession, submit } from '@/lib/pi-durable';

// The first prompt's turn runs in this invocation after the response.
export const maxDuration = 800;

/**
 * Create a pi-durable session (Pi 1.0's Harness on this app's World),
 * optionally with a first prompt, with the hands the page asks for
 * (pi-durable's: every one but Virtual + machine; Sandbox later).
 */
export async function POST(request: Request) {
  const { prompt, requestId, hands: wanted } = (await request.json().catch(() => ({}))) as { prompt?: string; requestId?: string; hands?: unknown };
  const picked = startHands({ label: 'Pi (pi-durable)', ...PI_DURABLE_HANDS }, wanted);
  if ('error' in picked) return Response.json({ error: picked.error }, { status: 400 });
  const sessionId = await createSession(picked.hands);
  if (prompt) await submit(sessionId, prompt, 'prompt', requestId ?? crypto.randomUUID(), (work) => after(work));
  return Response.json({ sessionId });
}
