/**
 * Documents: typed JSON state per session, kept in the session's log.
 *
 * A document is a small JSON object (at most `DOC_MAX_BYTES` of
 * `JSON.stringify`) that every kernel harness and app code can read and
 * write. It is not shown to the model unless an app gives it tools that read
 * it (code reads them, as in pi-durable).
 *
 * Two ways to change one:
 *
 * - **In-band, inside an effect** (`io.docs.update`): the change rides on
 *   the effect's own outcome (`step_completed`, an envelope `{ $docs: 1,
 *   value, docs }`), so it is atomic with it. A call that throws, or never
 *   reports (a crash), changed nothing. Such an edit always applies where its
 *   outcome lands (rebased path by path when something landed in between):
 *   the World makes a step's first outcome final, so an outcome can never be
 *   refused because of a document.
 * - **Out-of-band, from app code** (`sessions.updateDoc`): a `hook_received`
 *   on the session's docs hook (`harness:<runId>:docs`, created on the first
 *   such edit). It applies only on the revision it was computed from
 *   (optimistic concurrency); `updateDoc` re-reads and retries, or throws
 *   `DocConflict` with `expectRevision`.
 *
 * The fold is the only interpreter: it reads no definitions and no clock, so
 * the same log always folds to the same documents. Definitions (schema
 * version, `migrate`, `validate`) and the size limit are writers' and
 * readers' business.
 *
 * Browser-safe: no Node APIs (world-browser bundles the kernel).
 */
import type { SessionState } from './types.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** `T`, read-only all the way down: what a reader gets (values in the fold are never mutated). */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** 64 KB: the most `JSON.stringify(value)` of a document may take, in UTF-8 bytes. Raising it later is safe; writers enforce it, the fold never does. */
export const DOC_MAX_BYTES = 65_536;

const KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface DocDefinition<T extends object = JsonObject> {
  /** The document's name in the log. `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`. `hw.` is reserved for harness-world's own documents. */
  readonly kind: string;
  /** Schema version, a positive integer. Bump it when `T`'s shape changes, and give `migrate`. */
  readonly version: number;
  /** The value of a document that was never written. A fresh copy each call. */
  initial(): T;
  /** A stored value of an older schema version, as `T`. Runs on read, never in the fold. Must be pure. */
  migrate?(value: JsonObject, fromVersion: number): T;
  /** Check a value before it is written (in a tool's `update`, in `updateDoc`). Throw to refuse. Never runs in the fold. */
  validate?(value: DeepReadonly<T>): void;
  /** JSON Schema of `T` (TypeBox works as-is), for tools that show a document to a model. */
  readonly schema?: object;
  /**
   * What the live `doc` event of each applied edit carries: `'value'` (the
   * default) the whole value; `'revision'` the revision without the value,
   * for a document that changes often or is large, whose clients read the
   * value when they want it (`sessions.doc`). Publishing only: the log is
   * the same either way.
   */
  readonly live?: DocLive;
  /** Every harness-world document is session-scoped (the shape pi-durable's tokens have). */
  readonly scope: 'session';
}

/** What a document's live `doc` events carry (`DocDefinition.live`). */
export type DocLive = 'value' | 'revision';

/** A document token: pass it to every read and write. Same shape as pi-durable's (`{ definition }`). */
export interface Doc<T extends object = JsonObject> {
  readonly definition: DocDefinition<T>;
}

/** A document as some reader sees it. */
export interface DocSnapshot<T extends object = JsonObject> {
  readonly value: DeepReadonly<T>;
  /** Edits applied so far. 0: never written, and `value` is `initial()`. */
  readonly revision: number;
}

/**
 * Define a document.
 *
 * ```ts
 * const Todos = defineDoc<{ items: string[] }>({ kind: 'app.todos', version: 1, initial: () => ({ items: [] }) })
 * ```
 */
