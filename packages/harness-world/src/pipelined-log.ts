import type { CreateEventRequest, Event } from '@workflow/world';
import { monotonicFactory } from 'ulid';
const ulid = monotonicFactory();
import { decode } from './codec.ts';
import { fold } from './fold.ts';
import type { SubmissionPayload } from './fold.ts';
import { LogFenced, LogSuperseded, type SessionLog, type WriteResult } from './session-log.ts';
import type { EffectRecord, SessionState } from './types.ts';

/**
 * Run-ahead durability.
 *
 * A `PipelinedLog` sits in front of a `SessionLog` (the durable core: the
 * acked prefix of the log, folded). A writer *enqueues* a write and goes on
 * at once: the write is folded into a **speculative** state (the durable
 * fold plus every not-yet-acked write, in issue order) the moment it is
 * issued, and durability trails behind in one ordered pipeline per run, one
 * frame in flight. Issue order is therefore commit order unless another
 * writer lands in between, which the World reports (bump and report) and the
 * durable fold takes in.
 *
 * Each write carries a `check` run against the durable fold the instant its
 * ack is folded (inside the log's lock, so nothing else folds first): an
 * intent that lost a first-writer race, came back fenced or chain-fenced, or
 * landed next to another live driver's progress is a **rejection**. A
 * rejection fails the pipeline: every queued write that depended on the
 * speculative view is dropped unsent, and the writer restarts from the
 * durable fold (`Restart`, a rewind). Writes marked `survives` (outcomes of
 * intents that did commit, releases, cleanups) are not views of anything and
 * still land.
 *
 * Writers block on durability only at barriers (`drain()`): before an
 * effect that must not run twice, before a "did I win?" decision, and before
 * a process gives up the session.
 *
 * Transport errors (outcome unknown) are recovered per write: the log is
 * re-read and the write is resent only if its `landed` lookup does not find
 * it (client-minted ids: step ids, submission `cid`s). A write with no lookup
 * is never blind-resent; it fails the pipeline instead.
 */

export type RejectCause =
  /** The session moved (a handoff, a recovery): this drive was fenced. */
  | 'epoch'
  /** Another step won this key first. */
  | 'first-writer'
  /** The intent placed a submission that was withdrawn ahead of it. */
  | 'withdraw'
  /** An earlier intent of this chain did not happen (fold chain fence). */
  | 'chain'
  /** Another live driver made progress on this session in between. */
  | 'foreign'
  /** An outcome found its record resolved by someone else (a recovery). */
  | 'resolved'
  /** The write's outcome stayed unknown after recovery attempts. */
  | 'transport'
  /** The log was fenced for a crash in this process. */
  | 'chaos';

export class Rejection extends Error {
  constructor(
    readonly reason: RejectCause,
    message: string,
    /** The durable slot when the rejection was decided (where a rewind goes back to). */
    readonly slot: number
  ) {
    super(`harness-world run-ahead: ${message} (${reason})`);
    this.name = 'Rejection';
  }
}

export interface EnqueueOptions {
  /** Jump ahead of queued writes (the outcome of an effect that must not run twice). */
  head?: boolean;
  /**
   * Decide, against the durable fold right after this write's ack folded,
   * whether it took. Return a cause to reject. Omitted: always took.
   */
  check?(state: SessionState, result: WriteResult): RejectCause | undefined;
  /**
   * After a transport error: is this write in the (re-read) durable log?
   * Omitted: the write is never resent and the pipeline fails.
   */
  landed?(state: SessionState): boolean;
  /**
   * Not a view of anything (an outcome of an intent that committed, a
   * release, a cleanup): still written after a rejection, and its own
   * check failing rejects only itself.
   */
  survives?: boolean | ((state: SessionState) => boolean);
  /** Bypass the log's crash fence (the chaos decision's own writes). */
  fenceToken?: string;
  /**
   * Keep resending (by `landed` lookup) for at least this long before the
   * write's outcome counts as lost: for writes whose loss costs more than a
   * rewind (a submission, the result of an effect that must not run twice).
   * Default 0: `maxResends` alone bounds it.
   */
  persistMs?: number;
  /**
   * If the write is still lost after that, keep it for `takeOrphans()`: the
   * restart re-issues it before it replays, instead of rebuilding without it.
   */
  reissue?: boolean;
}

