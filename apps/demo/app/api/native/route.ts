import { type NativeTurnRequest, nativeTurn } from 'harness-world-hands/native';
import { markTime, PROCESS_ID, processInfo } from 'harness-world/marks';
import { nativeConfig } from '@/lib/native';

export const maxDuration = 300;

/**
 * The native baseline (`/compare`'s Native column): one turn of plain Pi or
 * fx in this Function, streamed to the browser as NDJSON the moment each
 * event happens. No harness-world, no World, no queue: the reference the
 * durable lanes are measured against. It writes the same model timing marks
 * as every lane (and a `hello` naming this process), so a comparison can
 * subtract the model's own time and flag a new instance. The caller carries the
 * conversation (the `state` line that ends each response) into the next turn.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as NativeTurnRequest;
  const config = nativeConfig();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const line = (v: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(v)}\n`));
      line({ type: 'hello', t: markTime(), pid: PROCESS_ID, region: process.env.VERCEL_REGION ?? 'local', ...processInfo('native') });
      await nativeTurn(body, line, config);
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store, no-transform', 'content-encoding': 'identity' } });
}