export function defineDoc<T extends object>(definition: {
  kind: string;
  version: number;
  /** A function (preferred, as in pi-durable) or a plain value (copied on each use). */
  initial: T | (() => T);
  migrate?: (value: JsonObject, fromVersion: number) => T;
  validate?: (value: DeepReadonly<T>) => void;
  schema?: object;
  live?: DocLive;
  scope?: 'session';
}): Doc<T> {
  const { kind, version, initial } = definition ?? ({} as typeof definition);
  if (typeof kind !== 'string' || !KIND.test(kind)) {
    throw new TypeError(`harness-world: a document kind must match ${KIND} (got ${JSON.stringify(kind)})`);
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError(`harness-world: document ${kind}'s version must be a positive integer (got ${String(version)})`);
  }
  if (definition.scope !== undefined && definition.scope !== 'session') {
    throw new TypeError(`harness-world: document ${kind}'s scope must be 'session'`);
  }
  if (definition.live !== undefined && definition.live !== 'value' && definition.live !== 'revision') {
    throw new TypeError(`harness-world: document ${kind}'s live must be 'value' or 'revision'`);
  }
  let make: () => T;
  if (typeof initial === 'function') make = initial as () => T;
  else {
    // Checked once, now: a bad initial value fails where it is defined.
    const value = strictCopy(initial, kind) as T;
    make = () => copyJson(value) as T;
  }
  const def: DocDefinition<T> = {
    kind,
    version,
    initial: make,
    ...(definition.migrate ? { migrate: definition.migrate } : {}),
    ...(definition.validate ? { validate: definition.validate } : {}),
    ...(definition.schema ? { schema: definition.schema } : {}),
    ...(definition.live === 'revision' ? { live: 'revision' as const } : {}),
    scope: 'session',
  };
  return Object.freeze({ definition: Object.freeze(def) });
}

// ---------------------------------------------------------------------------
// Errors

/** An out-of-band edit lost a race for its revision (or `expectRevision` did not match). */
export class DocConflict extends Error {
  constructor(
    readonly kind: string,
    /** The document's revision when the conflict was seen. */
    readonly revision: number,
    /** The revision the writer expected (`expectRevision`), if it named one. */
    readonly expected?: number
  ) {
    super(
      expected !== undefined
        ? `harness-world: document ${kind} is at revision ${revision}, not ${expected}`
        : `harness-world: document ${kind} kept changing (now at revision ${revision}); the edit was not applied`
    );
    this.name = 'DocConflict';
  }
}

/** A write would leave a document over `DOC_MAX_BYTES` and larger than it was. */
export class DocTooLarge extends Error {
  constructor(
    readonly kind: string,
    readonly bytes: number,
    readonly limit: number = DOC_MAX_BYTES
  ) {
    super(`harness-world: document ${kind} would be ${bytes.toLocaleString('en-US')} bytes; the limit is ${limit.toLocaleString('en-US')}`);
    this.name = 'DocTooLarge';
  }
}

/** A stored document's schema version is newer than the code's, or older with no `migrate`. */
export class DocVersionError extends Error {
  constructor(
    readonly kind: string,
    /** The stored schema version. */
    readonly stored: number,
    /** The definition's version. */
    readonly code: number
  ) {
    super(
      stored > code
        ? `harness-world: document ${kind} is stored at schema version ${stored}, newer than this code's ${code} (no silent downgrade)`
        : `harness-world: document ${kind} is stored at schema version ${stored}, older than this code's ${code}, and its definition has no migrate`
    );
    this.name = 'DocVersionError';
  }
}

// ---------------------------------------------------------------------------
// The edit format (what the log stores)

/** Object keys only: arrays are never indexed (index arithmetic is what breaks under a rebase). */
export type DocPath = string[];

export type DocOp =
  /** Path `[]` replaces the whole value (which must be an object). */
  | { op: 'set'; path: DocPath; value: JsonValue }
  | { op: 'delete'; path: DocPath }
  | { op: 'append'; path: DocPath; values: JsonValue[] };

export interface DocEdit {
  kind: string;
  /** The revision the edit was computed from. */
  base: number;
  /** The schema version of the value after the edit. */
  schema: number;
  /** Only on a first write (base 0) stored as ops: the value they start from (`initial()`). */
  init?: JsonObject;
  ops: DocOp[];
}

/** A document in the fold. */
export interface DocState {
  kind: string;
  /** Stored schema version. */
  schema: number;
  revision: number;
  /** Deep-frozen: the fold copies on write and never mutates a value. */
  value: JsonObject;
  /** Slot of the event that made this revision. */
  slot: number;
  by: { step: string; key: string } | { edit: string };
}

/** What an effect's outcome did to documents (`EffectRecord.docs`). Values are in `SessionState.docs`. */
export interface DocEffect {
  kind: string;
  /** The document's revision after this outcome (or when it was dropped). */
  revision: number;
  /** Applied on a later revision than it was computed from (merged path by path). */
  rebased?: true;
  /** Not applied: an older schema than the stored one (code older than a migration), or a malformed edit (a writer bug). */
  dropped?: 'older-schema' | 'malformed';
}

/** What an effect that changed documents commits as its result. */
export interface DocsEnvelope {
  $docs: 1;
  value: unknown;
  docs: DocEdit[];
}

/** What an out-of-band edit writes as its `hook_received` payload. */
export interface DocsPayload {
  $docs: 1;
  /** `dedit_<ulid>`: a resend with the same id is inert. */
  id: string;
  docs: DocEdit[];
}