interface Item {
  req: CreateEventRequest;
  opts: EnqueueOptions;
  synth: Event[];
  at: number;
  /** Set when a rejection decided this write still goes out. */
  surviving?: boolean;
  resolve(result: WriteResult): void;
  reject(err: unknown): void;
  promise: Promise<WriteResult>;
}

export interface PipelineLag {
  /** Writes enqueued and not yet acked (including the one in flight). */
  pending: number;
  /** Age of the oldest unacked write, ms (0 when none). */
  oldestMs: number;
  /** Events in the durable fold. */
  durableSlot: number;
  /** Events in the speculative fold. */
  specSlot: number;
  /** Ack round trips, ms, most recent last (bounded). */
  ackMs: number[];
}

export interface PipelinedLogOptions {
  /** Past this many pending writes every effect waits for `drain()`. Default 64. */
  maxPending?: number;
  /** Past this age of the oldest pending write every effect waits for `drain()`. Default 2000. */
  maxAgeMs?: number;
  /** Resends of a write whose outcome is unknown and not found in the log. Default 3. */
  maxResends?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const now = () => globalThis.performance?.now() ?? Date.now();

/** One pipeline per `SessionLog`: a submit and the drive that follows share it. */
const pipelines = new WeakMap<SessionLog, PipelinedLog>();

export class PipelinedLog {
  /** The pipeline of `log`, created on first use. */
  static for(log: SessionLog, options?: PipelinedLogOptions): PipelinedLog {
    let p = pipelines.get(log);
    if (!p) {
      p = new PipelinedLog(log, options);
      pipelines.set(log, p);
    }
    return p;
  }

  /** The pipeline of `log`, if one exists. */
  static of(log: SessionLog): PipelinedLog | undefined {
    return pipelines.get(log);
  }

  private queue: Item[] = [];
  private inFlight?: Item;
  private pumping = false;
  private spec: SessionState;
  private dirty = false;
  private failure?: Rejection;
  private readonly rejectedListeners = new Set<(r: Rejection) => void>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly acks: number[] = [];
  private orphans: Array<{ req: CreateEventRequest; opts: EnqueueOptions }> = [];
  private liveEffects = 0;
  private readonly inFnSteps = new Set<string>();
  private readonly unsubscribe: () => void;
  readonly maxPending: number;
  readonly maxAgeMs: number;

  constructor(
    readonly durable: SessionLog,
    private readonly options: PipelinedLogOptions = {}
  ) {
    this.maxPending = options.maxPending ?? 64;
    this.maxAgeMs = options.maxAgeMs ?? 2000;
    this.spec = cloneState(durable.state);
    // Anything the durable fold takes in that is not the ack of the write in
    // flight (a refresh's events, a bump report's foreign slots) makes the
    // speculative state stale: rebuild it, lazily, from the durable fold.
    this.unsubscribe = durable.onFold((events) => {
      const item = this.inFlight;
      if (!item || !events.every((e) => isOwn(item, e))) this.dirty = true;
    });
  }

  /** The durable fold plus every pending write, in issue order. */
  get speculative(): SessionState {
    if (this.dirty) this.rebuild();
    return this.spec;
  }

  /** The rejection that failed this pipeline since the last `reset()`. */
  get failed(): Rejection | undefined {
    return this.failure;
  }

  get lag(): PipelineLag {
    const oldest = this.inFlight?.at ?? this.queue[0]?.at;
    return {
      pending: this.queue.length + (this.inFlight ? 1 : 0),
      oldestMs: oldest === undefined ? 0 : Math.round(now() - oldest),
      durableSlot: this.durable.state.eventCount,
      specSlot: this.speculative.eventCount,
      ackMs: [...this.acks],
    };
  }

