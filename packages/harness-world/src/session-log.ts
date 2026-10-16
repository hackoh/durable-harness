import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventListResponse,
  EventResult,
  World,
} from '@workflow/world';
import { eventIdToSlot, slotToEventId } from '@workflow/world';
import { emptyState, fold } from './fold.ts';
import { covers, inBandFenceSupported, isDefinitiveRefusal, isInBandSuperseded, probeInBandCounters } from './fence.ts';
import { isEpochStep } from './lanes.ts';
import type { DriveFence, SessionState } from './types.ts';

/** A write refused because this log was fenced (a crash is under way in this process). */
export class LogFenced extends Error {
  constructor(reason: string) {
    super(`harness-world: the log is fenced (${reason}); nothing more is written from here`);
    this.name = 'LogFenced';
  }
}

/**
 * An in-band write of this log was refused by the World's in-band writer
 * fence (`InBandSupersededError`): another drive wrote in-band since this
 * log's count was taken, so the drive that armed it no longer owns the
 * session. Nothing of the refused write landed, and every later in-band write
 * of the drive is refused here, before it is sent. Out-of-band writes (inputs)
 * still go. See `SessionLog.arm`.
 */
export class LogSuperseded extends Error {
  constructor(
    /** The count this log wrote at. */
    readonly expected: number,
    /** The World's count when it refused (diagnostic only: never adopted). */
    readonly seqInBand?: number
  ) {
    super(
      `harness-world: an in-band write was refused at count ${expected}${seqInBand !== undefined ? ` (the run is at ${seqInBand})` : ''}: another drive owns the session`
    );
    this.name = 'LogSuperseded';
  }
}

/** What the in-band fence did on a log (logs and marks only). */
export type FenceNote =
  | { kind: 'armed'; count: number }
  | { kind: 'refused'; expected: number; seqInBand?: number }
  | { kind: 'recount'; expected: number; seqInBand: number }
  | { kind: 'legacy'; reason: string };

const now = () => globalThis.performance?.now() ?? Date.now();

/** The docs hook's token (`harness:<runId>:docs`, docs.ts). */
const isDocsToken = (token: unknown) => typeof token === 'string' && token.endsWith(':docs');

/** Steps that record facts about other steps (or drives, or machines), not a driver's progress. */
const FACT_STEPS = new Set(['park', 'settle', 'detach', 'close', 'chaos', 'host']);

/** See `SessionLog.slowWriteProbeMs`. */
export const SLOW_WRITE_PROBE_MS = 2000;
/** Writes a probe can recognise in the log: one per type and step. */
const PROBED_WRITES = new Set(['step_started', 'step_completed', 'step_failed', 'step_retrying']);

export interface WriteInfo {
  eventType: string;
  slot: number | null;
  ms: number;
  bumped: boolean;
}

export interface WriteResult {
  event?: Event;
  foreign: Event[];
  preempted: boolean;
}

/**
 * One reader/writer's view of a run's log: the events it has read, folded.
 *
 * Every write states how much of the log the writer has seen
 * (`eventCount`). The World never rejects a write for being stale; it commits
 * at the next free slot and reports what the writer missed (bump and report).
 * This class folds the missed events back in, so after any write the view is
 * again a prefix of the log, never a prefix with a hole.
 *
 * In-band writer fence (see `arm`). On a World that declares
 * `capabilities.inBandFence`, a drive arms the log it drives: from then on
 * its writes are *in-band* (`inBand: true, expectedSeqInBand`), and the World
 * refuses one whose count is stale, writing nothing. Submissions
 * (`hook_received`) are always *out-of-band* and never fenced, and so is every
 * write of a log no drive has armed (collectors, `sessions.start` and
 * `close`, a delivery deciding whether to drive at all). The count comes only
 * from the World: a refresh's snapshot while unarmed (once the refresh covers
 * every position it counts), or on a World that fences but lists no snapshot
 * the counters of a refused probe followed by such a read (`probe`); then it
 * is advanced by the positions each accepted in-band write allocated.
 */
