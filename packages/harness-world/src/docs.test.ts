import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { encode } from './codec.ts';
import {
  applyDocOps,
  diffOps,
  DOC_OPS_SLACK_BYTES,
  callDocs,
  defineDoc,
  diffDoc,
  docNameOf,
  docsPrompt,
  docsReader,
  promptDocsText,
  DOC_MAX_BYTES,
  docBytes,
  DocTooLarge,
  DocVersionError,
  type DocEdit,
  type DocOp,
  type DocsPayload,
  encodeEdit,
  isDocsEnvelope,
  type JsonObject,
  type JsonValue,
  jsonEqual,
  materializeDoc,
  outcomeResult,
  readDoc,
  strictCopy,
} from './docs.ts';
import { emptyState, fold, type StepEnvelope } from './fold.ts';
import { stepNameFor } from './names.ts';
import { cloneState } from './pipelined-log.ts';

/** A seeded PRNG, so a failing case reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(r: () => number, depth: number): JsonValue {
  const pick = r();
  if (depth <= 0 || pick < 0.35) {
    const k = r();
    if (k < 0.2) return null;
    if (k < 0.4) return r() < 0.5;
    if (k < 0.7) return Math.round(r() * 100) - 20;
    return ['', 'a', 'b', 'é', '🙂', 'long text'][Math.floor(r() * 6)]!;
  }
  if (pick < 0.65) return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth - 1));
  return randomObject(r, depth - 1);
}

function randomObject(r: () => number, depth: number): JsonObject {
  const out: JsonObject = {};
  const keys = ['a', 'b', 'c', 'items', 'x y', 'n'];
  for (const k of keys) if (r() < 0.5) out[k] = randomValue(r, depth);
  return out;
}

/** A random change of `v`: keep, replace, delete keys, add keys, append to arrays, shrink arrays. */
function mutate(r: () => number, v: JsonValue, depth: number): JsonValue {
  const p = r();
  if (p < 0.25) return v;
  if (p < 0.35 || depth <= 0) return randomValue(r, 2);
  if (Array.isArray(v)) {
    if (r() < 0.5) return [...v, ...Array.from({ length: 1 + Math.floor(r() * 2) }, () => randomValue(r, 1))];
    if (r() < 0.5) return v.slice(0, Math.floor(r() * v.length));
    return v.map((x) => mutate(r, x, depth - 1));
  }
  if (v && typeof v === 'object') {
    const out: JsonObject = {};
    for (const [k, x] of Object.entries(v)) {
      if (r() < 0.15) continue;
      out[k] = mutate(r, x, depth - 1);
    }
    if (r() < 0.3) out[`k${Math.floor(r() * 5)}`] = randomValue(r, 2);
    return out;
  }
  return randomValue(r, 1);
}

const Todos = defineDoc<{ items: string[] }>({ kind: 'app.todos', version: 1, initial: () => ({ items: [] }) });

