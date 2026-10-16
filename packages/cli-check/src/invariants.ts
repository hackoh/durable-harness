import { type CliCall, listOf, ndjsonOf, type Target, workflow, jsonOf } from './cli.ts';

/**
 * What a user should be able to rely on when they point the stock Workflow
 * CLI at a harness session. `collect` runs the CLI; `evaluate` turns what it
 * printed into findings, without throwing, so one report holds every gap.
 */

export type InvariantId =
  | 'listed'
  | 'status'
  | 'steps'
  | 'payloads'
  | 'events'
  | 'hooks'
  | 'streams-listed'
  | 'streams-read'
  | 'cli-errors'
  | 'agree';

export const INVARIANTS: readonly { id: InvariantId; title: string }[] = [
  { id: 'listed', title: 'listed under its full workflow name' },
  { id: 'status', title: 'run status, timestamps and input' },
  { id: 'steps', title: 'step names, order and statuses' },
  { id: 'payloads', title: 'step and hook payloads decode to plain values' },
  { id: 'events', title: 'events in order, one lifecycle per step, one hook_received per submission' },
  { id: 'hooks', title: 'the inbox hook while open, none once closed' },
  { id: 'streams-listed', title: 'streams listed, matching the World' },
  { id: 'streams-read', title: 'every stream decodes, and ends when it should' },
  { id: 'cli-errors', title: 'no CLI errors' },
  { id: 'agree', title: 'the CLI agrees with the World and the kernel' },
];

export type Phase = 'open' | 'closed';

export interface Finding {
  invariant: InvariantId;
  /** A short machine-stable code for the kind of gap (`stream-decode`, `string-payload`, ...). */
  code: string;
  message: string;
}

export interface SessionExpect {
  /** The run's workflow name: `workflow//durable-harness@<version>//<name>`. */
  workflowName: string;
  /** What the run input's `harness` field says. */
  inputHarness: string;
  phase: Phase;
  /** Inbox submissions (`hook_received` events). Undefined: at least one, count not checked. */
  submissions?: number;
  /** The inbox hook's token while open. */
  hookToken: string;
  /** Model and tool calls, in order, by effect name (`model`, `tool.write_file`). */
  calls: string[];
  /** `exact` for kernel harnesses; `subsequence` where bookkeeping steps (journal, place, fs) interleave. */
  callsMatch: 'exact' | 'subsequence';
  /** Which effect names count as calls. Default: `model` and `tool.*`. */
  callPattern?: RegExp;
  /** Every effect name the harness writes. */
  vocabulary: RegExp;
  /** Error messages a failed step may carry (the recovered session's interrupted tool). */
  failedSteps?: RegExp;
  /** `submission`: kernel inbox payloads `{kind, text?, nonce}`. `any-object`: any object. */
  hookPayload: 'submission' | 'any-object';
  /** Values that are opaque by design (fx's checkpoint), by step name and path. */
  opaqueOk?: (stepName: string, path: string) => boolean;
}

/** What the World API and the kernel's fold say, read in-process by the scenario (the CLI's ground truth). */
export interface Truth {
  /** The World's steps. Undefined where only the kernel's view is at hand (world-vercel, read through a deployment). */
  steps?: { stepId: string; stepName: string; status: string }[];
  eventCount: number;
  /** The run's streams. Undefined where they cannot be listed from here (world-vercel, read through a deployment). */
  streams?: string[];
  /** How many chunks each stream holds (`getInfo`), where known. */
  streamChunks?: Record<string, number>;
  /** Streams that hold chunks but that the World does not list. */
  unlistedStreams?: string[];
  /** The kernel's effects (`SessionState.effectOrder`), with the steps it ignores. Undefined for pi-world (no kernel fold). */
  kernel?: { effects: { stepId: string; name: string; status: string }[]; ignored: string[] };
}

export interface StreamRead {
  streamId: string;
  /** It must end on its own: the session is closed, or it is the stream of a step that settled. */
  mustEnd: boolean;
  call: CliCall;
  chunks: unknown[];
  decodeError?: string;
}