export class SessionLog {
  readonly state: SessionState;
  private cursor: string | null = null;
  /** Reads and writes fold into one state, so they take turns. */
  private lock: Promise<unknown> = Promise.resolve();
  private readonly observers = new Set<() => void>();
  private readonly foldListeners = new Set<(events: Event[]) => void>();
  private fenced?: { token: string; reason: string };
  /** Whether the World fences in-band writes (`inBandFenceSupported`). */
  private readonly fenceable: boolean;
  /**
   * The World's in-band count as of this fold, when known: the first page's
   * snapshot of a refresh made while unarmed and covering it (or a probe's
   * counters, `probe`), advanced by our own accepted in-band writes.
   * Undefined when the World gave none, or after a write whose outcome is
   * unknown.
   */
  private fenceCount?: number;
  /** Where `fenceCount` came from: a list snapshot, or a probe's counters (a World that lists no snapshot). */
  private countFrom?: 'snapshot' | 'probe';
  /**
   * The last in-band advance that was a guess (`positionsOf`: an accepted
   * born-running intent the World reported no `allocated` for): the count
   * before it and after. A refusal of the very next in-band write that proves
   * nothing else was written (see `inBandFailed`) shows the guess was wrong.
   */
  private guess?: { from: number; to: number };
  /** How many in-band positions this World counts for a born-running intent, once a refusal showed it (see `guess`). */
  private bornRunningPositions?: number;
  /** The drive whose writes are in-band (`arm`). */
  private armedBy?: string;
  /** The count the armed drive's first accepted in-band write was checked against (`fenceOf`). */
  private accepted?: { drv: string; count: number };
  /** Set once the World refused an in-band write of the armed drive. */
  private refused?: LogSuperseded;
  /** What the fence did (logs and marks only; never state). */
  onFence?: (note: FenceNote) => void;
  /**
   * Called after every write the World answered: what committed, at which
   * slot, how long the write took, and whether another writer landed in
   * between. Timing marks only (see marks.ts); never state.
   */
  onWrite?: (info: WriteInfo) => void;

  constructor(
    private readonly world: World,
    readonly runId: string
  ) {
    this.state = emptyState(runId);
    this.fenceable = inBandFenceSupported(world);
  }

  /**
   * Make `drv`'s writes through this log in-band: each carries the World's
   * in-band count, and a write the World refuses as stale (another drive wrote
   * in-band since this count) throws `LogSuperseded`, as does every later
   * in-band write of this log, unsent. Called by a drive once it has decided
   * to drive (deliver step 2), from the count of the load it decided from.
   *
   * Returns false, and leaves every write out-of-band (unfenced, today's
   * behavior), when the World does not declare the fence or gave no count
   * with this log's last refresh (an older World, a run without slots).
   */
  arm(drv: string, count: number | undefined = this.fenceCount): boolean {
    if (!this.fenceable || count === undefined) {
      this.armedBy = undefined;
      if (this.fenceable) this.note({ kind: 'legacy', reason: 'no in-band count from the World on the last read' });
      return false;
    }
    // The count of the view the drive decided from (`count`), not whatever a
    // read made since then adopted: a read that folded another drive's
    // in-band write after the decision would otherwise let the decision
    // through the fence.
    this.fenceCount = count;
    this.armedBy = drv;
    this.refused = undefined;
    this.accepted = undefined;
    this.note({ kind: 'armed', count });
    return true;
  }

  /**
   * Whether this log has no in-band count although its World fences (a World
   * that lists no snapshot, world-vercel today): `probe` can get one.
   */
  get needsProbe(): boolean {
    return this.fenceable && this.fenceCount === undefined && !this.armedBy;
  }

