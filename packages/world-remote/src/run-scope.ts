/**
 * One client, one run: what a World call touches, and a capability token
 * bound to a run id that an endpoint checks per call (`runScope`, for
 * `createWorldHandler`'s `authorize`). A browser tab driving its own
 * session gets a token for that session's run: every op it sends is about
 * that run (its events, its streams, its hooks by token), and nothing else
 * (no `runs.list`, no other run's log) is served.
 *
 * No Node APIs: WebCrypto only, so the client half (`runOf`) loads in a
 * browser, and the server half on any runtime.
 */

/** One call as the endpoint parsed it: the op and its positional arguments. */
export interface WorldCall {
  op: string;
  args: readonly unknown[];
}

/** Ops about no run: the fronted World's own description. */
const RUNLESS = new Set(['info', 'getDeploymentId']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined);
const runIdOf = (params: unknown): string | undefined => (typeof params === 'object' && params !== null ? str((params as { runId?: unknown }).runId) : undefined);

/** A harness-world hook token: `harness:<runId>:<kind>` (the inbox, the docs hook). */
const HOOK_TOKEN = /^harness:([^:\s]{1,200}):[a-z][a-z0-9_-]{0,31}$/;

/**
 * The run a call is about: a run id, `null` for a call about no run
 * (`info`, `getDeploymentId`), or `undefined` when no single run can be
 * told from its arguments (`runs.list`, `hooks.get` by hook id,
 * `events.listByCorrelationId`, a hook token of another shape, a missing
 * run id). A run-scoped endpoint refuses an `undefined`.
 */
export function runOf(op: string, args: readonly unknown[]): string | null | undefined {
  if (RUNLESS.has(op)) return null;
  switch (op) {
    case 'runs.get':
    case 'steps.get':
    case 'events.create':
    case 'events.get':
    case 'streams.write':
    case 'streams.writeMulti':
    case 'streams.close':
    case 'streams.getChunks':
    case 'streams.getInfo':
    case 'streams.list':
    case 'streams.get':
      return str(args[0]);
    case 'steps.list':
    case 'hooks.list':
    case 'events.list':
      return runIdOf(args[0]);
    case 'hooks.getByToken': {
      const token = str(args[0]);
      return token ? HOOK_TOKEN.exec(token)?.[1] : undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tokens

/** Where a client sends its run token. */
export const RUN_TOKEN_HEADER = 'x-harness-run-token';

const PREFIX = 'hwr1';
const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const pad = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

const keys = new Map<string, Promise<CryptoKey>>();

/** An HMAC key derived from `secret` for run tokens only (HKDF, its own info), so the secret can serve other uses too. */
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('harness-world-remote'), info: enc.encode('run-token/v1') },
        base,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify']
      );
    })();
    keys.set(secret, key);
    if (keys.size > 16) keys.delete(keys.keys().next().value!);
  }
  return key;
}

/** A run token's claims. */
export interface RunTokenClaims {
  runId: string;
  /** Expiry, epoch ms. */
  expiresAt: number;
}

/**
 * A token for one run: `hwr1.<payload>.<sig>`, HMAC-SHA256 over the run id
 * and the expiry with a key derived from a server-only `secret`. Default
 * lifetime one hour.
 */
export async function mintRunToken(secret: string, runId: string, options: { ttlSeconds?: number; now?: number } = {}): Promise<{ token: string } & RunTokenClaims> {
  if (!secret) throw new TypeError('harness-world-remote: mintRunToken needs a secret');
  if (!str(runId)) throw new TypeError('harness-world-remote: mintRunToken needs a run id');
  const x = Math.floor((options.now ?? Date.now()) / 1000) + (options.ttlSeconds ?? 3600);
  const body = `${PREFIX}.${b64url(enc.encode(JSON.stringify({ r: runId, x })))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return { token: `${body}.${b64url(sig)}`, runId, expiresAt: x * 1000 };
}

/** The token's claims, if its signature is valid and it has not expired. */
export async function verifyRunToken(secret: string, token: string, now = Date.now()): Promise<RunTokenClaims | undefined> {
  if (!secret || typeof token !== 'string' || token.length > 2048) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return undefined;
  let sig: Uint8Array;
  let payload: { r?: unknown; x?: unknown };
  try {
    sig = fromB64url(parts[2]!);
    payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))) as typeof payload;
  } catch {
    return undefined;
  }
  // Constant time: crypto.subtle.verify.
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return undefined;
  const runId = str(payload?.r);
  if (!runId || typeof payload.x !== 'number' || !Number.isFinite(payload.x)) return undefined;
  if (payload.x * 1000 <= now) return undefined;
  return { runId, expiresAt: payload.x * 1000 };
}

// ---------------------------------------------------------------------------
// The endpoint's check

export interface RunScopeOptions {
  /** The server-only secret tokens are minted with (`mintRunToken`). */
  secret: string;
  /**
   * More checks on a call its token covers (the run is the token's): what
   * an app's endpoint refuses even on the token's own run, such as a
   * `run_created` for a harness it does not serve, or a write to a stream
   * only the server writes. Default: admit.
   */
  admit?(call: WorldCall, runId: string): boolean | Promise<boolean>;
}

/**
 * `createWorldHandler`'s `authorize` for run-scoped clients: a call about
 * no run passes; a call about a run passes only with a valid token for that
 * run in `x-harness-run-token` (and `admit`'s say); a call that is about
 * no single run (`runs.list`, a hook by id, ...) never passes.
 */
export function runScope(options: RunScopeOptions): (req: Request, call: WorldCall) => Promise<boolean> {
  if (!options.secret) throw new TypeError('harness-world-remote: runScope needs a secret');
  return async (req, call) => {
    const runId = runOf(call.op, call.args);
    if (runId === null) return true;
    if (runId === undefined) return false;
    const claims = await verifyRunToken(options.secret, req.headers.get(RUN_TOKEN_HEADER) ?? '');
    if (claims?.runId !== runId) return false;
    return options.admit ? !!(await options.admit(call, runId)) : true;
  };
}