  /** Past the backpressure thresholds: every effect waits for `drain()`. */
  pressured(): boolean {
    const lag = this.lag;
    return lag.pending >= this.maxPending || lag.oldestMs >= this.maxAgeMs;
  }

  /**
   * Writes marked `reissue` that could not be written: the caller re-issues
   * them (a restart, before it replays), so a lost ack does not lose them.
   */
  takeOrphans(): Array<{ req: CreateEventRequest; opts: EnqueueOptions }> {
    const o = this.orphans;
    this.orphans = [];
    return o;
  }

  /**
   * Mark an effect whose `fn` is running in this process. A `replay:
   * 'never'` one (`holdsLive`) keeps its drive's delivery: a drive whose
   * durability stalled does not give the delivery up (demote) while any is
   * in `fn`, since a recovery would mark it interrupted while it runs. A restart of the
   * same drive uses `inFn` to tell its own still-running intent from one
   * whose result was lost. Returns the release.
   */
  enterFn(stepId: string, holdsLive: boolean): () => void {
    this.inFnSteps.add(stepId);
    if (holdsLive) this.liveEffects++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFnSteps.delete(stepId);
      if (holdsLive) this.liveEffects--;
    };
  }

  /** Whether `stepId`'s `fn` is still running in this process. */
  inFn(stepId: string): boolean {
    return this.inFnSteps.has(stepId);
  }

  /** `replay: 'never'` effects in `fn` (see `enterFn`). */
  get liveHeld(): number {
    return this.liveEffects;
  }

  onRejected(fn: (r: Rejection) => void): () => void {
    this.rejectedListeners.add(fn);
    return () => this.rejectedListeners.delete(fn);
  }

  /**
   * Issue a write. It is in the speculative state when this returns; the
   * promise settles when it is durable (or rejected). A failed pipeline
   * refuses new writes (except `survives` ones) until `reset()`.
   */
  enqueue(req: CreateEventRequest, opts: EnqueueOptions = {}): Promise<WriteResult> {
    let resolve!: (r: WriteResult) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<WriteResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A caller that runs ahead may never look at this promise.
    promise.catch(() => {});
    if (this.failure && opts.survives === undefined) {
      reject(this.failure);
      return promise;
    }
    const item: Item = { req, opts, synth: synthesize(this.durable.runId, req), at: now(), resolve, reject, promise };
    if (this.failure) item.surviving = true;
    // A head write jumps the queue, but never ahead of its own step's
    // queued events (an outcome cannot land before its intent).
    const at = opts.head ? this.headIndex(req) : this.queue.length;
    this.queue.splice(at, 0, item);
    // Folded once, at issue. A write placed ahead of others folds out of
    // issue order, so the speculative state is rebuilt in queue order.
    if (at < this.queue.length - 1) this.dirty = true;
    else if (!this.dirty) fold(this.spec, item.synth);
    void this.pump();
    return promise;
  }

  /**
   * Wait until everything enqueued is durable. Throws the rejection if one
   * failed the pipeline (now or earlier, until `reset()`).
   */
  async drain(): Promise<void> {
    await this.settled();
    if (this.failure) throw this.failure;
  }

  /** Wait until nothing is queued or in flight, whatever happened to it. */
  settled(): Promise<void> {
    if (!this.inFlight && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.add(r));
  }

  /**
   * The session moved (seen outside the log, e.g. a newer epoch's hint), or
   * the drive is giving its delivery up:
   * fail the pipeline as an `epoch` rejection, so the drive stops now
   * rather than when its stalled write returns.
   */
  fence(message: string): void {
    this.fail(new Rejection('epoch', message, this.durable.state.eventCount));
  }

  /** Clear a rejection: the next drive starts from the durable fold. */
  reset(): void {
    this.failure = undefined;
    this.dirty = true;
  }

