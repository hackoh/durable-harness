import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for a model API, for the process harnesses' scripted tests: the
 * fake CLIs send their "model" text here (through the drive's gateway proxy,
 * as a real CLI sends its model requests), and it streams the text back in
 * pieces, as server-sent events. That gives the drive real model requests to
 * see (`ModelSteps`) and a model stream a crash drill can cut.
 *
 * A request is a POST whose JSON body has `text` (or, shaped as a Responses
 * request, `input` messages: the last `input_text` part is the text); the response is
 * `text/event-stream`, one `data: {"delta": "<piece>"}` event per 12
 * characters, each after `pieceMs(text)` milliseconds, then `data: [DONE]`.
 * With `cost`, the last piece's event also carries the Gateway's cost
 * metadata (`provider_metadata.gateway.gatewayCost`, P0.18), as a real
 * response's last events do, so a `gatewayHandler` budget sees it.
 */

export interface FakeModel {
  /** Its base URL: give it to the harness as the Gateway it proxies to. */
  url: string;
  /** Every request it got, in order. */
  requests: { path: string; text: string; completed: boolean }[];
  close(): Promise<void>;
}

export interface FakeModelOptions {
  /** How long each piece of `text` takes. Default 5 ms. */
  pieceMs?: (text: string) => number;
  /** The Gateway cost each response reports, in US dollars (a decimal string, as the Gateway sends it). Default none. */
  cost?: string;
}

export async function fakeModel(options: FakeModelOptions = {}): Promise<FakeModel> {
  const requests: FakeModel['requests'] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let text = '';
    try {
      const parsed = JSON.parse(body) as { text?: unknown; input?: unknown };
      text = typeof parsed.text === 'string' ? parsed.text : inputText(parsed.input);
    } catch {}
    const seen = { path: req.url ?? '/', text, completed: false };
    requests.push(seen);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ms = options.pieceMs?.(text) ?? 5;
    const pieces = text.match(/[\s\S]{1,12}/g) ?? [];
    for (const [i, piece] of pieces.entries()) {
      await new Promise((r) => setTimeout(r, ms));
      if (res.destroyed) return;
      const last = i === pieces.length - 1 && options.cost !== undefined;
      res.write(`data: ${JSON.stringify({ delta: piece, ...(last ? { provider_metadata: { gateway: { gatewayCost: options.cost } } } : {}) })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
    seen.completed = true;
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}

/** The text of a Responses `input`: its last message's last `input_text` part. */
function inputText(input: unknown): string {
  if (!Array.isArray(input)) return '';
  for (let i = input.length - 1; i >= 0; i--) {
    const content = (input[i] as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j] as { type?: unknown; text?: unknown };
      if (part?.type === 'input_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

/**
 * A fake CLI's side: send `text` to the model at `url` and call `onDelta`
 * with each piece as it streams back. Resolves with the whole text; rejects
 * if the stream is cut.
 */
export async function streamFromModel(url: string, text: string, onDelta: (delta: string) => void, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder', ...headers },
    body: JSON.stringify({ text }),
  });
  if (!res.ok || !res.body) throw new Error(`the model answered ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let said = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
      const event = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = event.startsWith('data: ') ? event.slice(6) : '';
      if (data === '[DONE]') return said;
      if (!data) continue;
      const delta = String((JSON.parse(data) as { delta?: unknown }).delta ?? '');
      said += delta;
      onDelta(delta);
    }
  }
  throw new Error('the model stream was cut');
}