describe('diff and apply', () => {
  it('apply(a, diff(a, b)) deep-equals b, over random pairs (and takes the root set exactly when it is smaller)', () => {
    const r = rng(7);
    for (let i = 0; i < 3000; i++) {
      const a = randomObject(r, 3);
      let b = mutate(r, a, 3);
      if (!b || typeof b !== 'object' || Array.isArray(b)) b = randomObject(r, 2);
      const ops = diffDoc(a, b as JsonObject);
      const out = applyDocOps(a, ops);
      expect(jsonEqual(out, b), `case ${i}: ${JSON.stringify(a)} -> ${JSON.stringify(b)} via ${JSON.stringify(ops)}`).toBe(true);
      if (jsonEqual(a, b)) expect(ops).toEqual([]);
      // The root set is taken exactly when the fine ops are larger than it, and not small.
      const fine = diffOps(a, b as JsonObject);
      const takeRoot = fine.length > 0 && docBytes(fine) > DOC_OPS_SLACK_BYTES && docBytes(fine) > docBytes([{ op: 'set', path: [], value: b }]);
      expect(ops).toEqual(takeRoot ? [{ op: 'set', path: [], value: b }] : fine);
    }
    // Large rewrites (a whole new document of more than 1 KB of ops) do take the root set.
    const a = { list: Array.from({ length: 200 }, (_, i) => `item ${i}`) };
    const b = { list: Array.from({ length: 200 }, (_, i) => `other ${i}`), extra: { deep: { er: true } } };
    expect(diffDoc(a, b)).toEqual([{ op: 'set', path: [], value: b }]);
  });

  it('diffs an array grown at the end as one append, and a key change as one set', () => {
    expect(diffDoc({ items: ['a'], n: 1, keep: { deep: [1, 2] } }, { items: ['a', 'b', 'c'], n: 2, keep: { deep: [1, 2] } })).toEqual([
      { op: 'append', path: ['items'], values: ['b', 'c'] },
      { op: 'set', path: ['n'], value: 2 },
    ]);
    expect(diffDoc({ a: 1, gone: true }, { a: 1 })).toEqual([{ op: 'delete', path: ['gone'] }]);
    // Shrinking an array replaces it.
    expect(diffDoc({ items: ['a', 'b', 'c', 'd', 'e', 'f'], other: 'x'.repeat(50) }, { items: ['a'], other: 'x'.repeat(50) })).toEqual([{ op: 'set', path: ['items'], value: ['a'] }]);
  });

  it('rebases path by path: disjoint keys both survive, both appends survive, the later edit wins a key both touched, a whole array replaced is replaced', () => {
    const base = { todos: { a: 'x', b: 'y' }, log: ['start'], title: 'one' };
    const mine = diffDoc(base, { todos: { a: 'x', b: 'y', c: 'mine' }, log: ['start', 'mine'], title: 'mine' });
    const theirs = applyDocOps(base, diffDoc(base, { todos: { a: 'theirs', b: 'y' }, log: ['start', 'theirs'], title: 'theirs' }));
    expect(applyDocOps(theirs, mine)).toEqual({ todos: { a: 'theirs', b: 'y', c: 'mine' }, log: ['start', 'theirs', 'mine'], title: 'mine' });
    // An array replaced whole (shrunk) is replaced, whatever was appended meanwhile.
    expect(applyDocOps(theirs, diffDoc(base, { ...base, log: [] }))).toMatchObject({ log: [] });
  });

  it('is total: set through a missing or non-object intermediate, delete of a missing path, append to a non-array', () => {
    const ops: DocOp[] = [
      { op: 'set', path: ['a', 'b', 'c'], value: 1 },
      { op: 'set', path: ['n', 'deeper'], value: true },
      { op: 'delete', path: ['missing', 'x'] },
      { op: 'delete', path: ['n', 'nope'] },
      { op: 'append', path: ['s'], values: [1] },
      { op: 'append', path: ['fresh'], values: ['x'] },
    ];
    expect(applyDocOps({ n: 5, s: 'str' }, ops)).toEqual({ n: { deeper: true }, s: [1], a: { b: { c: 1 } }, fresh: ['x'] });
  });

  it('copies on write: a value read before an edit is unchanged after it, and every value in the fold is frozen', () => {
    const before = applyDocOps({}, [{ op: 'set', path: [], value: { a: { b: [1] }, c: { d: 1 } } }]);
    const snapshot = JSON.stringify(before);
    const after = applyDocOps(before, [
      { op: 'append', path: ['a', 'b'], values: [2] },
      { op: 'delete', path: ['c', 'd'] },
    ]);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(after).toEqual({ a: { b: [1, 2] }, c: {} });
    expect(Object.isFrozen(after) && Object.isFrozen((after.a as JsonObject).b)).toBe(true);
    // An untouched subtree is shared, not copied.
    const shared = applyDocOps(before, [{ op: 'set', path: ['e'], value: 1 }]);
    expect(shared.c).toBe(before.c);
  });
});