  /** Stop following the durable log (the pipeline is not used again). */
  dispose(): void {
    this.unsubscribe();
    if (pipelines.get(this.durable) === this) pipelines.delete(this.durable);
  }

  private headIndex(req: CreateEventRequest): number {
    const id = 'correlationId' in req ? req.correlationId : undefined;
    let at = 0;
    if (id) this.queue.forEach((q, i) => {
      if ('correlationId' in q.req && q.req.correlationId === id) at = i + 1;
    });
    return at;
  }

  private rebuild(): void {
    this.dirty = false;
    this.spec = cloneState(this.durable.state);
    const pending = this.inFlight ? [this.inFlight, ...this.queue] : this.queue;
    for (const item of pending) fold(this.spec, item.synth);
  }

  private fail(rejection: Rejection): void {
    if (this.failure) return;
    this.failure = rejection;
    this.options.log?.('run-ahead: rejected', { runId: this.durable.runId, cause: rejection.reason, slot: rejection.slot, message: rejection.message });
    // Drop everything that was issued against the speculative view; keep
    // what is not a view of anything.
    const keep: Item[] = [];
    for (const item of this.queue) {
      const s = item.opts.survives;
      const survives = typeof s === 'function' ? s(this.durable.state) : !!s;
      if (survives) {
        item.surviving = true;
        keep.push(item);
      } else item.reject(rejection);
    }
    this.queue = keep;
    this.dirty = true;
    for (const fn of this.rejectedListeners) {
      try {
        fn(rejection);
      } catch {}
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.inFlight = item;
        try {
          const result = await this.send(item);
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        } finally {
          this.inFlight = undefined;
        }
      }
    } finally {
      this.pumping = false;
      for (const w of [...this.idleWaiters]) {
        this.idleWaiters.delete(w);
        w();
      }
    }
  }

  /** Write one item; run its check inside the lock the moment its ack folds. */
  private async send(item: Item): Promise<WriteResult> {
    const maxResends = this.options.maxResends ?? 3;
    const rejectWith = (cause: RejectCause, message: string): Rejection => {
      const r = new Rejection(cause, message, this.durable.state.eventCount);
      // A survivor that does not take rejects only itself.
      if (!item.surviving) this.fail(r);
      return r;
    };
    let verdict: RejectCause | undefined;
    const judge = (result: WriteResult) => {
      verdict = item.opts.check?.(this.durable.state, result);
    };
    const first = now();
    const persistMs = item.opts.persistMs ?? 0;
    const lost = (message: string): Rejection => {
      if (item.opts.reissue) this.orphans.push({ req: item.req, opts: item.opts });
      return rejectWith('transport', message);
    };
    for (let attempt = 1; ; attempt++) {
      const began = now();
      try {
        const result = await this.durable.write(item.req, {
          ...(item.opts.fenceToken ? { fenceToken: item.opts.fenceToken } : {}),
          onFolded: judge,
        });
        this.recordAck(now() - began);
        if (verdict) throw rejectWith(verdict, `${describe(item.req)} did not take`);
        return result;
      } catch (err) {
        if (err instanceof Rejection) throw err;
        if (err instanceof LogFenced) throw rejectWith('chaos', 'the log is fenced for a crash');
        // The World's in-band fence refused it: nothing landed, and nothing
        // queued behind it may (it was decided from the same stale view).
        // Never resent. Out-of-band writes still queued (a submission) go on.
        if (err instanceof LogSuperseded) throw rejectWith('epoch', `${describe(item.req)} was refused by the in-band fence`);
        // Outcome unknown. Find out from the log; resend only if absent.
        if (!item.opts.landed) throw lost(`${describe(item.req)} failed with no way to look it up: ${String(err)}`);
        const reread = await this.durable.refresh().then(
          () => true,
          () => false
        );
        if (reread && item.opts.landed(this.durable.state)) {
          const result: WriteResult = { foreign: [], preempted: false };
          judge(result);
          if (verdict) throw rejectWith(verdict, `${describe(item.req)} did not take`);
          return result;
        }
        if (attempt > maxResends && now() - first >= persistMs) throw lost(`${describe(item.req)} could not be written: ${String(err)}`);
        this.options.log?.('run-ahead: resending', { runId: this.durable.runId, attempt, write: describe(item.req), error: String(err) });
        await new Promise((r) => setTimeout(r, Math.min(50 * attempt, 500)));
      }
    }
  }

  private recordAck(ms: number) {
    this.acks.push(Math.round(ms * 10) / 10);
    if (this.acks.length > 64) this.acks.shift();
  }
}

