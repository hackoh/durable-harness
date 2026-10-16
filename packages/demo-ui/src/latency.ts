/**
 * Latency the page can see: per turn, time to the
 * first output and turn time measured here, from the moment this page sent the
 * message to the moment its text and its `idle` arrived; and the durability
 * lag, from the `ack` marks every durable write reports.
 *
 * Kept free of React so the timing logic is testable on its own.
 */

export interface TurnTiming {
  /** Local clock (`performance.now()` based wall clock), when the page sent it. */
  sentAt: number;
  kind: 'prompt' | 'steer';
  /** The submission's id, from its `submit` mark (so the chip lands on the right turn). */
  subId?: string;
  firstTokenAt?: number;
  /** The first output of the turn: text, or a tool starting (/compare's definition), and how long after the send. */
  firstOutputAt?: number;
  firstOutput?: number;
  /**
   * When the turn ended for the harness: its own `idle` (Native, and the
   * harness's idle inside a durable drive). Comparable across every lane.
   */
  idleAt?: number;
  ttft?: number;
  /** Send → harness idle. */
  turn?: number;
  /** Durable lanes: send → the kernel's `idle` mark (everything the turn wrote is durable), rounded for display. */
  durableAt?: number;
  /**
   * Durable lanes: when the kernel's `idle` mark arrived (absolute, page
   * clock, unrounded). Where the turn ends: rounding it could put the end a
   * fraction of a millisecond before an output that arrived in the same
   * chunk, and that output would fall outside the turn.
   */
  durableEndAt?: number;
  /** The driving process's own view: request out → first token (the model, nothing of ours). */
  modelTtft?: number;
  /** Any output of this turn seen (text or a tool call). */
  output?: boolean;
  /** Drives that placed this turn's submission (from `intent` marks): only their idle ends it. */
  drvs?: string[];
  /** Drives that wrote an intent during this turn (a takeover finishing it counts too). */
  workers?: string[];
  /**
   * Never closed: a later turn's own drive went idle while this one still
   * waited (its end, or its output, never arrived). Left out of the numbers
   * instead of holding every later turn open behind it.
   */
  lost?: boolean;
  /** Its own drive's idle mark arrived before any of its output (a slow chunk landed late): it ends on that output. */
  idleSeenAt?: number;
  /** How long the session refused the message as not ready (still starting) before accepting it; `sentAt` is after it. */
  notReadyMs?: number;
}

export interface Durable {
  /** Acks seen for this session. */
  acks: number;
  /** Recent ack latencies (ms), newest last. */
  recent: number[];
  /** Run-ahead: how far behind the harness each write became durable (`ack.aheadMs`), most recent last. */
  ahead: number[];
}

/** A prompt turn open longer than this when the next prompt is sent is given up as lost. */
export const LOST_AFTER_MS = 60_000;

const now = () => (typeof performance !== 'undefined' ? performance.timeOrigin + performance.now() : Date.now());

/** One session's turn timings, fed with sends and live events. */
export class LatencyTracker {
  readonly turns: TurnTiming[] = [];
  readonly durable: Durable = { acks: 0, recent: [], ahead: [] };
  private listeners = new Set<() => void>();
  private request?: { pid: string; t: number };
  private marks = false;
  /** Whether this session's intents name the submissions they place (the durable kernel's do). */
  private placing = false;
  private lastOutputAt?: number;
  /** Which drives placed each submission (an intent can arrive before its submission's own mark: run-ahead). */
  private placedBy = new Map<string, string[]>();
  private lastBareIdleAt?: number;

  sent(kind: 'prompt' | 'steer', at = now()): void {
    // A prompt still open this long after it was sent is not going to end in
    // order (its end or its output was lost): stop attributing to it.
    if (kind === 'prompt') {
      for (const t of this.turns) if (t.kind === 'prompt' && t.idleAt === undefined && !t.lost && at - t.sentAt > LOST_AFTER_MS) t.lost = true;
    }
    this.turns.push({ sentAt: at, kind });
    this.changed();
  }

