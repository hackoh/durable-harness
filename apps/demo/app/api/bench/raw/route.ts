import { processInfo, rawSessions } from 'harness-world';
import { type RawTurnRequest, rawTurn } from 'harness-world-bench/raw-turn';
import { plainHarnesses } from '@/lib/sessions';

export const maxDuration = 300;

/**
 * Durability off, in a Function: the same Pi / fx harness the durable server
 * lane runs, with no World at all (harness-world `rawSessions`). The baseline
 * the benchmark (and the page's "Durability: Off" in Server mode) measures
 * the durable lane against, in the same place.
 *
 * A Function holds no session between requests, so the caller carries it:
 * each request takes the session's in-memory state (`snapshot`, from the
 * previous response) plus the next submission, drives one busy period, and
 * streams the live events back as NDJSON, ending with the new snapshot.
 * `script` submits more messages from inside the same invocation (a steer
 * the moment the tool starts), for measurements that need no extra hop.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as RawTurnRequest;
  // `?lane=vm` (the raw turn inside a session's brain-in-VM daemon) went with that lane.
  if (new URL(request.url).searchParams.get('lane') === 'vm') return Response.json({ error: 'the brain-in-VM lane is retired' }, { status: 404 });
  const raw = rawSessions({ harness: plainHarnesses(), log: (m, f) => console.log(`[raw] ${m}`, f ?? '') });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await rawTurn(raw, body, (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)), { region: process.env.VERCEL_REGION, ...processInfo('raw') });
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store, no-transform', 'content-encoding': 'identity' } });
}