export interface Collected {
  runId: string;
  phase: Phase;
  runs?: CliCall;
  run?: CliCall;
  steps?: CliCall;
  stepDetails: CliCall[];
  events?: CliCall;
  hooks?: CliCall;
  streams?: CliCall;
  streamReads: StreamRead[];
  /** Calls that failed to produce JSON, by command. */
  broken: { command: string; error: string }[];
}

const STEP_PREFIX = 'step//harness-world//';
const shortName = (stepName: string) => (stepName.startsWith(STEP_PREFIX) ? stepName.slice(STEP_PREFIX.length) : stepName);

/** Run with at most `n` at a time. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    })
  );
  return out;
}

/**
 * How long a stream read may take to end (or to print its first value). Only
 * a stream that does not end waits this long; a closed one ends as soon as the
 * CLI has read it, which on a busy CI runner can take well over 15s.
 */
export const STREAM_TIMEOUT_MS = 45_000;

export interface CollectOptions {
  workflowName: string;
  /** How long a stream read may take: to end, for one that must; to print its first value, for one that stays open. */
  streamTimeoutMs?: number;
  /** Chunks per stream, from the World: an open stream with none is not read (nothing to decode, and it would not end). */
  streamChunks?: Record<string, number>;
  /** Stream reads, at most (the steps' streams are dropped first). */
  maxStreams?: number;
}

/** Run every `workflow inspect` view a user would open for one session. */
export async function collect(target: Target, runId: string, phase: Phase, options: CollectOptions): Promise<Collected> {
  const out: Collected = { runId, phase, stepDetails: [], streamReads: [], broken: [] };
  const [runs, run, steps, events, hooks, streams] = await Promise.all([
    workflow(target, ['inspect', 'runs', '-n', options.workflowName, '--limit', '100', '--sort', 'desc']),
    workflow(target, ['inspect', 'run', runId]),
    // --all (vercel/workflow#4760) follows the cursors: every step and event, however long the session.
    workflow(target, ['inspect', 'steps', '-r', runId, '-d', '--sort', 'asc', '--limit', '100', '--all']),
    workflow(target, ['inspect', 'events', '-r', runId, '-d', '--sort', 'asc', '--limit', '100', '--all']),
    workflow(target, ['inspect', 'hooks', '-r', runId]),
    workflow(target, ['inspect', 'streams', '-r', runId]),
  ]);
  Object.assign(out, { runs, run, steps, events, hooks, streams });

  // One single-step view per step name: the view a user opens from the list.
  let stepList: Record<string, any>[] = [];
  try {
    stepList = listOf(steps);
  } catch (err) {
    out.broken.push({ command: 'steps', error: String(err) });
  }
  const firstOfName = new Map<string, string>();
  for (const s of stepList) if (!firstOfName.has(s.stepName)) firstOfName.set(s.stepName, s.stepId);
  // `-r` is required: a step id names a step within its run (cli-quirks.test.ts, Q6).
  out.stepDetails = await pool([...firstOfName.values()], 6, (id) => workflow(target, ['inspect', 'step', id, '-r', runId]));

  let streamIds: string[] = [];
  try {
    streamIds = listOf<{ streamId: string }>(streams).map((s) => s.streamId);
  } catch (err) {
    out.broken.push({ command: 'streams', error: String(err) });
  }
  const max = options.maxStreams ?? 16;
  const chosen = streamIds.length > max ? [...streamIds.filter((id) => !id.includes('_step_')), ...streamIds.filter((id) => id.includes('_step_'))].slice(0, max) : streamIds;
  const settledSteps = new Set(stepList.filter((s) => s.status === 'completed' || s.status === 'failed').map((s) => `${runId}_${s.stepId}`));
  const timeoutMs = options.streamTimeoutMs ?? STREAM_TIMEOUT_MS;
  const plans = chosen
    .map((streamId) => ({ streamId, mustEnd: phase === 'closed' || settledSteps.has(streamId) }))
    .filter((p) => p.mustEnd || (options.streamChunks?.[p.streamId] ?? 1) > 0);
  const failedRead = (stderr: string) => /Failed to read stream/.test(stderr);
  out.streamReads = await pool(plans, 6, async ({ streamId, mustEnd }) => {
    const call = await workflow(target, ['inspect', 'stream', streamId, '-r', runId], {
      timeoutMs,
      // A stream that stays open never ends: its first decoded value (or an error) is all there is to see.
      // One that must end is read to its end: a stream the CLI cannot decode exits non-zero on its own (#4760).
      enough: mustEnd ? undefined : (stdout, err) => stdout.includes('\n') || failedRead(err),
    });
    const read: StreamRead = { streamId, mustEnd, call, chunks: [] };
    try {
      read.chunks = ndjsonOf(call);
    } catch (err) {
      read.decodeError = `stdout is not JSON lines: ${String(err)}`;
    }
    const failed = call.stderr.match(/\{"error":"Failed to read stream[^\n]*/);
    if (failed) {
      try {
        read.decodeError = (JSON.parse(failed[0]) as { details?: string }).details ?? failed[0];
      } catch {
        read.decodeError = failed[0];
      }
    } else if (failedRead(call.stderr)) read.decodeError = (call.stderr.match(/Failed to read stream[^\n]*/) ?? ['Failed to read stream'])[0];
    return read;
  });
  return out;
}

/** An out-of-band document edit: a `hook_received` on the docs hook (its token, or its `{ $docs: 1, id, docs }` payload). */
function isDocsEdit(e: { eventData?: { token?: unknown; payload?: unknown } }): boolean {
  const token = e.eventData?.token;
  if (typeof token === 'string') return token.endsWith(':docs');
  const payload = e.eventData?.payload as { $docs?: unknown } | null | undefined;
  return !!payload && typeof payload === 'object' && payload.$docs === 1;
}

/** A value a user cannot read: bytes, a raw `devl` payload, a long base64 blob, or JSON text where an object belongs. */
export function opaqueKind(value: unknown, topLevel: boolean): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value.startsWith('devl')) return 'devalue-text';
    if (value.length >= 256 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return 'base64';
    if (topLevel && /^\s*[[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === 'object') return 'json-text';
      } catch {}
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v.type === 'Buffer' && Array.isArray(v.data)) return 'bytes';
    const keys = Object.keys(v);
    if (keys.length >= 8 && keys.every((k) => /^\d+$/.test(k)) && Object.values(v).every((x) => typeof x === 'number')) return 'bytes';
  }
  return undefined;
}

