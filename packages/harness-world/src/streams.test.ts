import type { World } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { parse } from 'devalue';
import { decodeCursor, decodeLine, encodeCursor, encodeLine, JsonLinesWriter, readJsonLines, tailJsonLines, tailJsonLinesAt } from './streams.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
/** The values in one written chunk. */
const valuesOf = (chunk: Uint8Array) => dec.decode(chunk).split('\n').filter(Boolean).map((l) => decodeLine(l) as Record<string, unknown>);

/**
 * A stream store whose live reads can be cut (`cut()` errors every open
 * read, as world-vercel does at its cap) or made deaf (`deaf`:
 * reads open but never hear of new chunks, a missed wakeup).
 */
function fakeWorld(opts: { writeMs?: (i: number) => number } = {}) {
  const chunks: Uint8Array[] = [];
  const readers = new Set<{ push: () => void; fail: (e: Error) => void; deaf: boolean }>();
  let deaf = false;
  let opens = 0;
  let writes = 0;
  const world = {
    streams: {
      async write(_r: string, _n: string, chunk: Uint8Array) {
        const i = writes++;
        const ms = opts.writeMs?.(i) ?? 0;
        if (ms) await new Promise((r) => setTimeout(r, ms));
        chunks.push(chunk);
        for (const r of readers) if (!r.deaf) r.push();
      },
      async get(_r: string, _n: string, startIndex = 0) {
        opens++;
        let next = startIndex;
        let entry!: { push: () => void; fail: (e: Error) => void; deaf: boolean };
        return new ReadableStream<Uint8Array>({
          start(controller) {
            entry = {
              deaf,
              push: () => {
                while (next < chunks.length) controller.enqueue(chunks[next++]!);
              },
              fail: (e) => controller.error(e),
            };
            readers.add(entry);
            entry.push();
          },
          cancel() {
            readers.delete(entry);
          },
        });
      },
      async getInfo() {
        return { tailIndex: chunks.length - 1, done: false };
      },
      async getChunks() {
        return { data: chunks.map((data, i) => ({ index: i, data })), hasMore: false, cursor: null, done: false };
      },
    },
  } as unknown as World;
  return {
    world,
    chunks,
    get opens() {
      return opens;
    },
    cut() {
      for (const r of readers) r.fail(new Error('max duration'));
      readers.clear();
    },
    set deaf(v: boolean) {
      deaf = v;
      for (const r of readers) r.deaf = v;
    },
    raw(text: string) {
      chunks.push(enc.encode(text));
      for (const r of readers) if (!r.deaf) r.push();
    },
  };
}