describe('strict JSON', () => {
  const bad: Array<[string, unknown, string]> = [
    ['undefined in an array', { items: [1, undefined] }, '$.items[1]: undefined'],
    ['undefined as a value', { a: { b: undefined } }, '$.a.b: undefined'],
    ['NaN', { n: Number.NaN }, '$.n: NaN'],
    ['Infinity', { n: Number.POSITIVE_INFINITY }, '$.n: Infinity'],
    ['a Date', { at: new Date() }, '$.at: a Date'],
    ['a class instance', { m: new Map() }, '$.m: an instance of Map'],
    ['a function', { f: () => 1 }, '$.f: function'],
    ['a bigint', { b: 1n }, '$.b: bigint'],
    ['a hole', { h: [1, , 3] }, '$.h[1]: a hole'],
    ['__proto__', JSON.parse('{"ok":{"__proto__":1}}'), '$.ok.__proto__: the key __proto__'],
    ['an array root', [], 'the root must be a plain object, not an array'],
  ];
  for (const [name, value, message] of bad) {
    it(`refuses ${name}, naming the path`, () => {
      expect(() => strictCopy(value, 'app.x')).toThrow(TypeError);
      expect(() => strictCopy(value, 'app.x')).toThrow(message);
    });
  }
  it('refuses a cycle, and copies a container referenced twice', () => {
    const cyclic: Record<string, unknown> = { a: {} };
    (cyclic.a as Record<string, unknown>).self = cyclic;
    expect(() => strictCopy(cyclic, 'app.x')).toThrow('$.a.self: a cycle');
    const shared = [1, 2];
    const copy = strictCopy({ x: shared, y: shared }, 'app.x');
    expect(copy).toEqual({ x: [1, 2], y: [1, 2] });
    expect(copy.x).not.toBe(copy.y);
    expect(strictCopy(Object.assign(Object.create(null), { a: 1 }), 'app.x')).toEqual({ a: 1 });
  });
});