/** Every opaque value under `value`, with its path. JSON text is only flagged at the top level (`input`, `output`, `payload`). */
function opaqueValues(value: unknown, path: string, depth = 0, out: { path: string; kind: string }[] = []): { path: string; kind: string }[] {
  const kind = opaqueKind(value, depth === 0);
  if (kind) {
    out.push({ path, kind });
    return out;
  }
  if (depth > 8 || !value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) opaqueValues(v, `${path}.${k}`, depth + 1, out);
  return out;
}

const time = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : Number.NaN);
const SKEW_MS = 1000;
/** Longer than any scripted session waits between creating a run or step and starting it. */
const GAP_MS = 10 * 60_000;

function inOrder(label: string, pairs: [string, unknown][], findings: Finding[]) {
  for (let i = 1; i < pairs.length; i++) {
    const [aName, a] = pairs[i - 1]!;
    const [bName, b] = pairs[i]!;
    const ta = time(a);
    const tb = time(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) continue;
    if (ta > tb + SKEW_MS) {
      findings.push({
        invariant: 'events',
        code: 'timestamps',
        message: `${label}: ${aName} ${a} is ${Math.round((ta - tb) / 1000)}s after ${bName} ${b}`,
      });
    } else if (aName === 'createdAt' && tb - ta > GAP_MS) {
      // A scripted session starts what it creates at once: hours between the two is a clock, not a queue.
      findings.push({
        invariant: 'events',
        code: 'timestamps',
        message: `${label}: ${aName} ${a} is ${((tb - ta) / 3_600_000).toFixed(1)}h before ${bName} ${b}`,
      });
    }
  }
}

function isSubsequence(needle: string[], hay: string[]): boolean {
  let i = 0;
  for (const h of hay) if (i < needle.length && h === needle[i]) i++;
  return i === needle.length;
}

