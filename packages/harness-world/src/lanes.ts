import type { Lane, SessionState } from './types.ts';

/** Lanes from least to most capable (legacy ladder; routing uses `LANE_SPECS`). */
export const LANES: readonly Lane[] = ['browser', 'function', 'sandbox'];
export const laneRank = (lane: Lane) => LANES.indexOf(lane);

/**
 * What a lane can do. `workspace`: the session's files (the
 * fold, just-bash). `gateway`: model calls. `machine`: a real Linux machine
 * (`sandbox_exec`). `secrets`: backend-only credentials (`lookup_customer`).
 */
export type Capability = 'workspace' | 'gateway' | 'machine' | 'secrets';

export interface LaneSpec {
  /** What the lane does natively. */
  caps: readonly Capability[];
  /** What it can also do remotely (the function lane runs `sandbox_exec` through the detached path). */
  remote?: readonly Capability[];
}

export const LANE_SPECS: Record<Lane, LaneSpec> = {
  browser: { caps: ['workspace', 'gateway'] },
  sandbox: { caps: ['workspace', 'gateway', 'machine'] },
  function: { caps: ['workspace', 'gateway', 'secrets'], remote: ['machine'] },
};

/** `EffectOptions.requires` (one release of compatibility) as capabilities. */
export function needsOf(opts: { needs?: readonly Capability[]; requires?: Lane }): Capability[] {
  if (opts.needs) return [...opts.needs];
  if (opts.requires === 'function') return ['secrets'];
  if (opts.requires === 'sandbox') return ['machine'];
  return [];
}

const covers = (caps: readonly Capability[], needs: readonly Capability[]) => needs.every((n) => caps.includes(n));

/** Lanes a capability decision may move a session to, in order of preference (never the tab: it wakes itself). */
const TARGETS: readonly Lane[] = ['sandbox', 'function'];

/**
 * Where an effect that `needs` these capabilities runs, from lane `here`
 *: `undefined` to run here (natively, or remotely when `here`
 * covers them that way and no lane covers them natively), else the lane to
 * hand the session to. `available` says whether a lane can take the session
 * right now (`sandbox`: a live host); default all.
 */
export function route(
  needs: readonly Capability[],
  here: Lane,
  available: (lane: Lane) => boolean = () => true
): Lane | undefined {
  if (needs.length === 0 || covers(LANE_SPECS[here].caps, needs)) return undefined;
  for (const lane of TARGETS) {
    if (lane !== here && covers(LANE_SPECS[lane].caps, needs) && available(lane)) return lane;
  }
  const spec = LANE_SPECS[here];
  if (covers([...spec.caps, ...(spec.remote ?? [])], needs)) return undefined;
  for (const lane of TARGETS) {
    const s = LANE_SPECS[lane];
    if (lane !== here && covers([...s.caps, ...(s.remote ?? [])], needs) && available(lane)) return lane;
  }
  // Nothing can: run here and let the effect fail on its own terms.
  return undefined;
}

/** The `host` fact: an in-VM daemon that drives the `sandbox` lane. */
export interface HostFact {
  lane: 'sandbox';
  /** `https://…` of the daemon's control API (not secret). */
  url: string;
  /** The VM (sandbox name). */
  vm: string;
  /** One per daemon start (a resumed VM gets a new one). */
  bootId: string;
  /** `HOST_VERSION`: the bundle's content hash. */
  version: string;
  environment?: string;
  /** When the daemon was confirmed healthy (ms). */
  at: number;
  /** Set by a fact that marks this host gone (a failed probe, a takeover). */
  lost?: { reason: string; at: number };
}

/**
 * The session's sandbox host, if one attached and was not marked lost since.
 * Resolved per boot: the newest attach wins, and it is lost only if a lost
 * mark naming that same vm and bootId was written after it. A late lost mark
 * for an older boot never hides a newer one, and a boot marked lost can
 * re-attach (a new attach fact supersedes the mark).
 */
export function hostOf(state: SessionState): HostFact | undefined {
  const order = state.effectOrder;
  for (let i = order.length - 1; i >= 0; i--) {
    const e = order[i]!;
    if (e.name !== 'host') continue;
    const fact = (e.output ?? e.input) as HostFact | undefined;
    if (!fact || fact.lost) continue;
    for (let j = i + 1; j < order.length; j++) {
      const later = order[j]!;
      if (later.name !== 'host') continue;
      const mark = (later.output ?? later.input) as HostFact | undefined;
      if (mark?.lost && mark.vm === fact.vm && mark.bootId === fact.bootId) return undefined;
    }
    return fact;
  }
  return undefined;
}