describe('size, versions, defineDoc', () => {
  const Big = defineDoc<{ s: string }>({ kind: 'app.big', version: 1, initial: () => ({ s: '' }) });
  const filler = (bytes: number) => 'x'.repeat(bytes - docBytes({ s: '' }));

  it('allows exactly 65,536 bytes, refuses more and growth past the limit, allows a write that shrinks an oversized value', () => {
    const io = callDocs(() => emptyState('wrun_x')).io;
    expect(docBytes(io.update(Big, (d) => void (d.s = filler(DOC_MAX_BYTES))))).toBe(DOC_MAX_BYTES);
    expect(() => io.update(Big, (d) => void (d.s += 'y'))).toThrow(DocTooLarge);
    expect(() => io.update(Big, (d) => void (d.s += 'y'))).toThrow('document app.big would be 65,537 bytes; the limit is 65,536');
    // Multi-byte characters count as their UTF-8 bytes.
    expect(() => io.update(Big, (d) => void (d.s = 'é'.repeat(DOC_MAX_BYTES / 2)))).toThrow(DocTooLarge);
    // A document already over the limit (two writers grew it in one window) may shrink.
    const over = emptyState('wrun_x');
    over.docs.set('app.big', { kind: 'app.big', schema: 1, revision: 3, value: { s: filler(DOC_MAX_BYTES + 100) }, slot: 9, by: { edit: 'dedit_x' } });
    const shrink = callDocs(() => over).io;
    expect(() => shrink.update(Big, (d) => void (d.s += 'more'))).toThrow(DocTooLarge);
    expect(() => shrink.update(Big, (d) => void (d.s = d.s.slice(10)))).not.toThrow();
  });

  it('migrates an older stored version on read, refuses a newer one or an older one without migrate, and writes a root set at the new schema after migrating', () => {
    const V2 = defineDoc<{ items: { text: string }[] }>({
      kind: 'app.todos',
      version: 2,
      initial: () => ({ items: [] }),
      migrate: (old, from) => {
        expect(from).toBe(1);
        return { items: (old.items as string[]).map((text) => ({ text })) };
      },
    });
    const NoMigrate = defineDoc<{ items: { text: string }[] }>({ kind: 'app.todos', version: 2, initial: () => ({ items: [] }) });
    const stored = { schema: 1, revision: 4, value: { items: ['a'] } };
    const m = materializeDoc(V2.definition, stored);
    expect(m).toMatchObject({ value: { items: [{ text: 'a' }] }, revision: 4, migrated: true, present: true });
    expect(() => materializeDoc(NoMigrate.definition, stored)).toThrow(DocVersionError);
    expect(() => materializeDoc(Todos.definition, { schema: 2, revision: 1, value: { items: [] } })).toThrow('newer than this code');
    const edit = encodeEdit(V2.definition, m, { items: [{ text: 'a' }, { text: 'b' }] })!;
    expect(edit).toEqual({ kind: 'app.todos', base: 4, schema: 2, ops: [{ op: 'set', path: [], value: { items: [{ text: 'a' }, { text: 'b' }] } }] });
  });

  it('a first write carries init when it is stored as ops; no change writes nothing', () => {
    const base = materializeDoc(Todos.definition, undefined);
    expect(encodeEdit(Todos.definition, base, { items: [] })).toBeUndefined();
    expect(encodeEdit(Todos.definition, base, { items: ['a'] })).toEqual({ kind: 'app.todos', base: 0, schema: 1, init: { items: [] }, ops: [{ op: 'append', path: ['items'], values: ['a'] }] });
  });

  it('defineDoc validates kind and version, and copies a value initial per use', () => {
    expect(() => defineDoc({ kind: 'has space', version: 1, initial: {} })).toThrow(TypeError);
    expect(() => defineDoc({ kind: '.dot', version: 1, initial: {} })).toThrow(TypeError);
    expect(() => defineDoc({ kind: 'ok', version: 0, initial: {} })).toThrow(TypeError);
    expect(() => defineDoc({ kind: 'ok', version: 1.5, initial: {} })).toThrow(TypeError);
    expect(() => defineDoc({ kind: 'ok', version: 1, initial: { d: new Date() } as never })).toThrow('$.d: a Date');
    const D = defineDoc<{ list: number[] }>({ kind: 'app.list', version: 1, initial: { list: [] } });
    const a = D.definition.initial();
    a.list.push(1);
    expect(D.definition.initial()).toEqual({ list: [] });
    expect(D.definition.scope).toBe('session');
  });

  it('io.docs: reads are pinned, updates run once on a copy, validate refuses, the edit is one diff per document', () => {
    const state = emptyState('wrun_x');
    state.docs.set('app.todos', { kind: 'app.todos', schema: 1, revision: 2, value: Object.freeze({ items: Object.freeze(['a']) }) as never, slot: 5, by: { edit: 'e' } });
    const V = defineDoc<{ items: string[] }>({
      kind: 'app.todos',
      version: 1,
      initial: () => ({ items: [] }),
      validate: (v) => {
        if (v.items.includes('bad')) throw new Error('no bad todos');
      },
    });
    const call = callDocs(() => state);
    const first = call.io.read(V);
    expect(first).toEqual({ value: { items: ['a'] }, revision: 2 });
    let runs = 0;
    const out = call.io.update(V, (d) => {
      runs++;
      d.items.push('b');
    });
    expect(runs).toBe(1);
    expect(out).toEqual({ items: ['a', 'b'] });
    expect(() => (out.items as string[]).push('c')).toThrow();
    // The fold's value was never touched.
    expect(state.docs.get('app.todos')!.value).toEqual({ items: ['a'] });
    // A later fold change does not move the pin.
    state.docs.set('app.todos', { ...state.docs.get('app.todos')!, revision: 3, value: { items: ['zzz'] } });
    expect(call.io.read(V).revision).toBe(2);
    expect(() => call.io.update(V, (d) => void d.items.push('bad'))).toThrow('no bad todos');
    call.io.update(V, (d) => ({ items: [...d.items, 'c'] }));
    expect(call.edits()).toEqual([{ kind: 'app.todos', base: 2, schema: 1, ops: [{ op: 'append', path: ['items'], values: ['b', 'c'] }] }]);
    expect(readDoc(state, V)).toEqual({ value: { items: ['zzz'] }, revision: 3 });
  });

  it('wraps an output that looks like an envelope, so the fold never mistakes it for one', () => {
    const lookalike = { $docs: 1, value: 'x', docs: [] };
    expect(isDocsEnvelope(outcomeResult(lookalike, []))).toBe(true);
    expect((outcomeResult(lookalike, []) as { value: unknown }).value).toBe(lookalike);
    expect(outcomeResult('plain', [])).toBe('plain');
  });
});