async function collect(it: AsyncGenerator<unknown>, n: number, timeoutMs = 3000): Promise<unknown[]> {
  const out: unknown[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const v of it) {
    out.push(v);
    if (out.length >= n || Date.now() > deadline) break;
  }
  return out;
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('tailJsonLines', () => {
  it('re-opens a cut read and delivers nothing twice', async () => {
    const f = fakeWorld();
    const w = new JsonLinesWriter(f.world, 'r', 'live');
    const resumes: unknown[] = [];
    const abort = new AbortController();
    const got = collect(tailJsonLines(f.world, 'r', 'live', { signal: abort.signal, onResume: (i) => resumes.push(i) }), 5);
    w.write({ n: 1 });
    w.write({ n: 2 }); // same chunk as n:1
    await w.flush();
    await tick(30);
    f.cut();
    await tick(30);
    w.write({ n: 3 });
    await w.flush();
    f.cut();
    w.write({ n: 4 });
    w.write({ n: 5 });
    await w.flush();
    expect(await got).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
    abort.abort();
    expect(resumes.length).toBeGreaterThanOrEqual(1);
    expect(f.opens).toBeGreaterThanOrEqual(2);
  });

  it('resumes after a partly delivered chunk by skipping the lines it already yielded', async () => {
    const f = fakeWorld();
    f.raw('{"n":1}\n{"n":2}\n\n');
    const abort = new AbortController();
    const it = tailJsonLines(f.world, 'r', 'live', { signal: abort.signal });
    const first = await it.next();
    expect(first.value).toEqual({ n: 1 });
    f.cut(); // mid-chunk: n:2 was read but not yet yielded
    f.raw('{"n":3}\n\n');
    const rest = await collect(it, 2);
    expect(rest).toEqual([{ n: 2 }, { n: 3 }]);
    abort.abort();
  });

  it('a stream without chunk boundaries resumes too, skipping every delivered line', async () => {
    const f = fakeWorld();
    f.raw('{"n":1}\n');
    f.raw('{"n":2}\n');
    const abort = new AbortController();
    const it = tailJsonLines(f.world, 'r', 'live', { signal: abort.signal });
    expect(await collect(it, 2)).toEqual([{ n: 1 }, { n: 2 }]);
    const it2 = tailJsonLines(f.world, 'r', 'live', { signal: abort.signal });
    const p = collect(it2, 3);
    await tick(30);
    f.cut();
    f.raw('{"n":3}\n');
    expect(await p).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    abort.abort();
  });

  it('resumes correctly when the World splits a write into several chunks (indices are not trusted)', async () => {
    const f = fakeWorld();
    f.raw('{"n":1}\n');
    f.raw('\n'); // the boundary of that write, stored as its own chunk
    f.raw('{"n":2}\n\n');
    const abort = new AbortController();
    const it = tailJsonLines(f.world, 'r', 'live', { signal: abort.signal });
    expect(await collect(it, 2)).toEqual([{ n: 1 }, { n: 2 }]);
    const it2 = tailJsonLines(f.world, 'r', 'live', { signal: abort.signal });
    const p = collect(it2, 3);
    await tick(30);
    f.cut();
    f.raw('{"n":3}\n\n');
    expect(await p).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    abort.abort();
  });

  it('re-opens a read that missed its wakeup once the stream has chunks it has not delivered', async () => {
    const f = fakeWorld();
    const w = new JsonLinesWriter(f.world, 'r', 'live');
    const abort = new AbortController();
    const resumes: { error?: string }[] = [];
    const got = collect(tailJsonLines(f.world, 'r', 'live', { signal: abort.signal, quietMs: 150, onResume: (i) => resumes.push(i) }), 2);
    w.write({ n: 1 });
    await w.flush();
    await tick(30);
    f.deaf = true; // the open read never hears of the next chunk
    w.write({ n: 2 });
    await w.flush();
    f.deaf = false; // a fresh read does
    expect(await got).toEqual([{ n: 1 }, { n: 2 }]);
    expect(resumes.some((r) => r.error === 'quiet')).toBe(true);
    abort.abort();
  });

  it('with resume off, ends when the read fails', async () => {
    const f = fakeWorld();
    f.raw('{"n":1}\n\n');
    const it = tailJsonLines(f.world, 'r', 'live', { resume: false });
    expect((await it.next()).value).toEqual({ n: 1 });
    f.cut();
    expect((await it.next()).done).toBe(true);
  });
});

describe('JsonLinesWriter', () => {
  it('ends each chunk with an empty line that every reader skips', async () => {
    const f = fakeWorld();
    const w = new JsonLinesWriter(f.world, 'r', 'live');
    w.write({ a: 1 });
    await w.flush();
    expect(new TextDecoder().decode(f.chunks[0])).toBe('[{"a":1},1]\n\n');
    expect(await readJsonLines(f.world, 'r', 'live')).toEqual([{ a: 1 }]);
  });

  it('coalesces lines written in the same synchronous burst into one chunk', async () => {
    const f = fakeWorld();
    const w = new JsonLinesWriter(f.world, 'r', 'live');
    w.write({ name: 'model.done' });
    w.write({ type: 'tool_start' });
    await w.flush();
    expect(f.chunks.length).toBe(1);
  });

  it('sends a line before the next macrotask, so a process that dies right after reporting progress keeps it', async () => {
    const f = fakeWorld();
    const w = new JsonLinesWriter(f.world, 'r', 'step:x');
    w.write({ started: 'HELLO' });
    let sentBeforeMacrotask = false;
    await new Promise<void>((r) => setTimeout(() => { sentBeforeMacrotask = f.chunks.length > 0; r(); }, 0));
    expect(sentBeforeMacrotask).toBe(true);
  });

  it('a write past its deadline does not hold back the next one, and is reported', async () => {
    const f = fakeWorld({ writeMs: (i) => (i === 0 ? 400 : 0) });
    const w = new JsonLinesWriter(f.world, 'r', 'live', { deadlineMs: 50 });
    const t0 = Date.now();
    w.write({ n: 1 });
    await tick(5);
    await tick(80);
    w.write({ n: 2 });
    await tick(30);
    // n:2 landed while n:1 was still in flight.
    const landed = () => f.chunks.map(valuesOf);
    expect(landed().some((c) => c.some((v) => v.n === 2))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(400);
    await tick(450);
    await w.flush();
    expect(landed().some((c) => c.some((v) => v.name === 'stream.put_slow'))).toBe(true);
  });

  it("a turn's end does not overtake a slow chunk of its output", async () => {
    const f = fakeWorld({ writeMs: (i) => (i === 0 ? 300 : 0) });
    const w = new JsonLinesWriter(f.world, 'r', 'live', { deadlineMs: 50, slowMarks: false });
    w.write({ type: 'text', delta: 'hello' });
    await tick(80);
    // Past its deadline: other lines go alongside it...
    w.write({ type: 'tool_end', n: 1 });
    await tick(20);
    const landed = () => f.chunks.map(valuesOf);
    expect(landed().some((c) => c.some((v) => v.type === 'tool_end'))).toBe(true);
    // ...but the turn's end waits for it.
    w.write({ type: 'idle' });
    w.write({ type: 'mark', name: 'idle', t: 1 });
    await tick(20);
    expect(landed().some((c) => c.some((v) => v.type === 'idle' || v.name === 'idle'))).toBe(false);
    await w.flush();
    const order = landed();
    const text = order.findIndex((c) => c.some((v) => v.delta === 'hello'));
    const idle = order.findIndex((c) => c.some((v) => v.type === 'idle'));
    expect(text).toBeGreaterThanOrEqual(0);
    expect(idle).toBeGreaterThan(text);
  });

  it('cursors and skip count lines, not chunks, when lines straddle chunks', async () => {
    const f = fakeWorld();
    // One write stored as three chunks, cut through a line.
    f.raw('{"n":1}\n{"n"');
    f.raw(':2}\n{"n":3}');
    f.raw('\n\n');
    f.raw('{"n":4}\n\n');
    const abort = new AbortController();
    const entries = await collect(tailJsonLinesAt(f.world, 'r', 'live', { signal: abort.signal }), 4);
    expect(entries).toEqual([1, 2, 3, 4].map((n, i) => ({ value: { n }, cursor: encodeCursor({ startIndex: 0, lines: i + 1 }) })));
    for (const [k, entry] of (entries as { cursor: string }[]).entries()) {
      if (k === 3) break;
      expect((await tailJsonLines(f.world, 'r', 'live', { cursor: entry.cursor, signal: abort.signal }).next()).value).toEqual({ n: k + 2 });
    }
    expect((await tailJsonLines(f.world, 'r', 'live', { skip: 2, signal: abort.signal }).next()).value).toEqual({ n: 3 });
    expect(decodeCursor('0.2')).toEqual({ startIndex: 0, lines: 2 });
    expect(decodeCursor('nope')).toBeUndefined();
    await expect(tailJsonLinesAt(f.world, 'r', 'live', { startIndex: -1 }).next()).rejects.toThrow(TypeError);
    abort.abort();
  });
});

describe('stream lines', () => {
  it('are devalue text, which the Workflow runtime decodes, holding what JSON held', () => {
    class Point {
      constructor(readonly x: number) {}
    }
    const values: unknown[] = [
      { type: 'text', delta: 'line one\nline two' },
      { at: new Date(0), gone: undefined, nested: [1, { p: new Point(2) }] },
      'working',
      42,
      null,
    ];
    for (const value of values) {
      const line = encodeLine(value);
      const asJson = JSON.parse(JSON.stringify(value));
      expect(line).not.toContain('\n');
      // What `workflow inspect stream` does with a line it cannot frame: devalue's parse.
      expect(parse(line)).toEqual(asJson);
      expect(decodeLine(line)).toEqual(asJson);
    }
  });

  it('keep a surrogate pair split across two lines, as JSON did', () => {
    const emoji = '\u{1F600}';
    const [hi, lo] = [emoji.slice(0, 1), emoji.slice(1)];
    // Through UTF-8, as a World stores the chunk.
    const roundTrip = (v: unknown) => decodeLine(dec.decode(enc.encode(encodeLine(v)))) as { delta: string };
    expect(roundTrip({ delta: hi }).delta + roundTrip({ delta: lo }).delta).toBe(emoji);
    expect(parse(dec.decode(enc.encode(encodeLine({ delta: hi })))).delta).toBe(hi);
  });

  it('fall back to JSON for what devalue refuses, and read the JSON lines written before', () => {
    const proto = JSON.parse('{"__proto__":{"x":1},"y":2}');
    expect(decodeLine(encodeLine(proto))).toEqual(proto);
    expect(decodeLine('{"type":"idle"}')).toEqual({ type: 'idle' });
    expect(decodeLine('"plain"')).toBe('plain');
    expect(decodeLine('7')).toBe(7);
  });

  it('come back from a writer and a reader in order', async () => {
    const f = fakeWorld();
    const w = new JsonLinesWriter(f.world, 'r', 'live');
    w.write({ n: 1, s: 'a\u{1F600}' });
    w.write({ n: 2 });
    await w.flush();
    expect(f.chunks.flatMap(valuesOf)).toEqual([{ n: 1, s: 'a\u{1F600}' }, { n: 2 }]);
    expect(await readJsonLines(f.world as never, 'r', 'live')).toEqual([{ n: 1, s: 'a\u{1F600}' }, { n: 2 }]);
  });
});
