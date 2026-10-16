import type { World } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { crashedByChaos } from './chaos.ts';
import { isEpochStep } from './lanes.ts';
import type { EffectRecord, SessionState } from './types.ts';

/**
 * Liveness is the queue's, never ours.
 *
 * A drive runs under exactly one *anchor*: the thing whose loss means the
 * drive is gone. For a queue delivery that is its own message: the queue
 * library keeps the message locked while the handler runs (`@vercel/queue`
 * extends the lease; Cloudflare's run object, world-local's process and
 * world-browser's leader tab hold it by construction), and a handler that
 * dies loses the lock, so the queue redelivers that same message. Every
 * intent a drive writes records its anchor once, when it is written. Nothing
 * about liveness is ever written again: no beats, probes, leases or idle
 * lines.
 *
 * A delivery that finds a running intent asks one question of it
 * (`anchorVerdict`):
 *
 * - `mine`: the intent is anchored to this delivery's own message (this is
 *   its redelivery, so the previous holder lost the lock), or to the anchor a
 *   continuation handed over. Recover at once, fenced.
 * - `gone`: the log or the World proves its holder gone: its drive closed
 *   (`close` fact), the epoch moved past it by another writer, a crash record
 *   names its drive, its drive's deadline passed, or the World's own proof
 *   (a dead pid on world-local, any other message on Cloudflare's
 *   one-delivery-per-run object, a free Web Lock in a tab). Recover at once.
 * - `covered`: anything else. Ack: its holder takes the work if it lives,
 *   and its message comes back if it died.
 *
 * Drives that hold no queue message are tethered to one: a direct drive (the
 * drive route) declares a deadline by which it stops writing, and a queue
 * message delayed past that deadline stands behind it (`deadline` anchors);
 * a sandbox daemon's drives are held by a flow-route delivery that keeps a
 * request open to the daemon (tether.ts); a tab's by a held request to a
 * server Function whose close is the callback (tab-lost).
 */
export type AnchorKind = 'msg' | 'deadline' | 'tab' | 'host';

/** The process that holds an anchor, where the World's lock is the process (world-local, world-postgres). */
export interface ProcessIdentity {
  pid: number;
  /** One per process start: tells a reused pid from the one that wrote the anchor. */
  boot: string;
  host: string;
  /** Process start time (ms since the epoch), for the pid-reuse check. */
  start: number;
}

export interface Anchor {
  k: AnchorKind;
  /** The messageId (`msg`), the direct drive's id (`deadline`), the tab id (`tab`), the daemon boot (`host`). */
  m: string;
  /** `deadline`: the drive writes nothing after this time (server clock, ms since the epoch). */
  at?: number;
  /** The process holding it, on Worlds whose lock is the process. */
  proc?: ProcessIdentity;
  /** `tab`: the browser profile (Web Locks are per profile). */
  profile?: string;
}

export const anchorKey = (a: Pick<Anchor, 'k' | 'm'>): string => `${a.k}:${a.m}`;

export type Verdict =
  | { v: 'mine'; why: string; fence: true }
  | { v: 'gone'; why: string; fence: boolean }
  | { v: 'covered'; why: string; fence: false };

export interface VerdictContext {
  world: World;
  policy: AnchorPolicy;
  /** This delivery's anchor. */
  own: Anchor;
  /** The anchor (`anchorKey`) a continuation handed this delivery, if it is one. */
  continues?: string;
  state: SessionState;
  now?: number;
}

/**
 * How a World holds its deliveries, and what it can prove about a holder it
 * cannot see. Pick the one matching the World (`DriverOptions.anchors`); the
 * default reads the environment (see `defaultAnchors`).
 */
export interface AnchorPolicy {
  readonly name: string;
  /** This delivery's anchor, from its queue metadata. */
  own(meta: { messageId?: string; queueName?: string }): Anchor;
  /**
   * The anchor of a drive that holds no queue message (`sessions.drive()`),
   * which stops writing by `at`; `companion` says a queue message must stand
   * behind it, delayed past `at` (on a World whose queue outlives the process).
   */
  direct(at: number): { anchor: Anchor; companion: boolean };
  /** World-specific proof that `a`'s holder is gone. */
  gone(a: Anchor, c: VerdictContext): boolean | Promise<boolean>;
  /** An intent written before intents carried anchors. */
  readonly legacy: 'gone' | 'covered';
  /**
   * Held for each drive's whole length (a tab's Web Lock, so a reloaded tab
   * of the same profile can prove the old page gone). Returns the release.
   */
  hold?(runId: string): Promise<() => void>;
}