// ---------------------------------------------------------------------------
// The fold

function log() {
  const events: Event[] = [];
  const push = (e: Record<string, unknown>) => {
    events.push({ runId: 'wrun_x', eventId: `evnt_${String(events.length + 1).padStart(4, '0')}`, createdAt: new Date(Date.UTC(2026, 9, 12, 0, 0, events.length)), ...e } as unknown as Event);
    return b;
  };
  const b = {
    events,
    hook(hookId: string, token: string) {
      return push({ eventType: 'hook_created', correlationId: hookId, eventData: { token } });
    },
    conflict(hookId: string, token: string) {
      return push({ eventType: 'hook_conflict', correlationId: hookId, eventData: { token, conflictingRunId: 'wrun_x' } });
    },
    run(stepId: string, key: string) {
      const env: StepEnvelope = { key, replay: 'safe', input: null, epoch: 0 };
      push({ eventType: 'step_created', correlationId: stepId, eventData: { stepName: stepNameFor('tool.x'), input: encode(env) } });
      return push({ eventType: 'step_started', correlationId: stepId, eventData: {} });
    },
    completed(stepId: string, result: unknown) {
      return push({ eventType: 'step_completed', correlationId: stepId, eventData: { result: encode(result) } });
    },
    failed(stepId: string) {
      return push({ eventType: 'step_failed', correlationId: stepId, eventData: { error: encode({ message: 'boom' }) } });
    },
    edit(hookId: string, payload: DocsPayload) {
      return push({ eventType: 'hook_received', correlationId: hookId, eventData: { token: 'harness:wrun_x:docs', payload: encode(payload) } });
    },
  };
  return b;
}

const append = (base: number, item: string, init?: JsonObject): DocEdit => ({ kind: 'app.todos', base, schema: 1, ...(init ? { init } : {}), ops: [{ op: 'append', path: ['items'], values: [item] }] });
const envelope = (value: unknown, docs: unknown[]) => ({ $docs: 1, value, docs });

