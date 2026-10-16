import { workspaceTools } from 'harness-world-hands';
import type { GatewayHandler } from 'harness-world-process';
import { codexBinary } from '../src/binary.ts';

/** What the live tests share with their child machines. */

export const LIVE_MODEL = process.env.CODEX_TEST_MODEL ?? 'openai/gpt-5.4-mini';

export const LIVE_INSTRUCTIONS = `You work in a workspace through the tools you are given; there is no other shell.
Keep answers short.
The unsafe_* tools are simulated side effects for tests: when the user asks for a payment or an email, make the call at once, without asking for confirmation.
Your session is durable: it can be interrupted and resumed. Never repeat a payment or an email whose outcome is unknown: report it to the user instead.`;

export const BUILTIN_INSTRUCTIONS = `Keep answers short.
The unsafe_* tools are simulated side effects for tests: when the user asks for a payment or an email, make the call at once, without asking for confirmation.
Your session is durable: it can be interrupted and resumed. Never repeat a payment or an email whose outcome is unknown: report it to the user instead.`;

/** The workspace tools; the unsafe ones take 4 s to "confirm", the window a crash aims at. */
export const liveTools = () => workspaceTools({ confirmMs: 4000 });

/**
 * Whether the live tests can run: a codex binary, and a Gateway credential
 * (`AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, or `CODEX_LIVE=1` from a
 * directory `vercel link` linked, where `@vercel/oidc` mints one).
 */
export function liveAvailable(): boolean {
  if (process.env.CODEX_LIVE === '0') return false;
  return (process.env.CODEX_LIVE === '1' || !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)) && !!codexBinary();
}

/** What one model request through the VM's port looked like (P0.7). */
export interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  model?: string;
  keys?: string[];
  tools?: string[];
  include?: unknown;
}

/** The request as the handler gets it, recorded: header values kept except the bearer (the drive's placeholder, still not printed). */
export function recording(seen: Seen[], handler: GatewayHandler): GatewayHandler {
  return async (request, signal) => {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, /^(authorization|x-api-key|cookie)$/i.test(k) ? '<redacted>' : v.slice(0, 120)]));
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
    } catch {}
    seen.push({
      method: request.method,
      path: request.path,
      headers,
      ...(typeof body?.model === 'string' ? { model: body.model } : {}),
      ...(body ? { keys: Object.keys(body).sort() } : {}),
      ...(Array.isArray(body?.tools) ? { tools: [...new Set((body.tools as { type?: string }[]).map((t) => String(t.type)))] } : {}),
      ...(body?.include !== undefined ? { include: body.include } : {}),
    });
    if (process.env.P07_VERBOSE) console.log('[P0.7 raw]', JSON.stringify(seen.at(-1)), body ? JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => !['input', 'instructions', 'tools'].includes(k)))).slice(0, 1500) : '');
    return handler(request, signal);
  };
}

/** The distinct request shapes, for P0.7's log. */
export function report(seen: Seen[]): void {
  const shapes = new Map<string, Seen & { count: number }>();
  for (const s of seen) {
    const key = JSON.stringify([s.method, s.path, Object.keys(s.headers).sort(), s.model, s.keys, s.tools, s.include]);
    const had = shapes.get(key);
    if (had) had.count++;
    else shapes.set(key, { ...s, count: 1 });
  }
  for (const s of shapes.values()) console.log('[P0.7]', JSON.stringify(s));
}
