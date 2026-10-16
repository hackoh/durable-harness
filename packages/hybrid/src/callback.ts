import { claimDropCallback, isDetached, type OwnerContext, SessionLog } from 'harness-world';
import { collectParked } from './sandbox-collect.ts';
import { MAX_REPORT_BYTES, parseReport } from './sandbox-job.ts';
import type { SandboxOwner, SandboxProvider } from './sandbox-sync.ts';

type World = OwnerContext['world'];

/**
 * The sandbox's way back: `POST /api/hybrid/sandbox-result`.
 *
 * A finished command's wrapper POSTs its `result.json` here with a
 * capability token minted for that one step (`hsr1.<payload>.<sig>`: HMAC
 * over run, step, sandbox and expiry with a key derived from a server-only
 * secret). The VM never holds a World credential, an AI Gateway key or an
 * OIDC token: the token only lets it say "step S of run R finished", and the
 * endpoint reads the workspace diff from the VM itself. It collects the step
 * (iff it is still parked, running and unsettled), then wakes the lane.
 */

export interface ResultTokenPayload {
  /** runId */
  r: string;
  /** the parked tool's stepId */
  s: string;
  /** sandbox name */
  n: string;
  /** expiry, unix seconds */
  x: number;
}

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

function fromB64url(s: string): Uint8Array {
  const pad = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('harness-on-world'), info: enc.encode('sandbox-result/v1') },
        base,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify']
      );
    })();
    keys.set(secret, key);
  }
  return key;
}

export async function mintResultToken(secret: string, payload: ResultTokenPayload): Promise<string> {
  const body = `hsr1.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** The token's payload if its signature is valid and it has not expired. */
export async function verifyResultToken(secret: string, token: string, now = Date.now()): Promise<ResultTokenPayload | undefined> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'hsr1') return undefined;
  let sig: Uint8Array;
  let payload: ResultTokenPayload;
  try {
    sig = fromB64url(parts[2]!);
    payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))) as ResultTokenPayload;
  } catch {
    return undefined;
  }
  // Constant time: crypto.subtle.verify.
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return undefined;
  if (typeof payload?.r !== 'string' || typeof payload.s !== 'string' || typeof payload.n !== 'string' || typeof payload.x !== 'number') {
    return undefined;
  }
  if (payload.x * 1000 < now) return undefined;
  return payload;
}

export interface SandboxResultOptions {
  world: World;
  provider: SandboxProvider;
  /** `HYBRID_CALLBACK_SECRET`. */
  secret: string;
  /** Wake the lane that takes the settlement (keyed per step). */
  wake(runId: string, stepId: string): Promise<void>;
  /** Honor an armed Drop Callback crash. Default true. */
  chaos?: boolean;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

/** The endpoint's whole behavior (the route is a thin wrapper around this). */
export async function handleSandboxResult(request: Request, options: SandboxResultOptions): Promise<Response> {
  const say = options.log ?? (() => {});
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const claim = token ? await verifyResultToken(options.secret, token) : undefined;
  if (!claim) return json(401, { error: 'invalid or expired token' });

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_REPORT_BYTES) return json(413, { error: `report over ${MAX_REPORT_BYTES} bytes` });
  let report;
  try {
    report = parseReport(JSON.parse(new TextDecoder().decode(raw)));
  } catch {}
  if (!report) return json(400, { error: 'expected a sandbox_exec wrapper report (v1)' });

  const log = new SessionLog(options.world, claim.r);
  try {
    await log.refresh();
  } catch {
    return json(404, { error: 'no such session' });
  }
  const record = log.state.effectOrder.find((r) => r.stepId === claim.s);
  if (!record) return json(404, { error: 'no such step in this session' });
  if (record.status !== 'running' || record.settlement) return json(200, { state: 'already' });
  // A command faster than the park write: the step has no owner yet.
  if (!record.park) return json(409, { error: 'not parked yet' }, { 'retry-after': '1' });
  const owner = record.park as SandboxOwner;
  if (owner.sandbox !== claim.n) return json(401, { error: 'token is for another sandbox' });

  if (options.chaos !== false && (await claimDropCallback(log, record))) {
    say('chaos: dropped the result report', { runId: claim.r, stepId: claim.s });
    return json(202, { state: 'dropped' });
  }
  const outcome = await collectParked(options.world, options.provider, log, record, 'push', { report });
  if (outcome === 'running' || outcome === 'unknown') {
    // The VM did not answer the diff read: the step's owner check finishes it.
    return json(202, { state: 'deferred' });
  }
  if (outcome === 'already') return json(200, { state: 'already' });
  // The drive that parked this step may still be attached to it (its inline
  // grace, which saw the same exit): it takes the settlement itself, and a
  // wake now would start a second drive at the same epoch. The log orders
  // its `detach` against this settle: attached in the fold right after the
  // settle means the parker takes it if it lives, and if it died, its own
  // message's redelivery re-enters the settled step. Nothing to arm.
  const now = log.state.effects.get(record.key);
  if (now?.stepId === record.stepId && now.status === 'running' && now.park && !isDetached(now)) {
    say('sandbox: result pushed; the parking drive is still attached, so no wake', { runId: claim.r, stepId: claim.s });
    return json(200, { state: 'settled' });
  }
  await options.wake(claim.r, claim.s).catch((err) => say('wake failed after a push', { runId: claim.r, error: String(err) }));
  say('sandbox: result pushed', { runId: claim.r, stepId: claim.s, outcome });
  return json(200, { state: 'settled' });
}