describe('fold: documents', () => {
  it('unwraps the envelope into output, applies edits at the outcome, and an inert or failed outcome applies none', () => {
    const l = log()
      .hook('hook_in', 'harness:wrun_x:inbox')
      .run('s1', 'k1')
      .completed('s1', envelope('added', [append(0, 'a', { items: [] })]))
      // A late second outcome of the same step: inert, its edit too.
      .completed('s1', envelope('again', [append(1, 'dup')]))
      .run('s2', 'k2')
      .failed('s2')
      .run('s3', 'k3')
      .completed('s3', 'no docs');
    const seen: boolean[] = [];
    const state = fold(emptyState('wrun_x'), l.events, (_e, ok) => seen.push(ok));
    expect(state.effects.get('k1')).toMatchObject({ status: 'completed', output: 'added', docs: [{ kind: 'app.todos', revision: 1 }] });
    expect(state.effects.get('k3')).toMatchObject({ output: 'no docs' });
    expect(state.effects.get('k3')!.docs).toBeUndefined();
    expect(state.docs.get('app.todos')).toMatchObject({ revision: 1, schema: 1, value: { items: ['a'] }, slot: 4, by: { step: 's1', key: 'k1' } });
    expect(seen[4]).toBe(false);
    expect(readDoc(state, Todos)).toEqual({ value: { items: ['a'] }, revision: 1 });
  });

  it('out-of-band edits: exact base or conflict (recorded), a duplicate id inert, all or nothing, the first :docs hook wins, a hook_conflict is inert', () => {
    const l = log()
      .hook('hook_docs', 'harness:wrun_x:docs')
      .conflict('hook_docs2', 'harness:wrun_x:docs')
      .hook('hook_docs3', 'harness:wrun_x:docs')
      .edit('hook_docs', { $docs: 1, id: 'e1', docs: [{ kind: 'app.todos', base: 0, schema: 1, ops: [{ op: 'set', path: [], value: { items: ['x'] } }] }] })
      .edit('hook_docs', { $docs: 1, id: 'e1', docs: [{ kind: 'app.todos', base: 1, schema: 1, ops: [{ op: 'set', path: [], value: { items: ['resent'] } }] }] })
      .edit('hook_docs', { $docs: 1, id: 'e2', docs: [append(0, 'stale')] })
      // Two documents at once: one on a stale base, so neither applies.
      .edit('hook_docs', { $docs: 1, id: 'e3', docs: [append(1, 'y'), { kind: 'app.other', base: 3, schema: 1, ops: [{ op: 'set', path: ['a'], value: 1 }] }] })
      .edit('hook_docs', { $docs: 1, id: 'e4', docs: [append(1, 'y'), { kind: 'app.other', base: 0, schema: 1, ops: [{ op: 'set', path: [], value: { a: 1 } }] }] })
      // On another hook with the docs token (lost the race): not an edit.
      .edit('hook_docs3', { $docs: 1, id: 'e5', docs: [append(2, 'ignored')] });
    const seen: boolean[] = [];
    const state = fold(emptyState('wrun_x'), l.events, (_e, ok) => seen.push(ok));
    expect(state.docsHook).toEqual({ hookId: 'hook_docs', token: 'harness:wrun_x:docs' });
    expect(seen.slice(0, 2)).toEqual([true, false]);
    expect([...state.docEdits]).toEqual([
      ['e1', { applied: true, slot: 4 }],
      ['e2', { applied: false, slot: 6 }],
      ['e3', { applied: false, slot: 7 }],
      ['e4', { applied: true, slot: 8 }],
    ]);
    expect(state.docs.get('app.todos')).toMatchObject({ revision: 2, value: { items: ['x', 'y'] }, by: { edit: 'e4' } });
    expect(state.docs.get('app.other')).toMatchObject({ revision: 1, value: { a: 1 } });
  });

  it('in-band edits always apply where the outcome lands: rebased on a later revision, from init on an absent document; older-schema and malformed ones are dropped', () => {
    const l = log()
      .hook('hook_docs', 'harness:wrun_x:docs')
      .run('s1', 'k1')
      // The tool read revision 0; an app's edit lands before its outcome.
      .edit('hook_docs', { $docs: 1, id: 'e1', docs: [{ kind: 'app.todos', base: 0, schema: 1, ops: [{ op: 'set', path: [], value: { items: ['app'] } }] }] })
      .completed('s1', envelope('ok', [append(0, 'tool', { items: [] }), { kind: 'bad kind!', base: 0, schema: 1, ops: [] }, { kind: 'app.fresh', base: 0, schema: 1, init: { n: 0, list: [] }, ops: [{ op: 'append', path: ['list'], values: [1] }] }]))
      // A migration's write (schema 2), then an outcome from code older than it: dropped, the outcome stands.
      .edit('hook_docs', { $docs: 1, id: 'e2', docs: [{ kind: 'app.todos', base: 2, schema: 2, ops: [{ op: 'set', path: [], value: { items: [{ text: 'app' }, { text: 'tool' }] } }] }] })
      .run('s2', 'k2')
      .completed('s2', envelope('old code', [append(3, 'v1 item')]));
    const state = fold(emptyState('wrun_x'), l.events);
    expect(state.effects.get('k1')!.docs).toEqual([
      { kind: 'app.todos', revision: 2, rebased: true },
      { kind: 'bad kind!', revision: 0, dropped: 'malformed' },
      { kind: 'app.fresh', revision: 1 },
    ]);
    expect(state.effects.get('k2')).toMatchObject({ status: 'completed', output: 'old code', docs: [{ kind: 'app.todos', revision: 3, dropped: 'older-schema' }] });
    expect(state.docs.get('app.todos')).toMatchObject({ revision: 3, schema: 2, value: { items: [{ text: 'app' }, { text: 'tool' }] } });
    expect(state.docs.get('app.fresh')).toMatchObject({ revision: 1, value: { n: 0, list: [1] } });
  });

  it('folding in halves equals folding at once, a cloned fold is independent, and an old log folds to no documents', () => {
    const l = log()
      .hook('hook_docs', 'harness:wrun_x:docs')
      .run('s1', 'k1')
      .completed('s1', envelope('ok', [append(0, 'a', { items: [] })]))
      .edit('hook_docs', { $docs: 1, id: 'e1', docs: [append(1, 'b')] })
      .run('s2', 'k2')
      .completed('s2', envelope('ok', [append(2, 'c')]));
    const whole = fold(emptyState('wrun_x'), l.events);
    for (let cut = 0; cut <= l.events.length; cut++) {
      const halves = fold(fold(emptyState('wrun_x'), l.events.slice(0, cut)), l.events.slice(cut));
      expect([...halves.docs]).toEqual([...whole.docs]);
      expect([...halves.docEdits]).toEqual([...whole.docEdits]);
    }
    const first = fold(emptyState('wrun_x'), l.events.slice(0, 4));
    const copy = cloneState(first);
    fold(copy, l.events.slice(3));
    expect(first.docs.get('app.todos')!.revision).toBe(1);
    expect(copy.docs.get('app.todos')!.revision).toBe(3);
    const old = fold(emptyState('wrun_x'), log().hook('hook_in', 'harness:wrun_x:inbox').run('s1', 'k1').completed('s1', 'plain').events);
    expect(old.docs.size).toBe(0);
    expect(old.docsHook).toBeUndefined();
  });
});