  /**
   * Get an in-band count on a World that fences but lists no snapshot
   * (world-vercel: its backend fences, its list reports no counters): read
   * the World's counters with a write its fence refuses
   * (`probeInBandCounters`), then read the log, and adopt the count once that
   * read covers every slot the counters may count. That is what a snapshot
   * is (counters read under the fence before the listing), so the count is
   * only ever one the World gave for a view this log has folded. Returns
   * whether the log now has a count; without one, drives write unfenced.
   */
  probe(): Promise<boolean> {
    return this.exclusive(async () => {
      if (!this.fenceable || this.armedBy) return this.fenceCount !== undefined;
      const counters = await probeInBandCounters(this.world, this.runId);
      if (!counters) {
        this.note({ kind: 'legacy', reason: 'the World gave no in-band count (no snapshot, no counters on a refusal)' });
        return false;
      }
      const kept = { count: this.fenceCount, from: this.countFrom };
      await this.refreshUnlocked();
      if (this.armedBy) return this.fenceCount !== undefined;
      if (!covers(this.state.eventCount, counters)) {
        this.note({ kind: 'legacy', reason: `the log does not show every position its count includes yet (${this.state.eventCount} of ${counters.seq})` });
        // The count this log had, if the read dropped it: at worst behind, so the World refuses rather than lets a stale write through.
        if (this.fenceCount === undefined && kept.count !== undefined) ({ count: this.fenceCount, from: this.countFrom } = kept);
        return this.fenceCount !== undefined;
      }
      this.fenceCount = counters.seqInBand;
      this.countFrom = 'probe';
      return true;
    });
  }

  /** `drv` writes nothing more in-band through this log (it let go of the session, or handed it to another lane). */
  disarm(drv: string): void {
    if (this.armedBy !== drv) return;
    this.armedBy = undefined;
    this.refused = undefined;
  }

  /** The World's in-band count as this log knows it (undefined when the World gave none, or after an unknown outcome). */
  get inBandCount(): number | undefined {
    return this.fenceCount;
  }

  /**
   * `drv`'s fencing token (`DriveContext.fence`): the World's in-band count
   * its first accepted in-band write since it armed was checked against, so
   * it stays the same for the drive. Exact even where this log guessed how
   * far a write moved the count (the World accepts a write only at its own
   * count). Kept after a refusal or a disarm, until the log is armed again:
   * lower than any write the World accepted since. `fenced` while `drv` is
   * armed and its writes still in-band: not after a write whose outcome is
   * unknown (the rest of the drive writes unfenced), a refusal, or a disarm.
   * Undefined before `drv`'s first accepted in-band write, and on a World
   * without the fence.
   */
  fenceOf(drv: string): DriveFence | undefined {
    if (this.accepted?.drv !== drv) return undefined;
    return { count: this.accepted.count, fenced: this.armedBy === drv && this.fenceCount !== undefined && !this.refused };
  }

  /** The refusal that stopped the armed drive, if the World refused one of its writes. */
  get superseded(): LogSuperseded | undefined {
    return this.refused;
  }

  private note(note: FenceNote): void {
    try {
      this.onFence?.(note);
    } catch {}
  }

  /** Read every event past the ones already folded. */
  refresh(): Promise<Event[]> {
    return this.exclusive(() => this.refreshUnlocked());
  }

  /**
   * Append one event. Returns the committed event, the events *another live
   * driver* landed between our last read and it (`foreign`: effective
   * events that are neither ours nor inbox submissions; a fenced or inert
   * write by a driver that lost the session does not count), and whether one
   * of them was a handoff (`preempted`: the session moved away).
   */
  write(
    request: CreateEventRequest,
    options: { fenceToken?: string; onFolded?: (result: WriteResult) => void; resume?: Required<Pick<CreateEventParams, 'resumeId' | 'resumePayloadDigest'>> } = {}
  ): Promise<WriteResult> {
    return this.exclusive(async () => {
      // Checked when the write's turn comes, not when it was queued: a write
      // waiting behind the lock when the fence went up is refused too.
      if (this.fenced && options.fenceToken !== this.fenced.token) {
        throw new LogFenced(this.fenced.reason);
      }
      const result = await this.writeUnlocked(request, options.resume);
      // Still inside the lock: nothing else folds before the caller has
      // seen this write land (a pipeline drops it from its pending tail here).
      options.onFolded?.(result);
      return result;
    });
  }

