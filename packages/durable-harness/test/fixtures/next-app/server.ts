/**
 * Stands in for the Next.js server of fixtures/next-app (test/pi-durable-next.test.ts):
 * it loads the flow route withDurableHarness generated (as the flow Function
 * does) and the chat route.
 *
 *   server.ts run        POST a message to the chat route (the tool hangs; the test kills this process)
 *   server.ts restart <id>   the server started again: the first request makes the World, which recovers the session
 */
import { getWorld } from 'durable-harness';
import { openWorldReader } from 'durable-harness/pi-durable';

const [mode, sessionId] = process.argv.slice(2);
const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ pid: process.pid, ...line })}\n`);
const flow = (await import(new URL('./app/.well-known/workflow/v1/flow/route.js', import.meta.url).href)) as { POST: unknown };
say({ flowRoute: typeof flow.POST });

if (mode === 'run') {
  const chat = (await import('./app/api/chat/route.ts')) as { POST: (r: Request) => Promise<Response> };
  const res = await chat.POST(new Request('http://localhost/api/chat', { method: 'POST', body: JSON.stringify({ text: 'Look up order 1234.' }) }));
  say(await res.json());
} else {
  await getWorld();
  const reader = openWorldReader(sessionId!);
  for (;;) {
    await reader.refresh();
    const snap = await reader.snapshot();
    if (!snap.unfinished && snap.entries.at(-1)?.kind === 'pi.assistant') {
      say({ recovered: true, transcript: JSON.stringify(snap.entries), starts: snap.tasks.find((t) => t.kind === 'pi.tool')?.starts.length });
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
