/** The app's own chat route: Pi's own API on a World storage (waitUntil: the Vercel Functions form of after()). */
import { waitUntil } from 'durable-harness';
import { openWorldStorage } from 'durable-harness/pi-durable';
import { agent, ctx, open } from '../../../lib/pi.ts';

export async function POST(request: Request) {
  const { sessionId, text, requestId = crypto.randomUUID() } = await request.json();
  const storage = await openWorldStorage(sessionId);
  const harness = await open(storage);
  const root = await harness.root(ctx, { agent });
  const submission = await root.submit({ type: 'input', content: text, requestId }, ctx);
  waitUntil(submission.wait(ctx).finally(() => harness.close(ctx)));
  return Response.json({ sessionId: storage.sessionId, submissionId: submission.id });
}
