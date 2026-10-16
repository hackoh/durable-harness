/**
 * The Function's side of `/model` (docs/workspaces.md §5.5): every request the
 * CLI sends to the VM's loopback model port arrives here as a world-remote
 * `/model` request, and goes to the harness's `GatewayHandler` (harness-process'
 * `gatewayHandler`: the fixed table, the body checks, the budget, the
 * credential). The tunnel adds nothing of its own to the request: the method
 * and path are passed on as text for the handler to match, never as a URL.
 *
 * A failure goes back as one of the six fixed codes only (world-remote's
 * adapter 5 sends `code`, never `message`); the relay turns it into a status
 * the CLI understands (400, 403, a spend cap's 403, the concurrency cap's
 * 429, 502, 500). Without a handler, every call fails `internal`.
 */
import type { GatewayErrorCode, GatewayHandler } from 'harness-world-process';
import type { WsRequestHandler } from 'harness-world-remote/ws';

const CODES = new Set<GatewayErrorCode>(['bad_request', 'forbidden', 'budget', 'busy', 'upstream', 'internal']);

/** An error that carries only a fixed code to the VM. */
function fixed(code: GatewayErrorCode): Error {
  return Object.assign(new Error(code), { code });
}

/** Serve the VM's model calls with `handler`. */
export function modelTunnel(handler: GatewayHandler | undefined): WsRequestHandler {
  return async (request, signal) => {
    if (!handler) throw fixed('internal');
    const body = request.body === undefined ? new Uint8Array() : typeof request.body === 'string' ? new TextEncoder().encode(request.body) : request.body;
    try {
      const response = await handler({ method: request.method, path: request.path, headers: request.headers, body }, signal);
      return { status: response.status, headers: { ...response.headers }, body: response.body };
    } catch (err) {
      const code = (err as { code?: unknown } | undefined)?.code;
      throw fixed(typeof code === 'string' && CODES.has(code as GatewayErrorCode) ? (code as GatewayErrorCode) : 'internal');
    }
  };
}