const ulid = monotonicFactory();

// ---------------------------------------------------------------- processes

type NodeBuiltins = {
  getBuiltinModule?: (id: string) => unknown;
  pid?: number;
  uptime?: () => number;
  kill?: (pid: number, signal: number | string) => void;
  env?: Record<string, string | undefined>;
};
const proc = (): NodeBuiltins | undefined => (globalThis as { process?: NodeBuiltins }).process;

const IDENTITY = Symbol.for('harness-world.process-identity');

/** This process, where processes can be checked (Node); undefined elsewhere (a tab, a Worker). */
export function processIdentity(): ProcessIdentity | undefined {
  const g = globalThis as { [IDENTITY]?: ProcessIdentity | null };
  if (g[IDENTITY] !== undefined) return g[IDENTITY] ?? undefined;
  const p = proc();
  const os = p?.getBuiltinModule?.('node:os') as { hostname(): string } | undefined;
  if (!p?.pid || !os || typeof p.uptime !== 'function') {
    g[IDENTITY] = null;
    return undefined;
  }
  g[IDENTITY] = {
    pid: p.pid,
    boot: `boot_${ulid()}`,
    host: os.hostname(),
    start: Math.round(Date.now() - p.uptime() * 1000),
  };
  return g[IDENTITY];
}