describe('docsPrompt (the prompt hook)', () => {
  const Todos = defineDoc<{ items: string[] }>({ kind: 'app.todos', version: 1, initial: () => ({ items: [] }) });
  const Plan = defineDoc<{ steps: string[] }>({ kind: 'app.plan', version: 2, initial: () => ({ steps: [] }) });
  const stored = new Map([['app.todos', { kind: 'app.todos', schema: 1, revision: 3, value: { items: ['buy milk'] }, slot: 1, by: { edit: 'x' } }]]);
  const reader = docsReader(() => ({ docs: stored as never }));

  it('shows each document as JSON with its name, kind and revision', () => {
    expect(docsPrompt([Todos])(reader)).toBe(
      'The session\'s documents, as of this model call (JSON; revision 0: never written):\n\n<document name="todos" kind="app.todos" revision="3">\n{"items":["buy milk"]}\n</document>'
    );
    expect(docsPrompt({ list: Todos })(reader)).toContain('<document name="list" kind="app.todos" revision="3">');
  });

  it("shows a document this code cannot read as its error, and one never written as its initial value", () => {
    const text = docsPrompt([Plan, defineDoc({ kind: 'app.notes', version: 1, initial: () => ({ text: '' }) })])(
      docsReader(() => ({ docs: new Map([['app.plan', { kind: 'app.plan', schema: 1, revision: 1, value: { steps: [] }, slot: 1, by: { edit: 'x' } }]]) as never }))
    );
    expect(text).toContain('<document name="plan" kind="app.plan" error="harness-world: document app.plan is stored at schema version 1, older than this code\'s 2, and its definition has no migrate"></document>');
    expect(text).toContain('<document name="notes" kind="app.notes" revision="0">\n{"text":""}\n</document>');
  });

  it('is off unless given, and takes a function of the documents', () => {
    expect(promptDocsText(undefined, reader)).toBeUndefined();
    expect(promptDocsText([Todos], undefined)).toBeUndefined();
    expect(promptDocsText((docs) => `todos: ${docs.read(Todos).value.items.join(', ')}`, reader)).toBe('todos: buy milk');
    expect(promptDocsText(() => '', reader)).toBeUndefined();
    expect(docNameOf('crm.notes-v2')).toBe('notes-v2');
    expect(docNameOf('a:b')).toBe('a_b');
  });
});