  /** Whether the log is fenced (a crash is under way in this process). */
  get isFenced(): boolean {
    return !!this.fenced;
  }

  /**
   * Call `fn` with the events of every fold (a read or a write), in log
   * order, before the fold's observers run. Returns an unsubscribe.
   */
  onFold(fn: (events: Event[]) => void): () => void {
    this.foldListeners.add(fn);
    return () => this.foldListeners.delete(fn);
  }

  /**
   * Refuse every later write that does not carry the returned token. A
   * process that has decided to crash fences its log first, so nothing it
   * was about to write (the next checkpoint, an effect's result) commits
   * between the decision and the kill. Reads still work.
   */
  fence(reason: string): string {
    const token = `fence_${Math.random().toString(36).slice(2)}`;
    this.fenced = { token, reason };
    return token;
  }

  /** Lift a fence (the crash it guarded turned out not to apply). */
  unfence(token: string): void {
    if (this.fenced?.token === token) this.fenced = undefined;
  }

  /**
   * Call `fn` after every fold (a read or a write), e.g. to notice the epoch
   * moving. Returns an unsubscribe.
   */
  observe(fn: () => void): () => void {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  private folded(events: Event[]): void {
    for (const fn of this.foldListeners) {
      try {
        fn(events);
      } catch {}
    }
    for (const fn of this.observers) {
      try {
        fn();
      } catch {}
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.queued++;
    const run = this.lock.then(fn, fn).finally(() => {
      this.queued--;
    });
    this.lock = run.catch(() => {});
    return run;
  }

  private queued = 0;

  /** A read or write is in flight or waiting on this log (a refresh now would queue behind it). */
  get busy(): boolean {
    return this.queued > 0;
  }

  private async refreshUnlocked(): Promise<Event[]> {
    const fresh: Event[] = [];
    let hasMore = true;
    let first = true;
    let snapshot: EventListResponse['snapshot'];
    while (hasMore) {
      const page: EventListResponse = await this.world.events.list({
        runId: this.runId,
        pagination: {
          sortOrder: 'asc',
          limit: 1000,
          ...(this.cursor ? { cursor: this.cursor } : {}),
        },
        resolveData: 'all',
      });
      // The first page's snapshot was read before the listing began, so this
      // whole read (on top of the prefix already folded) can cover every
      // position it counts. Adopted below, once the read is folded.
      if (first) snapshot = page.snapshot;
      first = false;
      for (const event of page.data) {
        if (this.isNew(event)) fresh.push(event);
      }
      if (page.cursor) this.cursor = page.cursor;
      hasMore = page.hasMore;
    }
    const effective = new Set<Event>();
    fold(this.state, fresh, (e, ok) => ok && effective.add(e));
    this.lastEffective = effective;
    // Adopted only from a read that completed and covers every position the
    // snapshot counts (a listing can stop short of it: world-vercel's sealed
    // log ends a read at a slot still in flight), so the count never includes
    // an in-band write this log has not folded. A read that gives no count
    // keeps the one this log has: it was the World's for a view this fold
    // contains, and is at worst behind (then the World refuses, never the
    // other way round). And only while no drive writes in-band here: an armed
    // drive's count is its own, and moves only by its own writes (a sibling's
    // in-band write is what the World then refuses ours for).
    if (this.fenceable && !this.armedBy && snapshot && covers(this.state.eventCount, snapshot)) {
      this.fenceCount = snapshot.seqInBand;
      this.countFrom = 'snapshot';
    } else if (this.countFrom === 'probe' && !this.armedBy && fresh.some((e) => e.eventType !== 'hook_received')) {
      // A probed count (a World that lists no snapshot) was the World's for
      // the view it was read with. A read that folds another writer's
      // progress (anything but an input: inputs are never in-band) may show
      // in-band writes it does not count, so a log kept between turns (a
      // route's, whose last turn another process drove) probes again before a
      // drive decides from it. Kept, the World would refuse that drive's
      // first write and the drive would stand down as superseded, its turn
      // left to the queue's backstop.
      this.fenceCount = undefined;
      this.countFrom = undefined;
    }
    this.folded(fresh);
    return fresh;
  }

  /** Which events of the last refresh changed the fold. */
  private lastEffective = new Set<Event>();

  private async writeUnlocked(
    request: CreateEventRequest,
    resume: Required<Pick<CreateEventParams, 'resumeId' | 'resumePayloadDigest'>> | undefined
  ): Promise<WriteResult> {
    // In-band: the armed drive's own progress. Inputs are never fenced: a
    // submission must land whoever is driving, and so must an app's document
    // edit and the docs hook it is written on (a route that shares a log with
    // a drive in this process writes them through it too).
    const input =
      request.eventType === 'hook_received' ||
      (request.eventType === 'hook_created' && isDocsToken((request as { eventData?: { token?: unknown } }).eventData?.token));
    const armed = !input && this.armedBy !== undefined;
    const armedBy = this.armedBy;
    // A stale writer writes nothing more in-band.
    if (armed && this.refused) throw this.refused;
    // Unfenced when the count is unknown (see `inBandFailed`).
    let expected = armed ? this.fenceCount : undefined;
    const expectedSlot = this.state.eventCount + 1;
    const began = now();
    this.writingSince = began;
    let result: EventResult;
    try {
      for (;;) {
        try {
          result = await this.probeWhileSlow(
            this.world.events.create(this.runId, request, {
              eventCount: this.state.eventCount,
              ...resume,
              ...(expected !== undefined ? { inBand: true, expectedSeqInBand: expected } : {}),
            }),
            request
          );
          break;
        } catch (err) {
          if (expected === undefined) throw err;
          // A refusal that only shows this log guessed its own last write's
          // positions wrong: the World's count, and the write again (once).
          const recounted = await this.inBandFailed(err, expected);
          if (recounted === undefined) throw err;
          expected = recounted;
        }
      }
    } finally {
      this.writingSince = undefined;
    }
    if (expected !== undefined) {
      // The drive's first write accepted since it armed, at `expected`: the World's own count, whatever this log guessed before.
      if (armedBy !== undefined && this.accepted?.drv !== armedBy) this.accepted = { drv: armedBy, count: expected };
      const allocated = (result as { allocated?: unknown }).allocated;
      const guessed = typeof allocated !== 'number' && this.isBornRunning(request, result);
      this.fenceCount = expected + (typeof allocated === 'number' ? allocated : this.positionsOf(request, result));
      this.guess = guessed ? { from: expected, to: this.fenceCount } : undefined;
    }
    const event = result.event;
    const slot = event ? eventIdToSlot(event.eventId) : null;
    // A born-running intent (`step_started` carrying the input) on a step the
    // World had not seen commits a synthetic `step_created` first, so it
    // always lands one slot past the one we asked for. When the World says it
    // was this write that created the step (`stepCreated`) and the gap is
    // exactly that one slot, the slot in between is our own `step_created`
    // (it was drawn before the start and after everything we had folded), so
    // nothing foreign landed and there is nothing to re-read. The server does
    // not report skipped slots on `step_started`, so without this every
    // intent of a durable turn paid a full `events.list`.
    const ownCreate = event && slot !== null && slot === expectedSlot + 1 ? bornRunningCreate(request, result, event, expectedSlot) : undefined;
    try {
      this.onWrite?.({ eventType: request.eventType, slot, ms: now() - began, bumped: slot !== expectedSlot && !ownCreate });
    } catch {}
    if (event && ownCreate) {
      const sent = [ownCreate, { ...event, eventData: (request as { eventData: object }).eventData } as Event];
      fold(this.state, sent);
      this.folded(sent);
      return { event, foreign: [], preempted: false };
    }
    if (event && slot === expectedSlot) {
      // Fold what we wrote, not what came back: a World may return the event
      // without its payload (world-vercel stores payloads as refs), and a
      // step_failed folded without its error loses the interrupted result.
      const sent = 'eventData' in request && event.eventType === request.eventType
        ? ({ ...event, eventData: request.eventData } as Event)
        : event;
      fold(this.state, [sent]);
      this.folded([sent]);
      return { event, foreign: [], preempted: false };
    }
    // Someone wrote in between (or the World returned no event). Our view
    // must become a prefix of the log again, including our own write. A
    // World that reports what we skipped (bump and report: `events` holds
    // every slot after the one we claimed to have seen, ending with ours)
    // saves the re-read; otherwise list from our cursor.
    const fresh = this.foldReport(result as { events?: Event[] }, event, request) ?? (await this.refreshUnlocked());
    const ours = (e: Event) =>
      e.eventId === event?.eventId ||
      // A born-running step_started commits a synthetic step_created first.
      (e.eventType === 'step_created' &&
        'correlationId' in request &&
        e.correlationId === request.correlationId);
    // Inputs: submissions, and out-of-band document edits (the docs hook,
    // its creation, and a second writer's conflict on its token). None is
    // another driver's progress.
    const inbox = (e: Event) =>
      (e.eventType === 'hook_received' &&
        (e.correlationId === this.state.inbox?.hookId || (!!this.state.docsHook && e.correlationId === this.state.docsHook.hookId))) ||
      ((e.eventType === 'hook_created' || e.eventType === 'hook_conflict') && isDocsToken((e as { eventData?: { token?: unknown } }).eventData?.token));
    const effective = this.lastEffective;
    // Facts about other steps (a park, a settlement, a crash decision) are
    // written by collectors, not by a competing driver.
    const facts = new Set(this.state.effectOrder.filter((r) => FACT_STEPS.has(r.name)).map((r) => r.stepId));
    const fact = (e: Event) => 'correlationId' in e && !!e.correlationId && facts.has(e.correlationId);
    const foreign = fresh.filter((e) => effective.has(e) && !ours(e) && !inbox(e) && !fact(e));
    const handoffs = new Set(this.state.effectOrder.filter((r) => isEpochStep(r.name)).map((r) => r.stepId));
    const preempted = foreign.some(
      (e) => e.eventType === 'step_created' && handoffs.has(e.correlationId)
    );
    return { event, foreign, preempted };
  }

  /**
   * The in-band positions an accepted write took, on a World that does not
   * report them (`allocated`). world-local reports them. world-postgres
   * counts one per create that appended its event, a born-running intent
   * (two events) included, and lists a snapshot. world-vercel's backend
   * counts one per event it appended, so a born-running intent the World
   * created the step for (`stepCreated`) takes two; it lists no snapshot
   * (this log's count then came from a probe), which is how it is told
   * apart. A World that lists a snapshot and counts per event too (world-vercel
   * once its backend lists one, without `allocated`) makes the guess wrong:
   * the World refuses the drive's next in-band write, never accepts a stale
   * one, and that refusal (with nothing else written) corrects the count
   * (`inBandFailed`), and this log counts a born-running intent as the World
   * does from then on.
   */
  private positionsOf(request: CreateEventRequest, result: EventResult): number {
    if (!result.event) return 0;
    if (!this.isBornRunning(request, result)) return 1;
    return this.bornRunningPositions ?? (this.countFrom === 'probe' ? 2 : 1);
  }

  /** A born-running intent the World created the step for (two events, one create). */
  private isBornRunning(request: CreateEventRequest, result: EventResult): boolean {
    return !!result.event && request.eventType === 'step_started' && (result as { stepCreated?: unknown }).stepCreated === true;
  }

  /**
   * An in-band write threw. A refusal by the fence means another drive wrote
   * in-band since `expected`: fold what it wrote (the caller decides from the
   * log whether the session moved), latch the refusal, tell the observers (the
   * drive's ownership check) and throw `LogSuperseded`. Never retried: the
   * write was decided from a log that is no longer the log.
   *
   * One refusal is not another drive's: the write right after a guessed
   * advance (`guess`: a born-running intent the World reported no
   * `allocated` for), refused with counters whose `seq` is the slot this log
   * has folded up to. Nothing was written since this log's own last write
   * then, by anyone, so the World's `seqInBand` is this drive's own count and
   * only the guess was off: adopt it, learn how this World counts a
   * born-running intent, and return it for the write to be sent again.
   *
   * Any other failure that may have been counted (not a definitive 4xx
   * refusal) leaves the count unknown, so the rest of this drive writes
   * unfenced, as on a World without the fence; the fold's own rules still
   * hold for every write.
   */
  private async inBandFailed(err: unknown, expected: number): Promise<number | undefined> {
    if (isInBandSuperseded(err)) {
      const { seq, seqInBand } = err as { seq?: unknown; seqInBand?: unknown };
      const guess = this.guess;
      this.guess = undefined;
      if (
        guess &&
        guess.to === expected &&
        typeof seq === 'number' &&
        typeof seqInBand === 'number' &&
        seq === this.state.eventCount &&
        seqInBand > guess.from &&
        seqInBand !== expected
      ) {
        this.bornRunningPositions = seqInBand - guess.from;
        this.fenceCount = seqInBand;
        this.note({ kind: 'recount', expected, seqInBand });
        return seqInBand;
      }
      this.refused = new LogSuperseded(expected, typeof seqInBand === 'number' ? seqInBand : undefined);
      // Never ours again: only a read made after this drive lets go may give this log a count.
      this.fenceCount = undefined;
      this.note({ kind: 'refused', expected, ...(this.refused.seqInBand !== undefined ? { seqInBand: this.refused.seqInBand } : {}) });
      await this.refreshUnlocked().catch(() => {});
      for (const fn of this.observers) {
        try {
          fn();
        } catch {}
      }
      throw this.refused;
    }
    this.guess = undefined;
    if (!isDefinitiveRefusal(err)) {
      this.fenceCount = undefined;
      this.note({ kind: 'legacy', reason: `an in-band write's outcome is unknown (${err instanceof Error ? err.message : String(err)})` });
    }
    return undefined;
  }

  /**
   * How long a step write may go unanswered before the log is read to see
   * whether it already committed (0: never). world-vercel's event writes
   * carry no deadline of their own (the WebSocket one is 60s), and a write
   * whose reply is lost holds the whole log, and with it the drive's queue
   * delivery, until it comes back: on production one sat for 126s. A write
   * that stays unanswered past the driver's write deadline makes the drive
   * give its delivery up (driver.ts, `WRITE_STALL_MS`).
   */
  slowWriteProbeMs = SLOW_WRITE_PROBE_MS;

  /** When the write in flight was sent (`performance.now()`), if one is in flight. */
  private writingSince?: number;

  /** How long the write in flight has been waiting for its answer, in ms (0 when none is). */
  get stalledMs(): number {
    return this.writingSince === undefined ? 0 : now() - this.writingSince;
  }

  /**
   * Wait for `pending`; while it is slow, look for the write in the log every
   * `slowWriteProbeMs`. A step event is unique by type and step id, so
   * finding it means it committed: answer as the World would have (the
   * event, with every slot from ours-to-be up to it as a bump report) and
   * leave the hung request behind. Inbox writes (`hook_received`) are not
   * unique, so they only ever wait.
   */
  private async probeWhileSlow(pending: Promise<EventResult>, request: CreateEventRequest): Promise<EventResult> {
    const every = this.slowWriteProbeMs;
    const correlationId = (request as { correlationId?: string }).correlationId;
    if (!(every > 0) || !correlationId || !PROBED_WRITES.has(request.eventType)) return pending;
    let done = false;
    const settled = pending.finally(() => {
      done = true;
    });
    settled.catch(() => {});
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<'tick'>((r) => {
        timer = setTimeout(() => r('tick'), every);
      });
      const first = await Promise.race([settled, tick]).finally(() => clearTimeout(timer));
      if (first !== 'tick') return first as EventResult;
      if (done) return settled;
      const found = await this.findCommitted(request.eventType, correlationId).catch(() => undefined);
      if (done) return settled;
      if (found) {
        try {
          this.onSlowWrite?.({ eventType: request.eventType, slot: eventIdToSlot(found.event.eventId) });
        } catch {}
        return { event: found.event, events: found.events, cursor: null, hasMore: false } as unknown as EventResult;
      }
    }
  }

  /** Called when a slow write was found committed by a probe (marks only). */
  onSlowWrite?: (info: { eventType: string; slot: number | null }) => void;

  /** The events past our fold up to and including the first `type` event of `correlationId`, if it is there. */
  private async findCommitted(type: string, correlationId: string): Promise<{ event: Event; events: Event[] } | undefined> {
    const seen: Event[] = [];
    let cursor = this.cursor;
    for (;;) {
      const page = await this.world.events.list({
        runId: this.runId,
        pagination: { sortOrder: 'asc', limit: 1000, ...(cursor ? { cursor } : {}) },
        resolveData: 'all',
      });
      for (const e of page.data) {
        if (!this.isNew(e)) continue;
        seen.push(e);
        if (e.eventType === type && (e as { correlationId?: string }).correlationId === correlationId) {
          return { event: e, events: seen };
        }
      }
      if (!page.hasMore || !page.cursor) return undefined;
      cursor = page.cursor;
    }
  }

  /**
   * Fold a bump report if it is complete: consecutive slots starting right
   * after what we had seen, ending at our own event. Anything short of that
   * (a World that reports nothing for this event type, a gap) returns
   * undefined and the caller re-lists.
   */
  private foldReport(result: { events?: Event[] }, event: Event | undefined, request: CreateEventRequest): Event[] | undefined {
    const report = result.events;
    if (!event || !Array.isArray(report) || report.length === 0) return undefined;
    const ownSlot = eventIdToSlot(event.eventId);
    if (ownSlot === null) return undefined;
    const withOwn = report.some((e) => e.eventId === event.eventId) ? report : [...report, event];
    const fresh = withOwn.filter((e) => this.isNew(e));
    let expected = this.state.eventCount + 1;
    for (const e of fresh) {
      if (eventIdToSlot(e.eventId) !== expected) return undefined;
      expected++;
    }
    if (expected - 1 !== ownSlot) return undefined;
    // As on the fast path: fold what we wrote for our own event.
    const sent = fresh.map((e) =>
      e.eventId === event.eventId && 'eventData' in request && e.eventType === request.eventType
        ? ({ ...e, eventData: request.eventData } as Event)
        : e
    );
    const effective = new Set<Event>();
    fold(this.state, sent, (e, ok) => ok && effective.add(e));
    this.lastEffective = effective;
    this.folded(sent);
    return sent;
  }

  private isNew(event: Event): boolean {
    const slot = eventIdToSlot(event.eventId);
    return slot === null || slot > this.state.eventCount;
  }
}

/**
 * The `step_created` a born-running `step_started` committed ahead of itself
 * at `slot`, rebuilt from the request, when the World says this write created
 * the step and returned no report. Undefined otherwise.
 */
function bornRunningCreate(request: CreateEventRequest, result: unknown, event: Event, slot: number): Event | undefined {
  if (request.eventType !== 'step_started' || event.eventType !== 'step_started') return undefined;
  const r = result as { stepCreated?: boolean; events?: unknown };
  if (r.stepCreated !== true || Array.isArray(r.events)) return undefined;
  const data = (request as { eventData?: { stepName?: string; input?: unknown } }).eventData;
  const correlationId = (request as { correlationId?: string }).correlationId;
  if (!data || data.input === undefined || typeof data.stepName !== 'string' || correlationId !== event.correlationId) return undefined;
  return {
    ...event,
    eventId: slotToEventId(slot),
    eventType: 'step_created',
    correlationId,
    eventData: { stepName: data.stepName, input: data.input },
  } as Event;
}
