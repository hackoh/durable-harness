import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in AI Gateway for real OpenCode: each language-model request gets
 * the next scripted reply (AI SDK stream parts over SSE), and every request
 * body is kept, so a test can read what the model was shown (its system
 * prompt, its tools, each tool result).
 */

type Part = Record<string, unknown>;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/** A reply that calls one tool. */
export const toolCall = (id: string, name: string, input: unknown): Part[] => [
  { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
];

/** A reply that says `text` and ends the turn. */
export const text = (t: string): Part[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: t },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
];

export interface ScriptedGateway {
  url: string;
  /** Every language-model request body, in order. */
  requests: any[];
  /** Replies still to give. */
  script: ((body: any) => Part[])[];
  close(): Promise<void>;
}

export async function scriptedGateway(script: ((body: any) => Part[])[] = []): Promise<ScriptedGateway> {
  const requests: any[] = [];
  const gw: ScriptedGateway = { url: '', requests, script, close: async () => {} };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes('language-model')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      const parsed = body ? JSON.parse(body) : {};
      requests.push(parsed);
      const next = gw.script.shift();
      const parts = next ? next(parsed) : text('(the script is over)');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([...parts.map((p) => `data: ${JSON.stringify(p)}`), 'data: [DONE]', ''].join('\n\n'));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  gw.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  gw.close = () => new Promise<void>((r) => server.close(() => r()));
  return gw;
}

/** The text of every tool result the model was sent in `body`, by call id. */
export function toolResults(body: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body?.prompt ?? []) {
    if (m?.role !== 'tool') continue;
    for (const part of m.content ?? []) {
      if (part?.type !== 'tool-result') continue;
      const o = part.output;
      const t =
        o?.type === 'text' || o?.type === 'error-text'
          ? String(o.value)
          : o?.type === 'content'
            ? (o.value ?? []).map((v: any) => (v?.type === 'text' ? v.text : '')).join('\n')
            : JSON.stringify(o?.value ?? o);
      out.set(part.toolCallId, t);
    }
  }
  return out;
}
