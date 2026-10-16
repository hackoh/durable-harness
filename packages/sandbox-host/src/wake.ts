import { commitHandoff, currentLane, type HostFact, hostOf, markHostLost, type SessionLog } from 'harness-world';
import { pushToken, tokenNeedsPush } from './token.ts';

export type HostWake = { woke: true; ms: number } | { woke: false; reason: string; handedTo?: 'function' };

export interface WakeHostOptions {
  /** The daemon's secret for a host fact (derived server-side). */
  secretFor(fact: HostFact): string | undefined;
  /** First probe; default 500 ms. */
  timeoutMs?: number;
  /**
   * A probe that only timed out (no connection error) is retried once with
   * this bound (default 1500 ms) before the host is called lost: a cold TLS
   * connection or a GC pause is slow, not dead.
   */
  retryTimeoutMs?: number;
  /** A fresh OIDC token for the daemon (`POST /token`) when its own is near or past expiry. */
  freshToken?: () => Promise<string | undefined>;
  why?: string;
  fetch?: typeof fetch;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

type Probe =
  | { kind: 'woke'; tokenExp?: number }
  | { kind: 'slow' }
  | { kind: 'unreachable'; error: string }
  | { kind: 'refused'; status: number; expired: boolean };

const isTimeout = (err: unknown) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

/**
 * Wake the sandbox lane: `POST /wake` to the session's daemon,
 * which must answer 202. A connection error or a refusal (not attached, an
 * expired token that a push cannot fix) means the host is lost; a probe that
 * only ran out of time is retried once with a longer bound first. A lost
 * host is marked lost (naming the boot that was probed) and the session
 * handed to the function lane at once (epoch + 1, `sandbox host
 * unreachable`). The caller wakes the function lane. A live daemon's drives
 * are backed by the tether the caller sends with this wake (tether.ts in
 * harness-world): this probe is the fast path, never the backstop.
 */
export async function wakeHostLane(log: SessionLog, options: WakeHostOptions): Promise<HostWake> {
  const say = options.log ?? (() => {});
  const doFetch = options.fetch ?? fetch;
  const fact = hostOf(log.state);
  const t0 = Date.now();
  if (fact) {
    const secret = options.secretFor(fact) ?? '';
    const probe = async (timeoutMs: number): Promise<Probe> => {
      try {
        const res = await doFetch(`${fact.url}/wake`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ runId: log.runId, why: options.why ?? 'wake' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await res.json().catch(() => ({}))) as { tokenExp?: number; error?: string };
        if (res.status === 202) return { kind: 'woke', ...(typeof body.tokenExp === 'number' ? { tokenExp: body.tokenExp } : {}) };
        return { kind: 'refused', status: res.status, expired: res.status === 503 && body.error === 'token expired' };
      } catch (err) {
        return isTimeout(err) ? { kind: 'slow' } : { kind: 'unreachable', error: String(err) };
      }
    };
    const push = async () => {
      const token = await options.freshToken?.();
      if (!token) return false;
      return (await pushToken(fact.url, secret, token, doFetch).catch(() => ({ ok: false }))).ok;
    };
    let result = await probe(options.timeoutMs ?? 500);
    if (result.kind === 'slow') {
      say('host wake slow: retrying once', { runId: log.runId, bootId: fact.bootId });
      result = await probe(options.retryTimeoutMs ?? 1500);
    }
    if (result.kind === 'refused' && result.expired && (await push())) {
      say('host token expired: pushed a fresh one', { runId: log.runId, bootId: fact.bootId });
      result = await probe(options.retryTimeoutMs ?? 1500);
    }
    if (result.kind === 'woke') {
      if (tokenNeedsPush(result.tokenExp)) void push().catch(() => {});
      return { woke: true, ms: Date.now() - t0 };
    }
    say('host wake failed', { runId: log.runId, bootId: fact.bootId, ...result });
    await markHostLost(log, `wake probe: ${result.kind}`, { vm: fact.vm, bootId: fact.bootId }).catch(() => {});
  }
  const reason = fact ? 'host unreachable' : 'no host';
  if (currentLane(log.state) !== 'sandbox') return { woke: false, reason };
  const { won } = await commitHandoff(
    log,
    { from: 'sandbox', to: 'function', reason: fact ? 'sandbox host unreachable' : 'no sandbox host' },
    log.state.epoch
  );
  return { woke: false, reason, ...(won ? { handedTo: 'function' as const } : {}) };
}