/** Default availability: the tab and functions always; the sandbox lane while a host is attached. */
export function laneAvailable(state: SessionState, lane: Lane): boolean {
  return lane !== 'sandbox' || !!hostOf(state);
}

/** The lane a session settles in when idle: `home` on its `run_created`, else the lanes' `settle`. */
export function homeLane(state: SessionState, lanes?: Pick<LaneOptions, 'settle' | 'initial'>): Lane | undefined {
  const home = (state.config as { home?: unknown } | undefined)?.home;
  if (home === 'browser' || home === 'function' || home === 'sandbox') return home;
  return lanes?.settle;
}

/**
 * Multi-lane sessions. When set (on the driver, or on a harness so only that
 * harness's sessions move), the driver admits a delivery only while the
 * session's current lane (a fold of `handoff` steps) is one of `serves`; an
 * effect that `requires` a more capable lane commits a `handoff` step and
 * stops; and when the session goes idle in a lane other than `settle`, it
 * hands back to `settle`. `wake` is how the lane that committed a handoff
 * gets the next lane to pick the session up.
 */
export interface LaneOptions {
  /** Lanes this driver can drive. */
  serves: Lane[];
  /** Lane of a session that has never handed off. Default `browser`. */
  initial?: Lane;
  /** Lane to hand back to when the session goes idle (a session's own `home` wins). */
  settle?: Lane;
  /**
   * Whether lane `lane` can take the session now (capability routing, rule
   * 2). Default: every lane (`laneAvailable` is the host-aware choice).
   */
  available?(lane: Lane, state: SessionState): boolean;
  /**
   * Get lane `to` to pick the session up. Resolves once the wake is sent
   * (the mover of a handoff wakes the next lane before it lets go of its
   * delivery). `opts.idempotencyKey` overrides the default key: a re-wake is
   * keyed by its cause (a redelivery, a settlement), so a queue's dedup
   * window never swallows it.
   */
  wake(runId: string, to: Lane, handoff: HandoffOutput, opts?: { idempotencyKey?: string }): Promise<void>;
  /**
   * Lanes driven where this driver cannot wake them (a tab, whose queue is
   * page memory): a delivery that finds the session in one of them with
   * submissions waiting and nothing running takes the session into
   * `serves[0]`, instead of leaving them for a tab that may not exist.
   */
  remote?: Lane[];
}

/** What a `handoff` step records. */
export interface HandoffOutput {
  from: Lane;
  to: Lane;
  reason: string;
  /** The effect that could not run in `from`, if the handoff was an escalation. */
  forKey?: string;
}

/**
 * Where the session is driven right now: the `to` of the last accepted
 * `handoff` step, or `initial` if there is none. A handoff takes effect at
 * its intent, not its outcome: the epoch moves then (so the lane it left is
 * fenced from that point), and a writer that died between the two writes
 * leaves the session in the lane it named, not in limbo. A pure fold of the
 * log, so every lane agrees on it without talking to each other.
 */
export function currentLane(state: SessionState, initial: Lane = 'browser'): Lane {
  const last = state.effectOrder.findLast((e) => e.name === 'handoff');
  if (!last) {
    // A session created to live in another lane (`home`) starts there.
    const home = (state.config as { home?: unknown } | undefined)?.home;
    return home === 'function' || home === 'sandbox' ? home : initial;
  }
  return ((last.output ?? last.input) as HandoffOutput).to;
}

/**
 * Steps that move the epoch: a `handoff` (the session changes lane) and a
 * `recover` (a delivery takes over intents whose holder is gone, in the
 * same lane). Both share the `handoff:<epoch>` memo key, so at most one of
 * them is accepted per epoch, and every intent the previous driver writes
 * after it is fenced.
 */
export const isEpochStep = (name: string) => name === 'handoff' || name === 'recover';

/** Accepted handoffs so far, which is also the session's epoch (see `SessionState.epoch`). */
export function handoffCount(state: SessionState): number {
  return state.epoch;
}