/** The docs hook's token. */
export const docsHookToken = (runId: string) => `harness:${runId}:docs`;

/** Whether `value` is an effect outcome carrying document edits. Exactly the keys `$docs` (1), `value`, `docs` (an array). */
export function isDocsEnvelope(value: unknown): value is DocsEnvelope {
  if (!isPlainObject(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.$docs !== 1 || !Array.isArray(v.docs)) return false;
  for (const key of Object.keys(v)) if (key !== '$docs' && key !== 'value' && key !== 'docs') return false;
  return true;
}

/** Whether `value` is an out-of-band edit's payload. */
export function isDocsPayload(value: unknown): value is DocsPayload {
  if (!isPlainObject(value)) return false;
  const v = value as Record<string, unknown>;
  return v.$docs === 1 && typeof v.id === 'string' && v.id.length > 0 && Array.isArray(v.docs);
}

/**
 * What an effect commits as its result: its output, wrapped in the envelope
 * when it changed documents. An output that itself looks like an envelope is
 * wrapped too (with no edits), so the fold never mistakes it for one.
 */
export function outcomeResult(output: unknown, edits: DocEdit[]): unknown {
  if (edits.length > 0 || isDocsEnvelope(output)) return { $docs: 1, value: output, docs: edits } satisfies DocsEnvelope;
  return output;
}

// ---------------------------------------------------------------------------
// Strict JSON

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function pathText(path: (string | number)[]): string {
  let out = '$';
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : /^[A-Za-z_$][\w$]*$/.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`;
  return out;
}

/**
 * A deep copy of `value`, which must be strict JSON with an object at the
 * root: plain objects (or null-prototype), dense arrays, strings, finite
 * numbers, booleans, `null`. Throws a `TypeError` naming the path otherwise
 * (`undefined` anywhere, `NaN`, infinities, bigint, functions, symbols, class
 * instances, `Date`, cycles, the key `__proto__`). A container referenced
 * twice is copied twice (as `JSON.stringify` would write it).
 */
export function strictCopy(value: unknown, kind: string): JsonObject {
  const ancestors = new Set<object>();
  const path: (string | number)[] = [];
  const fail = (what: string): never => {
    throw new TypeError(`harness-world: document ${kind} is not strict JSON at ${pathText(path)}: ${what}`);
  };
  const visit = (v: unknown): JsonValue => {
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return v;
      case 'number':
        return Number.isFinite(v) ? v : fail(String(v));
      case 'undefined':
        return fail('undefined');
      case 'object':
        break;
      default:
        return fail(typeof v);
    }
    if (v === null) return null;
    if (ancestors.has(v)) return fail('a cycle');
    if (Array.isArray(v)) {
      ancestors.add(v);
      const out: JsonValue[] = new Array(v.length);
      for (let i = 0; i < v.length; i++) {
        path.push(i);
        if (!(i in v)) fail('a hole in an array');
        out[i] = visit(v[i]);
        path.pop();
      }
      ancestors.delete(v);
      return out;
    }
    if (!isPlainObject(v)) return fail(v instanceof Date ? 'a Date' : `an instance of ${(v as object).constructor?.name ?? 'a class'}`);
    ancestors.add(v);
    const out: JsonObject = {};
    for (const key of Object.keys(v)) {
      path.push(key);
      if (key === '__proto__') fail('the key __proto__');
      out[key] = visit((v as Record<string, unknown>)[key]);
      path.pop();
    }
    ancestors.delete(v);
    return out;
  };
  if (!isPlainObject(value)) {
    if (value === undefined || value === null || typeof value !== 'object') return fail(`the root must be a plain object, not ${value === null ? 'null' : typeof value}`);
    return fail(Array.isArray(value) ? 'the root must be a plain object, not an array' : 'the root must be a plain object');
  }
  return visit(value) as JsonObject;
}

/** A deep copy of a JSON value already known to be strict (no checks). Mutable, even of a frozen value. */
export function copyJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyJson) as T;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = copyJson((value as Record<string, unknown>)[key]);
  return out as T;
}

/** Freeze `value` and everything under it. Stops at a frozen node: only ever frozen whole, so its subtree is too. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) for (const v of value) deepFreeze(v);
  else for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
}

/** Deep equality of JSON values, key order ignored. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], bb[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bo = b as Record<string, unknown>;
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) if (!hasOwn(bo, k) || !jsonEqual((a as Record<string, unknown>)[k], bo[k])) return false;
  return true;
}

/** UTF-8 bytes of a string, without encoding it. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** What the size limit measures: UTF-8 bytes of `JSON.stringify(value)`. */
export function docBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value) ?? '');
}

// ---------------------------------------------------------------------------
// Diff and apply

/**
 * Ops up to this size are kept even when a root `set` would be a few bytes
 * smaller: on a small document a root `set` saves nothing that matters, and
 * it would replace, under a rebase, what another writer changed meanwhile.
 */
export const DOC_OPS_SLACK_BYTES = 1024;

/**
 * The ops that turn `a` into `b`: equal (deep, key order ignored) gives none;
 * two plain objects recurse key by key (`set` for a new or changed key,
 * `delete` for a gone one); an array `b` that is `a` plus items at the end
 * gives one `append`; anything else is a `set` of `b`. If those ops encode
 * larger than a root `set` of `b` (and larger than `DOC_OPS_SLACK_BYTES`),
 * the root `set` is returned instead.
 */
export function diffDoc(a: JsonObject, b: JsonObject): DocOp[] {
  const ops = diffOps(a, b);
  if (ops.length === 0) return ops;
  const bytes = docBytes(ops);
  if (bytes <= DOC_OPS_SLACK_BYTES) return ops;
  const root: DocOp[] = [{ op: 'set', path: [], value: b }];
  return bytes > docBytes(root) ? root : ops;
}

/** The fine-grained ops from `a` to `b` (`diffDoc` without the root-`set` fallback). */
export function diffOps(a: JsonObject, b: JsonObject): DocOp[] {
  const ops: DocOp[] = [];
  diffInto(a, b, [], ops);
  return ops;
}

function diffInto(a: JsonValue, b: JsonValue, path: DocPath, out: DocOp[]): void {
  if (jsonEqual(a, b)) return;
  if (isPlainObject(a) && isPlainObject(b)) {
    const ao = a as JsonObject;
    const bo = b as JsonObject;
    for (const key of Object.keys(bo)) {
      if (!hasOwn(ao, key)) out.push({ op: 'set', path: [...path, key], value: bo[key]! });
      else diffInto(ao[key]!, bo[key]!, [...path, key], out);
    }
    for (const key of Object.keys(ao)) if (!hasOwn(bo, key)) out.push({ op: 'delete', path: [...path, key] });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && b.length > a.length && a.every((x, i) => jsonEqual(x, b[i]))) {
    out.push({ op: 'append', path, values: b.slice(a.length) });
    return;
  }
  out.push({ op: 'set', path, value: b });
}

/**
 * Apply `ops` to `value`, copy-on-write along each path (`value` is never
 * mutated), and deep-freeze what is new. Total for well-formed ops (see
 * `validEdit`): `set` creates a missing or non-object intermediate as `{}`;
 * `delete` of a missing path does nothing; `append` makes its target an
 * array if it is not one. On its own base, `applyDocOps(a, diffDoc(a, b))`
 * deep-equals `b`; on a later revision the same rules merge path by path
 * (edits to different keys both survive, appends both survive, the later
 * edit wins a key both touched, an array replaced whole is replaced).
 */
export function applyDocOps(value: JsonObject, ops: readonly DocOp[]): JsonObject {
  let out: JsonValue = value;
  for (const op of ops) {
    if (op.path.length === 0) {
      // Validated: only a `set` of an object at the root.
      if (op.op === 'set' && isPlainObject(op.value)) out = op.value;
      continue;
    }
    if (op.op === 'delete') out = deleteIn(out, op.path, 0);
    else if (op.op === 'set') out = setIn(out, op.path, 0, () => op.value);
    else out = setIn(out, op.path, 0, (old) => (Array.isArray(old) ? [...old, ...op.values] : [...op.values]));
  }
  return deepFreeze(out as JsonObject);
}

function setIn(node: JsonValue | undefined, path: DocPath, i: number, leaf: (old: JsonValue | undefined) => JsonValue): JsonValue {
  if (i === path.length) return leaf(node);
  const obj = isPlainObject(node) ? (node as JsonObject) : {};
  const key = path[i]!;
  const copy: JsonObject = { ...obj };
  copy[key] = setIn(hasOwn(obj, key) ? obj[key] : undefined, path, i + 1, leaf);
  return copy;
}

function deleteIn(node: JsonValue, path: DocPath, i: number): JsonValue {
  if (!isPlainObject(node)) return node;
  const obj = node as JsonObject;
  const key = path[i]!;
  if (!hasOwn(obj, key)) return node;
  const copy: JsonObject = { ...obj };
  if (i === path.length - 1) delete copy[key];
  else {
    const child = deleteIn(obj[key]!, path, i + 1);
    if (child === obj[key]) return node;
    copy[key] = child;
  }
  return copy;
}

function validPath(path: unknown): path is DocPath {
  return Array.isArray(path) && path.every((p) => typeof p === 'string' && p !== '__proto__');
}

function validOp(op: unknown): op is DocOp {
  if (!isPlainObject(op)) return false;
  const o = op as Record<string, unknown>;
  if (!validPath(o.path)) return false;
  const root = (o.path as DocPath).length === 0;
  switch (o.op) {
    case 'set':
      return hasOwn(o, 'value') && o.value !== undefined && (!root || isPlainObject(o.value));
    case 'delete':
      return !root;
    case 'append':
      return !root && Array.isArray(o.values);
    default:
      return false;
  }
}

/** Whether an edit is well formed (the fold drops one that is not: a writer bug). */
export function validEdit(edit: unknown): edit is DocEdit {
  if (!isPlainObject(edit)) return false;
  const e = edit as Record<string, unknown>;
  return (
    typeof e.kind === 'string' &&
    KIND.test(e.kind) &&
    Number.isSafeInteger(e.base) &&
    (e.base as number) >= 0 &&
    Number.isSafeInteger(e.schema) &&
    (e.schema as number) >= 1 &&
    (e.init === undefined || isPlainObject(e.init)) &&
    Array.isArray(e.ops) &&
    e.ops.every(validOp)
  );
}

// ---------------------------------------------------------------------------
// The fold's rules (pure functions of log order)

/**
 * Apply an outcome's edits at `slot` (its `step_completed` applied: the
 * record was running). Each applies on its base exactly, on a later revision
 * by the rebase rules (`rebased`), on an absent document from `init` (or `{}`
 * for a root `set`). An edit whose schema is below the stored one is dropped
 * (`older-schema`), a malformed one too (`malformed`); the outcome stands
 * either way.
 */
export function foldInBandEdits(state: SessionState, edits: readonly unknown[], slot: number, by: { step: string; key: string }): DocEffect[] {
  const out: DocEffect[] = [];
  for (const raw of edits) {
    const kind = isPlainObject(raw) && typeof raw.kind === 'string' ? raw.kind : '';
    const cur = kind ? state.docs.get(kind) : undefined;
    if (!validEdit(raw)) {
      out.push({ kind, revision: cur?.revision ?? 0, dropped: 'malformed' });
      continue;
    }
    if (cur && raw.schema < cur.schema) {
      out.push({ kind, revision: cur.revision, dropped: 'older-schema' });
      continue;
    }
    const revision = (cur?.revision ?? 0) + 1;
    const value = applyDocOps(cur ? cur.value : deepFreeze(raw.init ?? {}), raw.ops);
    state.docs.set(kind, { kind, schema: raw.schema, revision, value, slot, by });
    out.push({ kind, revision, ...((cur?.revision ?? 0) !== raw.base ? { rebased: true as const } : {}) });
  }
  return out;
}

/**
 * Apply an out-of-band edit (a `hook_received` on the docs hook) at `slot`.
 * Inert (`'inert'`) when the payload is not the docs shape or its `id` was
 * already seen. Otherwise all of its edits apply exactly or none do: each
 * must be on its document's current revision (0 for an absent one) and not
 * below its stored schema. Either way the outcome is recorded in `docEdits`.
 */
export function foldOutOfBandEdits(state: SessionState, payload: unknown, slot: number): 'applied' | 'conflict' | 'inert' {
  if (!isDocsPayload(payload) || state.docEdits.has(payload.id)) return 'inert';
  const kinds = new Set<string>();
  let ok = payload.docs.length > 0;
  for (const edit of payload.docs) {
    if (!ok) break;
    if (!validEdit(edit) || kinds.has(edit.kind)) {
      ok = false;
      break;
    }
    kinds.add(edit.kind);
    const cur = state.docs.get(edit.kind);
    if (edit.base !== (cur?.revision ?? 0) || (cur && edit.schema < cur.schema)) ok = false;
  }
  if (ok) {
    for (const edit of payload.docs) {
      const cur = state.docs.get(edit.kind);
      const value = applyDocOps(cur ? cur.value : deepFreeze(edit.init ?? {}), edit.ops);
      state.docs.set(edit.kind, { kind: edit.kind, schema: edit.schema, revision: (cur?.revision ?? 0) + 1, value, slot, by: { edit: payload.id } });
    }
  }
  state.docEdits.set(payload.id, { applied: ok, slot });
  return ok ? 'applied' : 'conflict';
}

// ---------------------------------------------------------------------------
// Readers and writers

/** A document's value as one definition reads it. */
export interface Materialized {
  /** Deep-frozen. */
  value: JsonObject;
  revision: number;
  /** Whether the log has the document (`revision > 0`). */
  present: boolean;
  /** Read through `migrate` (the stored schema is older than the definition's). */
  migrated: boolean;
  /** The value as the log holds it (before any migration), when it is there: what the size limit compares growth with. */
  stored?: JsonObject;
}

/** The bytes the log holds for a materialized document, 0 when it holds none (`prepareUpdate`'s `storedBytes`). */
export const storedBytes = (m: Pick<Materialized, 'stored'>): number => (m.stored ? docBytes(m.stored) : 0);

function definitionOf<T extends object>(doc: Doc<T>): DocDefinition<T> {
  const def = doc?.definition;
  if (!def || typeof def.kind !== 'string' || typeof def.initial !== 'function') {
    throw new TypeError('harness-world: not a document token (make one with defineDoc)');
  }
  return def;
}

/**
 * A stored document (or none) as `def` reads it: as is at the same schema;
 * through `migrate` when older; `DocVersionError` when newer, or older with
 * no `migrate`. A document never written is `initial()`.
 */
export function materializeDoc<T extends object>(def: DocDefinition<T>, stored: Pick<DocState, 'schema' | 'value' | 'revision'> | undefined): Materialized {
  if (!stored) return { value: deepFreeze(strictCopy(def.initial(), def.kind)), revision: 0, present: false, migrated: false };
  if (stored.schema === def.version) return { value: deepFreeze(stored.value), revision: stored.revision, present: true, migrated: false, stored: stored.value };
  if (stored.schema > def.version || !def.migrate) throw new DocVersionError(def.kind, stored.schema, def.version);
  const migrated = def.migrate(copyJson(stored.value), stored.schema);
  return { value: deepFreeze(strictCopy(migrated, def.kind)), revision: stored.revision, present: true, migrated: true, stored: stored.value };
}

/** A document in a fold (a `sessions.inspect`, a drive's view), as `doc` reads it. */
export function readDoc<T extends object>(state: Pick<SessionState, 'docs'>, doc: Doc<T>): DocSnapshot<T> {
  const def = definitionOf(doc);
  const m = materializeDoc(def, state.docs?.get(def.kind));
  return { value: m.value as unknown as DeepReadonly<T>, revision: m.revision };
}

/**
 * Run a writer's `mutate` on a copy of `current` and check the result:
 * strict JSON (a `TypeError` naming the path), `validate`, and size (over
 * the limit and larger than `current`: `DocTooLarge`). Returns the new
 * value, deep-frozen and owned by the caller of this (never the mutator's).
 *
 * `storedBytes`: what the log holds for the document (`storedBytes(m)`; 0
 * when it holds none). Growth is measured from the smaller of that and
 * `current`, so a `migrate` that makes a document bigger than the log holds
 * cannot carry it past the limit on the next write.
 */
export function prepareUpdate<T extends object>(
  def: DocDefinition<T>,
  current: JsonObject,
  mutate: (draft: T) => void | T,
  options: { storedBytes?: number | (() => number) } = {}
): JsonObject {
  if (typeof mutate !== 'function') throw new TypeError(`harness-world: update(${def.kind}) needs a function`);
  const draft = copyJson(current) as unknown as T;
  const returned = mutate(draft);
  const next = deepFreeze(strictCopy(returned === undefined ? draft : returned, def.kind));
  def.validate?.(next as unknown as DeepReadonly<T>);
  const bytes = docBytes(next);
  if (bytes > DOC_MAX_BYTES) {
    const floor = typeof options.storedBytes === 'function' ? options.storedBytes() : options.storedBytes;
    if (bytes > Math.min(docBytes(current), floor ?? Number.POSITIVE_INFINITY)) throw new DocTooLarge(def.kind, bytes);
  }
  return next;
}

/**
 * The edit that turns `base` (as read) into `next`, or undefined when there
 * is nothing to write. After a migration it is a root `set` at the new
 * schema (ops against a migrated value would not apply to the stored one). A
 * first write carries `init` when it is stored as ops.
 *
 * `exact`: the edit applies only on its own base (an out-of-band edit), so a
 * root `set` may stand in for ops that encode larger (`diffDoc`). Otherwise
 * (an in-band edit, which the fold rebases onto whatever landed meanwhile)
 * it is always the fine-grained ops: a root `set` rebased onto a sibling's or
 * an app's edit would erase it (two first appends of a large item to an
 * empty list kept only the last).
 */
export function encodeEdit(def: DocDefinition<any>, base: Materialized, next: JsonObject, options: { exact?: boolean } = {}): DocEdit | undefined {
  if (jsonEqual(base.value, next)) return undefined;
  const ops: DocOp[] = base.migrated ? [{ op: 'set', path: [], value: next }] : options.exact ? diffDoc(base.value, next) : diffOps(base.value, next);
  const rootSet = ops.length === 1 && ops[0]!.path.length === 0;
  return {
    kind: def.kind,
    base: base.revision,
    schema: def.version,
    ...(!base.present && !rootSet ? { init: base.value } : {}),
    ops,
  };
}

/** Documents inside an effect: pinned at the call's first touch of each, plus the call's own updates. */
export interface DocsIO {
  /** The document as this call sees it. `revision` is the revision it was pinned at. */
  read<T extends object>(doc: Doc<T>): DocSnapshot<T>;
  /**
   * Change the document. `mutate` gets a mutable deep copy of this call's
   * value and edits it or returns a replacement; it runs exactly once, now.
   * Returns the new value as this call sees it. The change commits with the
   * call's outcome: a call that throws, or never reports (a crash), changed
   * nothing. Throws `DocTooLarge`, `DocVersionError`, a `TypeError` (not
   * strict JSON, naming the path), or what `validate` throws.
   */
  update<T extends object>(doc: Doc<T>, mutate: (draft: T) => void | T): DeepReadonly<T>;
}

/** Documents in a drive's current view, outside effects (prompts, display). Not pinned. */
export interface DocsReader {
  read<T extends object>(doc: Doc<T>): DocSnapshot<T>;
}

/** One effect call's documents: its `DocsIO`, and the edits it made (committed with its outcome). */
export interface CallDocs {
  io: DocsIO;
  /** One edit per document the call changed, from its pinned base to its last value. */
  edits(): DocEdit[];
}

/**
 * A `DocsIO` for one call over `view` (the speculative fold when running
 * ahead, else the durable one). `onPin` sees each document's definition when
 * the call first touches it (the publisher of its live events needs `live`).
 */
export function callDocs(view: () => Pick<SessionState, 'docs'>, onPin?: (def: DocDefinition<any>) => void): CallDocs {
  const pins = new Map<string, { def: DocDefinition<any>; base: Materialized; current: JsonObject }>();
  const pin = (doc: Doc<any>) => {
    const def = definitionOf(doc);
    let p = pins.get(def.kind);
    if (!p) {
      const base = materializeDoc(def, view().docs?.get(def.kind));
      p = { def, base, current: base.value };
      pins.set(def.kind, p);
      onPin?.(def);
    } else if (p.def.version !== def.version) {
      throw new TypeError(`harness-world: document ${def.kind} was used at schema versions ${p.def.version} and ${def.version} in one call`);
    }
    return p;
  };
  return {
    io: {
      read(doc) {
        const p = pin(doc);
        return { value: p.current as never, revision: p.base.revision };
      },
      update(doc, mutate) {
        const p = pin(doc);
        p.current = prepareUpdate(p.def, p.current, mutate as (draft: object) => void | object, { storedBytes: () => storedBytes(p.base) });
        return p.current as never;
      },
    },
    edits() {
      const out: DocEdit[] = [];
      for (const p of pins.values()) {
        const edit = encodeEdit(p.def, p.base, p.current);
        if (edit) out.push(edit);
      }
      return out;
    },
  };
}

/** A `DocsReader` over `view`. */
export function docsReader(view: () => Pick<SessionState, 'docs'>): DocsReader {
  return { read: (doc) => readDoc(view(), doc) };
}

// ---------------------------------------------------------------------------
// The live `doc` event

/**
 * On the session's live stream, once per applied edit. Best effort, like
 * every live event: keep the highest `revision` seen of each kind. A drive
 * running ahead of its writes publishes from its speculative fold; when the
 * log put the edit at another revision (an app's edit landed in between) it
 * publishes the log's document once the write lands, and after a `rewind`
 * it publishes what the log has, so a client takes the next event of each
 * kind after a `rewind` whatever its revision.
 *
 * A document defined with `live: 'revision'` (the workspace's manifest) is
 * published without its `value`: a client that wants it reads it
 * (`sessions.doc`), when the revision moves past the one it has.
 */
export interface DocLiveEvent {
  type: 'doc';
  kind: string;
  revision: number;
  /** The stored schema version of the document. */
  schema: number;
  /** The whole value after the edit (after any rebase). Absent for a document defined with `live: 'revision'`. */
  value?: JsonObject;
  by: { effect: string; step: string } | { edit: string };
  t: number;
}

/** The live event for `doc` as the log has it: with its value, unless `live` is `'revision'` (the definition's `live`). */
export function docLiveEvent(doc: DocState, t: number, live: DocLive = 'value'): DocLiveEvent {
  return {
    type: 'doc',
    kind: doc.kind,
    revision: doc.revision,
    schema: doc.schema,
    ...(live === 'revision' ? {} : { value: doc.value }),
    by: 'edit' in doc.by ? { edit: doc.by.edit } : { effect: doc.by.key, step: doc.by.step },
    t,
  };
}

/** Whether `event` is a live `doc` event. */
export function isDocLiveEvent(event: unknown): event is DocLiveEvent {
  return isPlainObject(event) && event.type === 'doc' && typeof event.kind === 'string';
}

/**
 * A live `doc` event as `doc`'s definition reads it (for a client): its value
 * migrated, or `{ type: 'doc', kind, revision, error }` when it cannot be.
 * For a definition with `live: 'revision'` (or an event without a value),
 * the event without its value.
 */
export function docEventFor(doc: Doc<any>, event: { kind: string; revision: number; schema: number; value?: JsonObject }): Record<string, unknown> {
  const def = definitionOf(doc);
  const { value, ...rest } = event;
  if (def.live === 'revision' || value === undefined) return { ...rest, type: 'doc' };
  try {
    const m = materializeDoc(def, { ...rest, value });
    return { ...event, type: 'doc', schema: def.version, value: m.value };
  } catch (err) {
    return { type: 'doc', kind: event.kind, revision: event.revision, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Names and the prompt hook

/**
 * A document's short name: the last dot-separated segment of its kind, made
 * safe for a tool name (`app.todos` → `todos`, `crm.notes-v2` → `notes-v2`).
 */
export function docNameOf(kind: string): string {
  const last = kind.split('.').filter(Boolean).at(-1) ?? kind;
  return last.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Documents by name: a record's keys, or each kind's short name (`docNameOf`). Throws on a repeated name. */
export function namedDocs(docs: readonly Doc<any>[] | Readonly<Record<string, Doc<any>>>): [string, Doc<any>][] {
  const entries: [string, Doc<any>][] = Array.isArray(docs)
    ? (docs as readonly Doc<any>[]).map((d) => [docNameOf(definitionOf(d).kind), d])
    : Object.entries(docs as Record<string, Doc<any>>).map(([name, d]) => (definitionOf(d), [name, d]));
  const seen = new Set<string>();
  for (const [name] of entries) {
    if (seen.has(name)) throw new TypeError(`harness-world: two documents are named ${JSON.stringify(name)}: name them with a record ({ name: Doc })`);
    seen.add(name);
  }
  return entries;
}

/**
 * The prompt hook for kernel harnesses: what to put in the instructions of
 * each model call. A list (or record) of documents, shown with
 * `docsPrompt`, or a function of the call's documents. Off unless given:
 * documents reach the model only where the app puts them.
 */
export type PromptDocs = readonly Doc<any>[] | Readonly<Record<string, Doc<any>>> | ((docs: DocsReader) => string | undefined);

/**
 * A prompt section with the documents' current values, as JSON:
 *
 * ```text
 * The session's documents, as of this model call (JSON; revision 0: never written):
 *
 * <document name="todos" kind="app.todos" revision="3">
 * {"items":["buy milk"]}
 * </document>
 * ```
 *
 * Call it with the model effect's `io.docs` (inside the effect), so the
 * values are the ones that call pinned and a replay never depends on a later
 * read. A document this code cannot read (`DocVersionError`) shows its error.
 */
export function docsPrompt(docs: readonly Doc<any>[] | Readonly<Record<string, Doc<any>>>): (reader: DocsReader) => string {
  const named = namedDocs(docs);
  return (reader) => {
    const parts = named.map(([name, doc]) => {
      const kind = definitionOf(doc).kind;
      try {
        const snap = reader.read(doc);
        return `<document name="${name}" kind="${kind}" revision="${snap.revision}">\n${JSON.stringify(snap.value)}\n</document>`;
      } catch (err) {
        return `<document name="${name}" kind="${kind}" error="${String(err instanceof Error ? err.message : err).replace(/"/g, "'")}"></document>`;
      }
    });
    return `The session's documents, as of this model call (JSON; revision 0: never written):\n\n${parts.join('\n\n')}`;
  };
}

/** The text a `PromptDocs` option adds to one model call's instructions, or undefined (off, or nothing to add). */
export function promptDocsText(option: PromptDocs | undefined, reader: DocsReader | undefined): string | undefined {
  if (!option || !reader) return undefined;
  const text = typeof option === 'function' ? option(reader) : docsPrompt(option)(reader);
  return text ? text : undefined;
}