export interface Observed {
  workflowName?: string;
  status?: string;
  steps: string[];
  stepStatuses: Record<string, number>;
  superseded: number;
  events?: number;
  hookTokens: string[];
  streams: number;
  streamsDecoded: number;
  streamsFailed: number;
  streamsOpen: number;
  cliMs: number;
}

export interface Evaluation {
  findings: Finding[];
  observed: Observed;
}

/** Judge what the CLI printed against what the scenario expects and what the World and the kernel say. */
export function evaluate(c: Collected, expect: SessionExpect, truth: Truth): Evaluation {
  const findings: Finding[] = [];
  const add = (invariant: InvariantId, code: string, message: string) => findings.push({ invariant, code, message });
  const callPattern = expect.callPattern ?? /^(model|tool\..+)$/;
  const ignored = new Set(truth.kernel?.ignored ?? []);
  const observed: Observed = {
    steps: [],
    stepStatuses: {},
    superseded: 0,
    hookTokens: [],
    streams: 0,
    streamsDecoded: 0,
    streamsFailed: 0,
    streamsOpen: 0,
    cliMs: 0,
  };
  const all = [c.runs, c.run, c.steps, c.events, c.hooks, c.streams, ...c.stepDetails, ...c.streamReads.map((r) => r.call)].filter(Boolean) as CliCall[];
  observed.cliMs = all.reduce((n, call) => n + call.ms, 0);

  // 9. No CLI errors (stream reads are judged in 8).
  for (const call of [c.runs, c.run, c.steps, c.events, c.hooks, c.streams, ...c.stepDetails]) {
    if (!call) continue;
    const cmd = `workflow ${call.argv.slice(0, 2).join(' ')}`;
    if (call.timedOut) add('cli-errors', 'timeout', `${cmd} timed out after ${call.ms}ms`);
    else if (call.code !== 0) add('cli-errors', 'exit-code', `${cmd} exited ${call.code}: ${call.errors.slice(0, 2).join(' | ')}`);
    else if (call.errors.length) add('cli-errors', 'stderr', `${cmd} printed: ${call.errors.slice(0, 2).join(' | ')}`);
  }
  for (const b of c.broken) add('cli-errors', 'no-json', `${b.command}: ${b.error.slice(0, 300)}`);

  const safeList = (call: CliCall | undefined): Record<string, any>[] | undefined => {
    if (!call) return undefined;
    try {
      return listOf(call);
    } catch {
      return undefined;
    }
  };
  const safeJson = (call: CliCall | undefined): any => {
    if (!call) return undefined;
    try {
      return jsonOf(call);
    } catch {
      return undefined;
    }
  };

  // 1. Listed under its workflow name.
  const runs = safeList(c.runs);
  if (!runs) add('listed', 'no-list', 'inspect runs -n printed no list');
  else if (!runs.some((r) => r.runId === c.runId)) add('listed', 'missing', `inspect runs -n ${expect.workflowName} does not list ${c.runId} (${runs.length} runs listed)`);

  // 2. Run status, timestamps, input.
  const run = safeJson(c.run);
  if (!run) add('status', 'no-run', 'inspect run printed no run');
  else {
    observed.workflowName = run.workflowName;
    observed.status = run.status;
    if (run.workflowName !== expect.workflowName) add('status', 'workflow-name', `workflowName is ${run.workflowName}, expected ${expect.workflowName}`);
    const want = expect.phase === 'open' ? 'running' : 'completed';
    if (run.status !== want) add('status', 'status', `status is ${run.status} while ${expect.phase}, expected ${want}${run.error ? ` (error: ${JSON.stringify(run.error).slice(0, 200)})` : ''}`);
    if (expect.phase === 'open' && run.completedAt) add('status', 'completed-at', `an open session has completedAt ${run.completedAt}`);
    if (expect.phase === 'closed' && !run.completedAt) add('status', 'completed-at', 'a closed session has no completedAt');
    if (!run.input || typeof run.input !== 'object' || run.input.harness !== expect.inputHarness) {
      add('status', 'input', `input does not decode to { harness: '${expect.inputHarness}' }: ${JSON.stringify(run.input)?.slice(0, 200)}`);
    }
    if (run.status === 'failed' && typeof run.error?.message !== 'string') add('status', 'error', `a failed run's error has no message: ${JSON.stringify(run.error)}`);
    const created = time(run.createdAt);
    const started = time(run.startedAt);
    const completed = time(run.completedAt);
    inOrder('run', [['createdAt', run.createdAt], ['startedAt', run.startedAt]], findings);
    if (completed && started > completed + SKEW_MS) add('events', 'timestamps', `run: startedAt ${run.startedAt} is after completedAt ${run.completedAt}`);
  }

  // 3. Steps.
  const steps = safeList(c.steps);
  if (!steps) add('steps', 'no-list', 'inspect steps printed no list');
  else {
    // `--sort asc` asked for the oldest first. Judge the sequence in creation order either way.
    const byCreation = [...steps].sort((a, b) => time(a.createdAt) - time(b.createdAt) || String(a.stepId).localeCompare(String(b.stepId)));
    if (byCreation.some((s, i) => s.stepId !== steps[i]!.stepId)) {
      add('steps', 'sort-order', `inspect steps --sort asc lists steps out of creation order: ${steps.map((s) => shortName(String(s.stepName))).join(', ')}`);
    }
    for (const s of byCreation) {
      const name = shortName(String(s.stepName));
      observed.stepStatuses[s.status] = (observed.stepStatuses[s.status] ?? 0) + 1;
      if (!String(s.stepName).startsWith(STEP_PREFIX)) add('steps', 'step-name', `${s.stepId}: stepName ${s.stepName} is not step//harness-world//<effect>`);
      else if (!expect.vocabulary.test(name)) add('steps', 'vocabulary', `${s.stepId}: effect ${name} is not one this harness writes`);
      if (ignored.has(s.stepId)) {
        observed.superseded++;
        continue;
      }
      if (s.status === 'pending' || s.status === 'running') add('steps', 'unsettled', `${name} (${s.stepId}) is ${s.status} in a settled session`);
      if (s.status === 'failed') {
        const message = String(s.error?.message ?? JSON.stringify(s.error));
        if (!expect.failedSteps?.test(message)) add('steps', 'failed', `${name} (${s.stepId}) failed: ${message.slice(0, 200)}`);
      }
      observed.steps.push(name);
    }
    const calls = observed.steps.filter((n) => callPattern.test(n));
    const ok = expect.callsMatch === 'exact' ? JSON.stringify(calls) === JSON.stringify(expect.calls) : isSubsequence(expect.calls, calls);
    if (!ok) add('steps', 'calls', `calls are [${calls.join(', ')}], expected ${expect.callsMatch === 'exact' ? '' : 'to contain '}[${expect.calls.join(', ')}]`);
  }

  // 4. Payloads decode (the list view with -d, and each single-step view).
  const checkStep = (s: Record<string, any>, view: string) => {
    const name = shortName(String(s.stepName));
    if (!s.input || typeof s.input !== 'object' || typeof s.input.key !== 'string') {
      add('payloads', 'envelope', `${view} ${name}: input is not the kernel's step envelope { key, replay, input }: ${JSON.stringify(s.input)?.slice(0, 160)}`);
    }
    for (const [field, value] of [['input.input', s.input?.input], ['output', s.output], ['error', s.error]] as const) {
      for (const o of opaqueValues(value, field)) {
        if (expect.opaqueOk?.(name, o.path)) continue;
        add('payloads', o.kind, `${view} ${name}: ${o.path} is ${o.kind}`);
      }
    }
  };
  for (const s of steps ?? []) checkStep(s, 'steps');
  for (const call of c.stepDetails) {
    const s = safeJson(call);
    if (s) checkStep(s, 'step');
  }

  // 5. Events.
  const events = safeList(c.events);
  if (!events) add('events', 'no-list', 'inspect events printed no list');
  else {
    observed.events = events.length;
    for (let i = 1; i < events.length; i++) {
      if (!(String(events[i]!.eventId) > String(events[i - 1]!.eventId))) add('events', 'order', `event ${events[i]!.eventId} follows ${events[i - 1]!.eventId}`);
    }
    const lifecycle = new Map<string, string[]>();
    for (const e of events) {
      if (String(e.eventType).startsWith('step_')) {
        const list = lifecycle.get(e.correlationId) ?? [];
        list.push(String(e.eventType));
        lifecycle.set(e.correlationId, list);
      }
    }
    for (const [stepId, types] of lifecycle) {
      if (ignored.has(stepId)) continue;
      const terminal = types.filter((t) => t === 'step_completed' || t === 'step_failed');
      const shape = types.filter((t) => t !== 'step_retrying');
      if (shape[0] !== 'step_created' || shape[1] !== 'step_started' || terminal.length !== 1 || !/step_(completed|failed)/.test(shape.at(-1) ?? '')) {
        add('events', 'step-lifecycle', `${stepId}: ${types.join(' → ')}`);
      }
    }
    // Submissions only: an out-of-band document edit (a `hook_received` on the
    // session's docs hook, harness-world docs.ts) is not one.
    const received = events.filter((e) => e.eventType === 'hook_received' && !isDocsEdit(e));
    if (expect.submissions !== undefined && received.length !== expect.submissions) add('events', 'submissions', `${received.length} hook_received events, expected ${expect.submissions}`);
    if (expect.submissions === undefined && received.length === 0) add('events', 'submissions', 'no hook_received events');
    for (const e of received) {
      const payload = e.eventData?.payload;
      const kind = opaqueKind(payload, true);
      if (kind) add('payloads', kind === 'json-text' ? 'string-payload' : kind, `hook_received ${e.eventId}: payload is ${kind}${typeof payload === 'string' ? ` (${payload.slice(0, 80)})` : ''}`);
      else if (!payload || typeof payload !== 'object') add('payloads', 'hook-payload', `hook_received ${e.eventId}: payload is ${typeof payload}`);
      else if (expect.hookPayload === 'submission' && (typeof payload.kind !== 'string' || typeof payload.nonce !== 'string')) {
        add('payloads', 'hook-payload', `hook_received ${e.eventId}: payload is not a submission { kind, text, nonce }: ${JSON.stringify(payload).slice(0, 160)}`);
      }
    }
    if (expect.phase === 'closed') {
      const runEvents = events.filter((e) => String(e.eventType).startsWith('run_'));
      if (runEvents.at(-1)?.eventType !== 'run_completed') add('events', 'run-completed', `a closed session's last run event is ${runEvents.at(-1)?.eventType}`);
    }
    for (const s of steps ?? []) {
      if (ignored.has(s.stepId)) continue;
      inOrder(`step ${shortName(String(s.stepName))} ${s.stepId}`, [['createdAt', s.createdAt], ['startedAt', s.startedAt], ['completedAt', s.completedAt]], findings);
    }
  }

  // 6. Hooks.
  const hooks = safeList(c.hooks);
  if (!hooks) add('hooks', 'no-list', 'inspect hooks printed no list');
  else {
    observed.hookTokens = hooks.map((h) => String(h.token));
    // A session that had an out-of-band document edit also has its docs hook.
    const inboxes = hooks.filter((h) => !String(h.token).endsWith(':docs'));
    if (expect.phase === 'open' && (inboxes.length !== 1 || inboxes[0]!.token !== expect.hookToken)) {
      add('hooks', 'inbox', `open: hooks are [${observed.hookTokens.join(', ')}], expected [${expect.hookToken}]`);
    }
    if (expect.phase === 'closed' && hooks.length) add('hooks', 'disposed', `closed: hooks are still [${observed.hookTokens.join(', ')}]`);
  }

  // 7. Streams listed.
  const streams = safeList(c.streams);
  if (!streams) add('streams-listed', 'no-list', 'inspect streams printed no list');
  else {
    const ids = streams.map((s) => String(s.streamId));
    observed.streams = ids.length;
    if (truth.streams) {
      const world = new Set(truth.streams);
      const missing = truth.streams.filter((s) => !ids.includes(s));
      const extra = ids.filter((s) => !world.has(s));
      if (missing.length || extra.length) add('streams-listed', 'mismatch', `CLI and World disagree: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
    }
    for (const name of truth.unlistedStreams ?? []) {
      add('streams-listed', 'unlisted', `${name} holds ${truth.streamChunks?.[name] ?? 'some'} chunks, but neither the World nor the CLI lists it`);
    }
    const stepIds = new Set((steps ?? []).map((s) => String(s.stepId)));
    for (const id of ids) {
      const step = id.slice(c.runId.length + 1);
      if (step.startsWith('step_') && !stepIds.has(step)) add('streams-listed', 'orphan', `${id} names no listed step`);
    }
  }

  // 8. Streams read.
  const kinds = new Map<string, number>();
  for (const r of c.streamReads) {
    const kind = r.streamId.slice(c.runId.length + 1).replace(/^step_.*/, 'step');
    if (r.decodeError) {
      observed.streamsFailed++;
      kinds.set(`${kind}: ${r.decodeError}`, (kinds.get(`${kind}: ${r.decodeError}`) ?? 0) + 1);
      continue;
    }
    observed.streamsDecoded++;
    // A chunk may be any value the CLI can print legibly (fx's model steps stream the raw SSE text); bytes or encoded payloads are not.
    const opaque = r.chunks.filter((x) => opaqueKind(x, false));
    if (opaque.length) add('streams-read', 'chunk', `${r.streamId}: ${opaque.length} chunks are ${opaqueKind(opaque[0], false)} (${JSON.stringify(opaque[0]).slice(0, 80)})`);
    if (r.call.timedOut) {
      observed.streamsOpen++;
      if (r.mustEnd) add('streams-read', 'not-closed', `${kind} stream ${r.streamId} did not end within ${r.call.ms}ms (${expect.phase === 'closed' ? 'the session is closed' : 'its step settled'})`);
      else add('streams-read', 'no-output', `${kind} stream ${r.streamId} printed nothing within ${r.call.ms}ms, though the World holds ${truth.streamChunks?.[r.streamId] ?? 'some'} chunks`);
    } else if (r.call.stoppedEarly) observed.streamsOpen++;
    else if (r.call.code !== 0) add('streams-read', 'exit-code', `${r.streamId}: exited ${r.call.code}`);
  }
  if (kinds.size) {
    const list = [...kinds].map(([what, n]) => (n > 1 ? `${what} (x${n})` : what)).join('; ');
    add('streams-read', 'stream-decode', `${observed.streamsFailed} of ${c.streamReads.length} streams fail to decode: ${list}`);
  }

  // 10. The CLI agrees with the World and the kernel.
  if (steps) {
    const cli = new Map(steps.map((s) => [String(s.stepId), String(s.status)]));
    if (truth.steps) {
      const world = new Map(truth.steps.map((s) => [s.stepId, s.status]));
      for (const [id, status] of world) {
        if (!cli.has(id)) add('agree', 'step-missing', `the World has step ${id} (${status}); the CLI does not list it`);
        else if (cli.get(id) !== status) add('agree', 'step-status', `step ${id}: CLI says ${cli.get(id)}, the World ${status}`);
      }
      for (const id of cli.keys()) if (!world.has(id)) add('agree', 'step-extra', `the CLI lists step ${id}; the World does not have it`);
    }
    for (const e of truth.kernel?.effects ?? []) {
      if (e.status !== 'completed' && e.status !== 'failed') continue;
      if (!cli.has(e.stepId)) add('agree', 'kernel-step', `the kernel's ${e.name} (${e.stepId}) is not in the CLI's steps`);
      else if (cli.get(e.stepId) !== e.status) add('agree', 'kernel-status', `${e.name} (${e.stepId}): kernel ${e.status}, CLI ${cli.get(e.stepId)}`);
    }
  }
  if (events && events.length !== truth.eventCount) add('agree', 'event-count', `the CLI lists ${events.length} events, the World has ${truth.eventCount}`);

  return { findings: aggregate(findings), observed };
}

/** One finding per invariant and code: the first message, and how many more there were. */
function aggregate(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.invariant}/${f.code}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].map((group) =>
    group.length === 1 ? group[0]! : { ...group[0]!, message: `${group[0]!.message} (and ${group.length - 1} more like it)` }
  );
}