  /**
   * The session only accepted `turn`'s message `ms` after it was sent: it was
   * still starting (eve's prewarmed session, `SendReceipt.notReadyMs`), which
   * the other lanes pay before their first send. The turn's clock starts at
   * the attempt it accepted, and the wait is kept on the turn.
   */
  startedLate(turn: TurnTiming, ms: number): void {
    if (!(ms > 0)) return;
    turn.sentAt += ms;
    turn.notReadyMs = (turn.notReadyMs ?? 0) + Math.round(ms);
    if (turn.firstTokenAt !== undefined) turn.ttft = Math.round(turn.firstTokenAt - turn.sentAt);
    if (turn.firstOutputAt !== undefined) turn.firstOutput = Math.round(turn.firstOutputAt - turn.sentAt);
    if (turn.idleAt !== undefined) turn.turn = Math.round(turn.idleAt - turn.sentAt);
    if (turn.durableEndAt !== undefined) turn.durableAt = Math.round(turn.durableEndAt - turn.sentAt);
    else if (turn.durableAt !== undefined) turn.durableAt = Math.round(turn.durableAt - ms);
    this.changed();
  }

  /** Feed a live event; `at` is when it arrived. */
  event(e: any, at = now()): void {
    if (!e || typeof e !== 'object') return;
    const open = this.turns.filter((t) => t.kind === 'prompt' && t.idleAt === undefined && !t.lost);
    let cur = open[0];
    // The idle of a drive that worked on a *later* open turn: every turn
    // before it is lost (it can no longer end in order), not a reason to
    // keep the later one open too.
    if (e.type === 'mark' && e.name === 'idle' && typeof e.drv === 'string' && cur && !(cur.output && at >= cur.sentAt && this.ends(cur, e))) {
      const later = open.findIndex((t, i) => i > 0 && at >= t.sentAt && (t.drvs?.includes(e.drv) || t.workers?.includes(e.drv)));
      if (later > 0) {
        for (const t of open.slice(0, later)) t.lost = true;
        cur = open[later];
      }
    }
    if (e.type === 'mark') {
      // Model and tool marks come from every lane (Native too); only the
      // durable kernel's own marks mean an `idle` mark will end the turn.
      if (!String(e.name ?? '').startsWith('model.') && !String(e.name ?? '').startsWith('tool.')) this.marks = true;
      if (e.name === 'idle' && cur && !cur.output && at >= cur.sentAt && typeof e.drv === 'string' && (cur.drvs?.includes(e.drv) || cur.workers?.includes(e.drv))) {
        cur.idleSeenAt = at;
      } else if (e.name === 'idle' && cur && cur.output && at >= cur.sentAt && this.ends(cur, e)) {
        // The harness went idle at its own idle (the last one after the
        // turn's last output); everything it wrote was durable at this mark.
        const harness = this.lastBareIdleAt !== undefined && this.lastOutputAt !== undefined && this.lastBareIdleAt >= this.lastOutputAt ? this.lastBareIdleAt : at;
        cur.idleAt = harness;
        cur.turn = Math.round(harness - cur.sentAt);
        cur.durableEndAt = at;
        cur.durableAt = Math.round(at - cur.sentAt);
        this.changed();
      } else if (e.name === 'ack' && typeof e.lagMs === 'number') {
        this.durable.acks++;
        this.durable.recent.push(e.lagMs);
        if (this.durable.recent.length > 40) this.durable.recent.shift();
        if (typeof e.aheadMs === 'number') {
          this.durable.ahead.push(e.aheadMs);
          if (this.durable.ahead.length > 40) this.durable.ahead.shift();
        }
        this.changed();
      } else if (e.name === 'submit' && typeof e.id === 'string') {
        const waiting = this.turns.find((t) => t.subId === undefined && t.kind === e.kind);
        if (waiting) {
          waiting.subId = e.id;
          const by = this.placedBy.get(e.id);
          if (by) waiting.drvs = [...by];
        }
      } else if (
        e.name === 'intent' &&
        cur &&
        typeof e.drv === 'string' &&
        at >= cur.sentAt &&
        // An intent placing another turn's submission works on that turn.
        !(Array.isArray(e.placed) && e.placed.length && !(cur.subId && e.placed.includes(cur.subId))) &&
        !(cur.workers ??= []).includes(e.drv)
      ) {
        cur.workers.push(e.drv);
      }
      if (e.name === 'intent' && Array.isArray(e.placed) && e.placed.length) {
        this.placing = true;
        if (typeof e.drv === 'string') {
          for (const id of e.placed as string[]) {
            const by = this.placedBy.get(id) ?? [];
            if (!by.includes(e.drv)) this.placedBy.set(id, [...by, e.drv]);
          }
          for (const t of this.turns) {
            if (t.subId && e.placed.includes(t.subId) && !(t.drvs ??= []).includes(e.drv)) t.drvs.push(e.drv);
          }
        }
      } else if (e.name === 'model.request') {
        this.request = { pid: e.pid, t: e.t };
      } else if (e.name === 'model.first_token' && cur && cur.modelTtft === undefined && this.request?.pid === e.pid) {
        cur.modelTtft = Math.round(e.t - this.request!.t);
      }
      return;
    }
    if (!cur) return;
    if (e.type === 'text' || e.type === 'tool_start' || e.type === 'tool_end') {
      if (e.type !== 'tool_end') cur.output = true;
      this.lastOutputAt = at;
    }
    if ((e.type === 'text' || e.type === 'tool_start') && cur.firstOutputAt === undefined) {
      cur.firstOutputAt = at;
      cur.firstOutput = Math.round(at - cur.sentAt);
      this.changed();
    }
    if (e.type === 'text' && cur.firstTokenAt === undefined) {
      cur.firstTokenAt = at;
      cur.ttft = Math.round(at - cur.sentAt);
      this.changed();
    }
    if (cur.idleSeenAt !== undefined && cur.output) {
      // Its drive already said idle: this late output is the last of it.
      cur.idleAt = at;
      cur.turn = Math.round(at - cur.sentAt);
      cur.durableEndAt = Math.max(at, cur.idleSeenAt);
      cur.durableAt = Math.round(cur.durableEndAt - cur.sentAt);
      this.changed();
      return;
    }
    if (e.type === 'text') {
      // (first token handled above)
    } else if (e.type === 'idle') {
      this.lastBareIdleAt = at;
      if (!this.marks && cur.output && at >= cur.sentAt) {
        // A server without marks: the harness's own idle (Pi also sends one
        // after replaying a turn, so the kernel's mark is preferred).
        cur.idleAt = at;
        cur.turn = Math.round(at - cur.sentAt);
        this.changed();
      }
    }
  }