function describe(req: CreateEventRequest): string {
  return 'correlationId' in req && req.correlationId ? `${req.eventType} ${req.correlationId}` : req.eventType;
}

/** Whether `event` is (part of) the commit of `item`. */
function isOwn(item: Item, event: Event): boolean {
  const req = item.req;
  if (event.eventType !== 'hook_received') {
    return 'correlationId' in req && 'correlationId' in event && event.correlationId === req.correlationId;
  }
  if (req.eventType !== 'hook_received') return false;
  const ours = submissionKey(req.eventData?.payload);
  return !!ours && ours === submissionKey((event as Event & { eventData?: { payload?: unknown } }).eventData?.payload);
}

function submissionKey(payload: unknown): string | undefined {
  try {
    const p = decode(payload) as SubmissionPayload | undefined;
    return p?.cid ?? p?.nonce;
  } catch {
    return undefined;
  }
}

/** The events a write will commit as, for the speculative fold. */
function synthesize(runId: string, req: CreateEventRequest): Event[] {
  const base = { runId, createdAt: new Date(), specVersion: 0 } as Record<string, unknown>;
  const id = () => `evnt_spec_${ulid()}`;
  // A born-running intent commits as `step_created` (with the input) and a start.
  if (req.eventType === 'step_started' && (req as { eventData?: { input?: unknown } }).eventData?.input !== undefined) {
    const r = req as CreateEventRequest & { correlationId: string; eventData: { stepName: string; input: unknown } };
    return [
      { ...base, eventId: id(), eventType: 'step_created', correlationId: r.correlationId, eventData: { stepName: r.eventData.stepName, input: r.eventData.input } } as unknown as Event,
      { ...base, eventId: id(), eventType: 'step_started', correlationId: r.correlationId, eventData: { stepName: r.eventData.stepName } } as unknown as Event,
    ];
  }
  return [{ ...base, eventId: id(), ...req } as unknown as Event];
}

/** A copy of a fold that later folds do not reach into. */
export function cloneState(s: SessionState): SessionState {
  const copies = new Map<EffectRecord, EffectRecord>();
  const copy = (r: EffectRecord): EffectRecord => {
    let c = copies.get(r);
    if (!c) {
      c = { ...r, placed: [...r.placed] };
      copies.set(r, c);
    }
    return c;
  };
  const effectOrder = s.effectOrder.map(copy);
  const effects = new Map<string, EffectRecord>();
  for (const [k, r] of s.effects) effects.set(k, copy(r));
  return {
    ...s,
    submissions: [...s.submissions],
    placed: new Set(s.placed),
    withdrawn: new Set(s.withdrawn),
    effects,
    effectOrder,
    superseded: new Set(s.superseded),
    fenced: new Set(s.fenced),
    fencedChains: new Set(s.fencedChains),
    closed: new Set(s.closed),
    // Values are immutable (the fold copies on write): new maps suffice.
    docs: new Map(s.docs),
    docEdits: new Map(s.docEdits),
  };
}

/** Whether `stepId` is anywhere in the fold (effective or not). */
export function stepKnown(state: SessionState, stepId: string): boolean {
  return state.superseded.has(stepId) || state.effectOrder.some((r) => r.stepId === stepId);
}