/** Whether a process with this pid exists (a zombie counts here; see `processGone`). */
export function isAlive(pid: number): boolean {
  try {
    proc()?.kill?.(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
function elapsedSeconds(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const parts = clock!.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

/**
 * Whether the process that wrote `p` is gone, read once from the OS: its pid
 * is free, a zombie, or now belongs to a process that started at another
 * time (a reused pid). `false` when this cannot be told (no `ps`): a live
 * holder must never be taken for dead.
 */
export function processGone(p: ProcessIdentity): boolean {
  if (!isAlive(p.pid)) return true;
  const cp = proc()?.getBuiltinModule?.('node:child_process') as
    | { execFileSync(cmd: string, args: string[], opts: { encoding: 'utf8'; timeout: number }): string }
    | undefined;
  if (!cp) return false;
  let out: string;
  try {
    out = cp.execFileSync('ps', ['-o', 'stat=,etime=', '-p', String(p.pid)], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    // `ps` exits 1 for a pid that is gone by now.
    return !isAlive(p.pid);
  }
  if (!out) return true;
  const [stat = '', etime = ''] = out.split(/\s+/);
  if (stat.startsWith('Z')) return true;
  const startedAt = Date.now() - elapsedSeconds(etime) * 1000;
  // `ps` reports whole seconds.
  return Math.abs(startedAt - p.start) > 3000;
}

// ---------------------------------------------------------------- this process's drives

export interface ActiveDrive {
  drv: string;
  anchor: Anchor;
  /**
   * Which lanes and harnesses the drive serves (`deliver`'s driver key). A
   * delivery with another key cannot rely on this drive's rerun to do its
   * work (this drive may not serve the lane the session is in now).
   */
  key?: string;
  /** A delivery for this session landed while it drove: drive once more before letting go. */
  rerun: boolean;
  /** Resolves when this drive lets go (every rerun included). */
  done: Promise<void>;
  /** @internal */
  finish: () => void;
}

/**
 * The drives running in this process, per World object (a test standing in
 * for two processes gives each its own World object). Process-wide, however
 * many copies of this module a bundler made.
 */
const DRIVES = Symbol.for('harness-world.drives');
function drives(world: World): Map<string, ActiveDrive> {
  const g = globalThis as { [DRIVES]?: WeakMap<object, Map<string, ActiveDrive>> };
  g[DRIVES] ??= new WeakMap();
  let m = g[DRIVES].get(world);
  if (!m) g[DRIVES].set(world, (m = new Map()));
  return m;
}

/** The drive of `runId` running in this process, if any. */
export function activeDrive(world: World, runId: string): ActiveDrive | undefined {
  return drives(world).get(runId);
}

/** Whether the drive `drv` is running in this process. */
export function isActiveDrv(world: World, drv: string): boolean {
  for (const d of drives(world).values()) if (d.drv === drv) return true;
  return false;
}

/** Whether anchor `key` holds a drive running in this process, or is held here (`holdAnchor`) and not past its deadline. */
export function isActiveAnchor(world: World, key: string, now = Date.now()): boolean {
  for (const d of drives(world).values()) if (anchorKey(d.anchor) === key) return true;
  for (const a of held(world).get(key) ?? []) if (a.at === undefined || a.at > now) return true;
  return false;
}

/**
 * Anchors a live writer of this process holds without a drive (pi-world's
 * storage, held open by a request's own `Harness`), per World object.
 * Process-wide, like the drives.
 */
const HELD = Symbol.for('harness-world.held-anchors');
function held(world: World): Map<string, Anchor[]> {
  const g = globalThis as { [HELD]?: WeakMap<object, Map<string, Anchor[]>> };
  g[HELD] ??= new WeakMap();
  let m = g[HELD].get(world);
  if (!m) g[HELD].set(world, (m = new Map()));
  return m;
}

/**
 * Hold `anchor` in this process: a delivery here that judges a write made
 * under it finds it covered (`isActiveAnchor`), as for a drive that runs
 * here, until the returned release is called or the anchor's deadline
 * (`at`) passes, the moment another process would stop counting it too.
 * For a writer that holds a deadline anchor with no drive of its own (a
 * request's open Pi storage), so that a wake of its own process never takes
 * the session from it while it lives.
 */
export function holdAnchor(world: World, anchor: Anchor): () => void {
  const m = held(world);
  const key = anchorKey(anchor);
  const list = m.get(key) ?? [];
  list.push(anchor);
  m.set(key, list);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = m.get(key);
    if (!now) return;
    const at = now.indexOf(anchor);
    if (at !== -1) now.splice(at, 1);
    if (now.length === 0) m.delete(key);
  };
}

/**
 * Register a drive; `undefined` when this session already drives here. That
 * drive is told to run once more if it can stand in for this one (the same
 * driver key, or no key), else the caller must wait for it (`driveSettled`).
 */
export function claimDrive(world: World, runId: string, drive: Pick<ActiveDrive, 'drv' | 'anchor' | 'key'>): ActiveDrive | undefined {
  const m = drives(world);
  const current = m.get(runId);
  if (current) {
    // A drive of another driver cannot stand in for this one: the caller waits instead.
    if (current.key === undefined || drive.key === undefined || current.key === drive.key) current.rerun = true;
    return undefined;
  }
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const entry: ActiveDrive = { ...drive, rerun: false, done, finish };
  m.set(runId, entry);
  return entry;
}

/** Let go of a drive. Returns whether a delivery asked it to run once more meanwhile. */
export function releaseDrive(world: World, runId: string, entry: ActiveDrive): boolean {
  const m = drives(world);
  if (m.get(runId) === entry) m.delete(runId);
  entry.finish();
  return entry.rerun;
}

/**
 * Forget a drive of this process as if the process had died with it (a test
 * standing in for a killed instance). Only the drive held by `key`.
 */
export function dropDrive(world: World, runId: string, key: string): void {
  const m = drives(world);
  const d = m.get(runId);
  if (d && anchorKey(d.anchor) === key) {
    m.delete(runId);
    d.finish();
  }
}

/**
 * Wait until no drive of `runId` runs in this process (a tether attaching to
 * a drive already under way). Resolves at once when none does.
 */
export async function driveSettled(world: World, runId: string): Promise<void> {
  for (let d = activeDrive(world, runId); d; d = activeDrive(world, runId)) await d.done;
}

// ---------------------------------------------------------------- policies

const env = () => proc()?.env ?? {};

/** A queue message's own lock, and nothing the World can add. */
export function deliveryAnchors(): AnchorPolicy {
  return {
    name: 'delivery',
    own: (meta) => ({ k: 'msg', m: meta.messageId ?? `direct_${ulid()}` }),
    direct: (at) => ({ anchor: { k: 'deadline', m: `direct_${ulid()}`, at }, companion: true }),
    gone: () => false,
    legacy: 'covered',
  };
}

/**
 * world-vercel: the message's VQS lease, extended by `@vercel/queue` while
 * the handler runs. Only a redelivery of the same message proves its holder
 * lost it. Intents written before anchors are `covered`: their pinned
 * message redelivers to the build that wrote them.
 */
export function vercelAnchors(): AnchorPolicy {
  return { ...deliveryAnchors(), name: 'vercel' };
}

/**
 * world-local and world-postgres on one host: the queue's lock is the
 * process (world-local delivers from memory; graphile's job lock is never
 * renewed, so only a process restart redelivers). An anchor names its
 * process, and the OS says, once, at delivery time, whether that process is
 * gone: a free, zombie or reused pid. A foreign host is never judged.
 */
export function localAnchors(options: { self?: () => ProcessIdentity | undefined; gone?: (p: ProcessIdentity) => boolean } = {}): AnchorPolicy {
  const self = options.self ?? processIdentity;
  const isGone = options.gone ?? processGone;
  const withProc = (a: Anchor): Anchor => {
    const p = self();
    return p ? { ...a, proc: p } : a;
  };
  return {
    name: 'local',
    own: (meta) => withProc({ k: 'msg', m: meta.messageId ?? `direct_${ulid()}` }),
    direct: (at) => ({ anchor: withProc({ k: 'deadline', m: `direct_${ulid()}`, at }), companion: false }),
    gone(a) {
      const me = self();
      if (!a.proc || !me || a.proc.host !== me.host) return false;
      // This very process, and its drive is not running (checked first):
      // the delivery that held it ended without closing it.
      if (a.proc.boot === me.boot) return true;
      return isGone(a.proc);
    },
    legacy: 'gone',
  };
}

/** world-postgres: the job lock is the process's (see `localAnchors`). Across hosts, only a restart redelivers. */
export const postgresAnchors = localAnchors;

/**
 * A World that runs one flow delivery per run at a time (Cloudflare's run
 * object): any other message's anchor is gone, because its delivery is not
 * running. Only between messages: direct, tab and host anchors are not
 * judged this way.
 */
export function exclusiveAnchors(): AnchorPolicy {
  return {
    name: 'exclusive',
    own: (meta) => ({ k: 'msg', m: meta.messageId ?? `direct_${ulid()}` }),
    direct: (at) => ({ anchor: { k: 'deadline', m: `direct_${ulid()}`, at }, companion: true }),
    gone: (a, c) => a.k === 'msg' && anchorKey(a) !== anchorKey(c.own),
    legacy: 'gone',
  };
}

type Locks = {
  request(name: string, options: { ifAvailable?: boolean; mode?: 'exclusive' }, cb: (lock: unknown) => Promise<unknown> | unknown): Promise<unknown>;
};
const browserLocks = (): Locks | undefined => (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;

/**
 * world-browser (IndexedDB, one leader tab per origin by Web Lock): a row is
 * redelivered with the same id only after the leader holding it died, and
 * the leader runs every delivery itself. So a message anchor that is not a
 * drive of this leader is gone. Without Web Locks every tab leads, so
 * nothing is proven.
 */
export function browserAnchors(): AnchorPolicy {
  return {
    name: 'browser',
    own: (meta) => ({ k: 'msg', m: meta.messageId ?? `direct_${ulid()}` }),
    direct: (at) => ({ anchor: { k: 'deadline', m: `direct_${ulid()}`, at }, companion: false }),
    gone: (a, c) => !!browserLocks() && a.k === 'msg' && !isActiveAnchor(c.world, anchorKey(a)),
    legacy: 'gone',
  };
}

/**
 * A tab driving the browser lane of a hybrid session (its queue lives in the
 * page). Its drives hold the Web Lock `harness:<runId>`, so a page of the same
 * browser profile that finds the lock free knows the page that wrote an
 * intent is gone (a reload, a closed tab). A tab of another profile or
 * device is never judged here: the server's tab-lost callback covers it.
 */
export function tabAnchors(options: { tab: string; profile: string; locks?: Locks }): AnchorPolicy {
  const locks = () => options.locks ?? browserLocks();
  const lockName = (runId: string) => `harness:${runId}`;
  const free = async (runId: string): Promise<boolean> => {
    const l = locks();
    if (!l) return false;
    let acquired = false;
    await l.request(lockName(runId), { ifAvailable: true }, (lock) => {
      acquired = lock !== null;
    });
    return acquired;
  };
  const own: Anchor = { k: 'tab', m: options.tab, profile: options.profile };
  return {
    name: 'tab',
    own: () => own,
    direct: () => ({ anchor: own, companion: false }),
    gone: (a, c) => a.k === 'tab' && a.profile === options.profile && a.m !== options.tab && free(c.state.runId),
    legacy: 'covered',
    async hold(runId) {
      const l = locks();
      if (!l) return () => {};
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let granted!: () => void;
      const ready = new Promise<void>((r) => (granted = r));
      void l.request(lockName(runId), { mode: 'exclusive' }, () => {
        granted();
        return held;
      });
      await ready;
      return release;
    },
  };
}

/**
 * A sandbox daemon driving the sandbox lane: its drives are held by a server
 * tether (tether.ts), which takes the lane over when the daemon goes away.
 * Here, only an earlier drive of this very daemon can be judged.
 */
export function hostAnchors(options: { boot: string }): AnchorPolicy {
  const own: Anchor = { k: 'host', m: options.boot };
  return {
    name: 'host',
    own: () => own,
    direct: () => ({ anchor: own, companion: false }),
    gone: () => false,
    legacy: 'covered',
  };
}

/**
 * The policy for a World nobody named: on Vercel, the message lease; in a
 * Node process elsewhere (world-local, world-postgres on one host), the
 * process; anywhere else, the message alone.
 */
export function defaultAnchors(): AnchorPolicy {
  const e = env();
  if (e.VERCEL === '1' || e.VERCEL_ENV) return vercelAnchors();
  if (processIdentity()) return localAnchors();
  return deliveryAnchors();
}

// ---------------------------------------------------------------- verdicts

/** The epoch step that moved the session past `epoch`, if any. */
function epochMover(state: SessionState, epoch: number): EffectRecord | undefined {
  return state.effectOrder.find((e) => isEpochStep(e.name) && e.startedEpoch === epoch);
}

const covered = (why: string): Verdict => ({ v: 'covered', why, fence: false });
const gone = (why: string, fence: boolean): Verdict => ({ v: 'gone', why, fence });
const mine = (why: string): Verdict => ({ v: 'mine', why, fence: true });

/**
 * What a delivery does about an open (running) intent `r` someone else may
 * be driving. `fence` says the recovery must move the epoch first, because
 * the holder might still write (a frozen process, a deadline drive with a
 * write in flight); a closed drive, a moved epoch or a crash record need none.
 */
export async function anchorVerdict(c: VerdictContext, r: Pick<EffectRecord, 'key' | 'startedAt' | 'driver' | 'startedEpoch' | 'anchor'>): Promise<Verdict> {
  if (r.driver && isActiveDrv(c.world, r.driver)) return covered('its drive runs in this process');
  if (r.driver && c.state.closed.has(r.driver)) return gone('its drive closed', false);
  const started = r.startedEpoch ?? 0;
  if (started < c.state.epoch) {
    const mover = epochMover(c.state, started);
    // An escalation by its own drive keeps it that drive's until it closes:
    // a sibling effect may still be finishing. Anything else took it away.
    if (!mover?.driver || mover.driver !== r.driver) return gone('the epoch moved past it', false);
  }
  if (crashedByChaos(c.state, r)) return gone('a crash record names its drive', false);
  return judgeAnchor(c, r.anchor);
}

/**
 * The anchor rules alone, for the anchor `a` a write was made under, where
 * the log has nothing more to say (also pi-world's journal, whose commits
 * carry anchors but no intents): its own anchor or a continuation's grant is
 * `mine`; a passed deadline or the World's proof is `gone`; anything else is
 * `covered`. An anchorless write gets the World's legacy rule.
 */
export async function judgeAnchor(c: Omit<VerdictContext, 'state'> & { state: Pick<SessionState, 'runId'> }, a: Anchor | undefined): Promise<Verdict> {
  if (!a) return c.policy.legacy === 'gone' ? gone('written before anchors', true) : covered('written before anchors');
  const key = anchorKey(a);
  if (key === anchorKey(c.own)) return mine('its own anchor: this is a redelivery');
  if (c.continues && key === c.continues) return mine('handed over by a continuation');
  if (isActiveAnchor(c.world, key, c.now ?? Date.now())) return covered('it drives in this process');
  if (a.at !== undefined && a.at <= (c.now ?? Date.now())) return gone("past its drive's deadline", true);
  if (await c.policy.gone(a, c as VerdictContext)) return gone(`${c.policy.name}: its holder is gone`, true);
  return covered('its anchor is held elsewhere');
}

/**
 * Thrown by a delivery that must give its message back (the queue retries
 * the same message, whose next delivery fences this one out). Used only
 * where a continuation cannot be sent.
 */
export class ReleaseAnchor extends Error {
  constructor(
    reason: string,
    readonly retryAfter = 1
  ) {
    super(`harness-world: releasing the delivery (${reason})`);
    this.name = 'ReleaseAnchor';
  }
}