  /**
   * Whether an `idle` mark ends `turn`: only the idle of a drive that placed
   * the turn's submission does. A trailing drive (a companion, a queue
   * redelivery) that ran nothing also says idle, possibly after the next
   * turn's first output, and must not close it. Sessions whose intents do
   * not name submissions (or before any arrived) take any idle.
   */
  private ends(turn: TurnTiming, idle: any): boolean {
    if (typeof idle.drv !== 'string') return true; // An unattributed idle (a server without drive ids).
    // A drive that worked on this turn (placed it, or took it over and wrote
    // its effects) ends it; one that ran nothing does not.
    if (turn.drvs?.includes(idle.drv) || turn.workers?.includes(idle.drv)) return true;
    if (turn.drvs?.length) return false;
    // Nothing has placed this turn yet: in a session whose intents name
    // what they place, this idle belongs to someone else's drive.
    return !(this.placing && turn.subId);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }
}

/** A duration: "840 ms", "1.24 s", "12.4 s"; a negative one (an overhead under its baseline) with a minus sign, as a Δ has. */
export const fmtSeconds = (ms: number): string =>
  Math.round(ms) < 0 ? `−${fmtSeconds(-ms)}` : ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
export const fmtDelta = (ms: number) => `${ms >= 0 ? '+' : '−'}${fmtSeconds(Math.abs(ms))}`;

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
