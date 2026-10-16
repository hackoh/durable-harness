import type { World } from '@workflow/world';
import { stringify, unflatten } from 'devalue';
import { markTime, PROCESS_ID } from './marks.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A UTF-16 surrogate without its other half. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * One stream line: devalue text, which is what the Workflow runtime writes
 * for a stream when it does not frame it, so `workflow inspect stream`, the
 * dashboard and anything else that reads runtime streams decode it. The
 * value is first reshaped the way `JSON.stringify` always reshaped it (a
 * `toJSON`, a Date as a string, class instances as plain objects, undefined
 * keys dropped), so readers see exactly what they saw when lines were JSON.
 *
 * devalue writes a lone surrogate as is, which UTF-8 then turns into U+FFFD
 * (a model's text streamed in pieces can split a surrogate pair, and a
 * journal blob's hash is over its exact text); JSON escapes it, so it is
 * escaped here too. A value devalue refuses outright (a `__proto__` key)
 * goes out as JSON text, which `decodeLine` still reads.
 */
export function encodeLine(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  let text: string;
  try {
    text = stringify(JSON.parse(json));
  } catch {
    return json;
  }
  return text.replace(LONE_SURROGATE, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

/**
 * The value of one stream line: devalue text (`encodeLine`), or the JSON a
 * line held before streams were devalue. devalue text is always a JSON
 * array, or a negative number for a bare special value; every value written
 * as JSON was an object, a string or a non-negative number.
 */
export function decodeLine(line: string): unknown {
  const parsed = JSON.parse(line) as unknown;
  return Array.isArray(parsed) || (typeof parsed === 'number' && parsed < 0) ? unflatten(parsed as never) : parsed;
}

/**
 * Stream names are global in some Worlds (world-local keys chunk directories
 * by name alone), so every name is prefixed with the run id.
 */
export const liveStreamName = (runId: string) => `${runId}_live`;
export const effectStreamName = (runId: string, stepId: string) =>
  `${runId}_${stepId}`;

/**
 * Ordered, fire-and-forget line writer (one `encodeLine` value per line;
 * the name is from when lines were JSON). Writes to one stream are
 * chained so chunks land in the order they were produced; lines produced
 * while a write is in flight are coalesced into the next chunk, so a World
 * behind a network hop (a remote World in a tab) costs one request per
 * round trip rather than one per token. Failures are swallowed because
 * streams carry UI and partial output, never state.
 *
 * Each chunk ends with an empty line: a chunk boundary a reader can count
 * (`tailJsonLines` resumes a dropped read at the next chunk with it). Every
 * reader skips empty lines.
 *
 * A write that takes longer than `deadlineMs` no longer holds back the lines
 * behind it: the next chunk goes out alongside it (live lines are
 * best-effort; the log is the source of truth), and a `stream.put_slow`
 * mark rides in the next chunk so a reader can attribute the stall.
 * Lines produced in the same synchronous burst share one chunk. (Not a
 * macrotask: waiting one widens the window in which a process that dies
 * loses progress it already reported, which is an interrupted effect's
 * `partial`.)
 */
export class JsonLinesWriter {
  private tail: Promise<void> = Promise.resolve();
  private buffer = '';
  /** Puts not yet answered, including ones past their deadline. */
  private readonly inflight = new Set<Promise<void>>();
  /** The buffered chunk holds a turn's end (see `write`). */
  private barrier = false;
  private readonly deadlineMs: number;
  private readonly slowMarks: boolean;
  /** A line was written: the stream exists (a World creates a stream on its first write). */
  private wrote = false;
  private closed = false;

  constructor(
    private readonly world: World,
    private readonly runId: string,
    private readonly name: string,
    options: { deadlineMs?: number; slowMarks?: boolean } = {}
  ) {
    this.deadlineMs = options.deadlineMs ?? WRITE_DEADLINE_MS;
    this.slowMarks = options.slowMarks ?? true;
  }

  write(value: unknown): void {
    if (this.closed) return;
    this.wrote = true;
    localTap()?.(this.runId, this.name, value);
    const pending = this.buffer.length > 0;
    this.buffer += `${encodeLine(value)}\n`;
    if (isTurnEnd(value)) this.barrier = true;
    if (pending) return; // Already scheduled: rides along with that chunk.
    this.tail = this.tail
      .then(async () => {
        // A turn's end (the harness's idle, the kernel's idle mark) must not
        // overtake its output: a reader that sees the idle before a slow
        // chunk of text closes the turn without it (or, waiting for output
        // first, never closes it). It waits for every write still in flight.
        // Bounded: a put that never answers must not hold the end back for good.
        if (this.barrier) {
          this.barrier = false;
          if (this.inflight.size) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              Promise.all(this.inflight),
              new Promise<void>((r) => {
                timer = setTimeout(r, TURN_END_WAIT_MS);
              }),
            ]);
            clearTimeout(timer);
          }
        }
        const chunk = encoder.encode(`${this.buffer}\n`);
        this.buffer = '';
        const t0 = markTime();
        const put = this.world.streams.write(this.runId, this.name, chunk).catch(() => {});
        this.inflight.add(put);
        void put.finally(() => this.inflight.delete(put));
        if (!(this.deadlineMs > 0)) return put;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<'late'>((r) => {
          timer = setTimeout(() => r('late'), this.deadlineMs);
        });
        return Promise.race([put.then(() => 'ok' as const), late]).then((outcome) => {
          clearTimeout(timer);
          if (outcome === 'ok') return;
          // Still in flight: let the next chunk go, and say so in it.
          if (this.slowMarks) {
            void put.then(() => {
              this.write({ type: 'mark', name: 'stream.put_slow', t: markTime(), pid: PROCESS_ID, runId: this.runId, stream: this.name, ms: Math.round(markTime() - t0), landed: true });
            });
          }
        });
      })
      .catch(() => {});
  }

  /** Every write issued so far has landed (or failed), including slow ones. */
  flush(): Promise<void> {
    return this.tail;
  }

  /**
   * End the stream (`streams.close`) once every line has landed, so a reader
   * that tails it (`workflow inspect stream`, a UI) sees it end. Nothing is
   * written after. A writer that wrote nothing closes nothing (closing would
   * create an empty stream that every listing then shows). Best effort, like
   * the writes.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.wrote) return;
    await this.flush();
    await this.world.streams.close(this.runId, this.name).catch(() => {});
  }
}

/** The kernel's own per-session streams (`hints` is hints.ts's `hintsStreamName`). */
export const kernelStreamNames = (runId: string): string[] => [
  liveStreamName(runId),
  `${runId}_hints`,
];

/**
 * End every stream of a run: a session that is over writes nothing more, and
 * a reader tailing one of its streams (`workflow inspect stream`, the live
 * tail) should see it end rather than wait forever. Best effort.
 *
 * `known` names are closed too when they hold anything, listed or not: a
 * World can leave a stream out of its listing (world-local registers a run's
 * streams with a read-modify-write of one file, so two streams first written
 * at once can lose one of the names).
 */
export async function closeRunStreams(world: World, runId: string, known: string[] = []): Promise<void> {
  const listed = await world.streams.list(runId).catch(() => [] as string[]);
  const unlisted = await Promise.all(
    known
      .filter((name) => !listed.includes(name))
      .map(async (name) => (((await world.streams.getInfo(runId, name).catch(() => undefined))?.tailIndex ?? -1) >= 0 ? name : undefined))
  );
  const names = [...listed, ...unlisted.filter((n): n is string => n !== undefined)];
  await Promise.all(names.map((name) => world.streams.close(runId, name).catch(() => {})));
}

/**
 * A same-process tap on every line a writer produces, before it reaches the
 * World (`setLocalLiveTap`). A page that drives a session itself (the tab
 * lane) shows its own output from here instead of waiting for it to go
 * round the World's stream, which over a network hop arrives in bursts of
 * one round trip each. Process-wide on purpose: the writer and the reader
 * may be different copies of this module.
 */
export type LocalLiveTap = (runId: string, name: string, value: unknown) => void;
const TAP = Symbol.for('harness-world.localLiveTap');
const localTap = () => (globalThis as { [TAP]?: LocalLiveTap })[TAP];
export function setLocalLiveTap(tap: LocalLiveTap | undefined): void {
  (globalThis as { [TAP]?: LocalLiveTap })[TAP] = tap;
}

/** A line that ends a turn: the harness's `idle`, or the kernel's `idle` mark. */
function isTurnEnd(value: unknown): boolean {
  const v = value as { type?: unknown; name?: unknown } | null;
  return !!v && typeof v === 'object' && (v.type === 'idle' || (v.type === 'mark' && v.name === 'idle'));
}

/** The longest a turn's end waits for the output still in flight ahead of it. */
export const TURN_END_WAIT_MS = 10_000;

/** A live write slower than this stops holding back the ones behind it. */
export const WRITE_DEADLINE_MS = 1000;

/** Read every line currently in a stream (a snapshot, not a tail), decoded (`decodeLine`). */
export async function readJsonLines(
  world: World,
  runId: string,
  name: string
): Promise<unknown[]> {
  const out: unknown[] = [];
  let buffer = '';
  let cursor: string | undefined;
  try {
    for (;;) {
      const page = await world.streams.getChunks(runId, name, {
        ...(cursor ? { cursor } : {}),
      });
      for (const chunk of page.data) {
        buffer += decoder.decode(chunk.data, { stream: true });
      }
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
  } catch {
    return out; // No such stream: the effect produced no progress.
  }
  for (const line of buffer.split('\n')) {
    if (line) out.push(decodeLine(line));
  }
  return out;
}

export interface TailOptions {
  /** The chunk to start at. Negative: the last N chunks (no cursors, no resume). */
  startIndex?: number;
  /**
   * Lines past `startIndex` to drop before yielding anything: the ones a
   * reader already has. They still count toward the cursors that follow.
   */
  skip?: number;
  /**
   * Resume where a reader left off: a cursor from `tailJsonLinesAt` (an SSE
   * `id`, a `Last-Event-ID`). Overrides `startIndex` and `skip`.
   */
  cursor?: string;
  signal?: AbortSignal;
  /**
   * Re-open the read when it fails or ends while `signal` is live (default
   * true). A live read is capped by the World (world-vercel ends one
   * after a few minutes, with an error): without this the tail just stops.
   */
  resume?: boolean;
  /** Called on every re-open. */
  onResume?: (info: { attempt: number; skip: number; error?: string }) => void;
  /**
   * A read that delivered nothing for this long is checked against the
   * stream's tail (`getInfo`): if the stream holds more chunks than this
   * read has seen chunk boundaries for, the read missed its wakeup and is
   * re-opened (a fresh read gets a fresh wakeup). At most one such re-open
   * per `quietMs * 4`. Default off.
   */
  quietMs?: number;
}

/**
 * A position in a JSON-lines stream: the chunk a tail started at, and how
 * many lines past it a reader has. Chunk indices alone are not a safe
 * resume point (a World may store one write as several chunks, so a line
 * can straddle two of them), but re-reading from the same start yields the
 * same lines in the same order, so (start, lines) names one place in the
 * stream on every World. Resuming re-reads the `lines` it skips, so a
 * cursor costs what was read since its start: start each turn's tail at
 * `liveEnd()`, not 0.
 */
export interface StreamPosition {
  startIndex: number;
  lines: number;
}

/** An opaque cursor for `position` (safe as an SSE `id`). */
export function encodeCursor(position: StreamPosition): string {
  return `${position.startIndex}.${position.lines}`;
}

/** The position a cursor names, or `undefined` if it is not one. */
export function decodeCursor(cursor: string): StreamPosition | undefined {
  const match = /^(\d{1,15})\.(\d{1,15})$/.exec(cursor.trim());
  return match ? { startIndex: Number(match[1]), lines: Number(match[2]) } : undefined;
}

/** A line of a tailed stream, with the cursor that resumes just past it. */
export interface TailEntry {
  value: unknown;
  cursor: string;
}

/**
 * Tail a line stream (`encodeLine`) until `signal` aborts (or, with `resume: false`,
 * until the read ends). A dropped read is re-opened from the tail's own
 * start and the lines it already yielded are skipped: chunk indices are not
 * trusted as a resume point (a World may store a write as more than one
 * chunk), but the order of the stream's lines is. A stream that is closed
 * (`getInfo().done`) ends the tail.
 */
export async function* tailJsonLines(
  world: World,
  runId: string,
  name: string,
  options: TailOptions = {}
): AsyncGenerator<unknown> {
  for await (const line of tailLines(world, runId, name, options)) yield line.value;
}

/**
 * `tailJsonLines`, with a cursor on every line: pass the last one back as
 * `cursor` (in this process or another) to continue with the line after
 * it, nothing lost and nothing twice. Needs a start at or past 0.
 */
export async function* tailJsonLinesAt(
  world: World,
  runId: string,
  name: string,
  options: TailOptions = {}
): AsyncGenerator<TailEntry> {
  const { startIndex } = resolveStart(options);
  if (startIndex < 0) throw new TypeError('harness-world: a tail with cursors needs a startIndex of 0 or more');
  for await (const line of tailLines(world, runId, name, options)) {
    yield { value: line.value, cursor: encodeCursor({ startIndex, lines: line.lines }) };
  }
}

function resolveStart(options: TailOptions): StreamPosition {
  if (options.cursor !== undefined) {
    const position = decodeCursor(options.cursor);
    if (!position) throw new TypeError(`harness-world: not a stream cursor: ${JSON.stringify(options.cursor)}`);
    return position;
  }
  return { startIndex: options.startIndex ?? 0, lines: Math.max(0, Math.floor(options.skip ?? 0)) };
}

async function* tailLines(
  world: World,
  runId: string,
  name: string,
  options: TailOptions
): AsyncGenerator<{ value: unknown; lines: number }> {
  const { startIndex: start, lines: initialSkip } = resolveStart(options);
  // Negative (last-N) starts have no fixed position to re-read from.
  const resume = (options.resume ?? true) && start >= 0;
  const signal = options.signal;
  /** Lines past `start` read so far: skipped up front, or yielded. */
  let total = initialSkip;
  let streak = 0;
  let lastQuietReopen = 0;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return;
    let skip = total;
    const before = total;
    let failure: string | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let quiet: ReturnType<typeof setInterval> | undefined;
    const onAbort = () => reader?.cancel().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const stream = await world.streams.get(runId, name, start);
      reader = stream.getReader();
      if (signal?.aborted) onAbort();
      let last = Date.now();
      /** Chunk boundaries (`JsonLinesWriter`'s empty lines) this read has seen past `start`. */
      let boundaries = 0;
      if (options.quietMs && start >= 0) {
        const quietMs = options.quietMs;
        let checking = false;
        quiet = setInterval(() => {
          const t = Date.now();
          if (checking || t - last < quietMs || t - lastQuietReopen < quietMs * 4 || skip > 0) return;
          checking = true;
          const seen = boundaries;
          world.streams
            .getInfo(runId, name)
            .then((info) => {
              if (info.tailIndex + 1 - start > seen && boundaries === seen && Date.now() - last >= quietMs) {
                failure = 'quiet';
                lastQuietReopen = Date.now();
                reader?.cancel().catch(() => {});
              }
            })
            .catch(() => {})
            .finally(() => {
              checking = false;
            });
        }, Math.max(100, Math.round(quietMs / 3)));
      }
      let buffer = '';
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        last = Date.now();
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) {
            boundaries++;
            continue;
          }
          if (skip > 0) {
            skip--;
            continue;
          }
          const value = decodeLine(line);
          total++;
          yield { value, lines: total };
        }
      }
    } catch (err) {
      failure ??= err instanceof Error ? err.message : String(err);
    } finally {
      clearInterval(quiet);
      signal?.removeEventListener('abort', onAbort);
      try {
        reader?.releaseLock();
      } catch {}
    }
    if (!resume || signal?.aborted) return;
    streak = total > before ? 0 : streak + 1;
    if (!failure) {
      // A clean end: trust it only if the stream says it is closed.
      const info = await world.streams.getInfo(runId, name).catch(() => undefined);
      if (!info || info.done) return;
    }
    options.onResume?.({ attempt: attempt + 1, skip: total, ...(failure ? { error: failure } : {}) });
    await new Promise((r) => setTimeout(r, failure === 'quiet' ? 0 : Math.min(2000, 100 * 2 ** Math.min(streak, 4))));
  }
}
