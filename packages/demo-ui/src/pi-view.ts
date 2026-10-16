import type { ChaosSpec, EffectView, EventPage, SessionView, SubmissionView } from './view.ts';

/**
 * A Pi 1.0 (`pi-durable`) session in the page's view model. The server reads
 * the session's journal (pi-world's `JournalReader`) into a `PiSnapshot`,
 * and this module turns it into the same `SessionView` and event rows the
 * other harnesses fold from their logs, so the transcript and inspector draw
 * it with the same rows. Pure: no World, no Pi. The snapshot types are
 * structural copies of pi-world's, so this package depends on neither.
 *
 * Effects are Pi's own tasks: one `pi.generation` task per model call (its
 * `pi.assistant` entry carries the task id) and one `pi.tool` task per tool
 * call (its `pi.tool-result` entry too). An attempt is a process that ran
 * the task: a rerun after a crash is a second writer, so attempt 2.
 */

export interface PiSnapshotEntry {
  id: string;
  kind: string;
  model?: readonly any[];
  data?: unknown;
  byTaskId?: string;
  at: string;
  slot: number;
}
export interface PiSnapshotTask {
  id: string;
  kind: string;
  status: string;
  starts: { slot: number; at: string; by?: string }[];
  endedAt?: string;
  input?: any;
}
export interface PiSnapshotCommit {
  eventId: string;
  slot: number;
  at: string;
  valid: boolean;
  by?: string;
  summary: string[];
  entryIds: string[];
  taskIds: string[];
}
export interface PiSnapshot {
  sessionId: string;
  eventCount: number;
  commits: number;
  unfinished: boolean;
  entries: PiSnapshotEntry[];
  live?: {
    run?: { taskId: string; inputs: string[] };
    generation?: { attempt: number; message?: { content?: any[] }; retry?: { at: number; error: string } };
    tools?: { callId: string; name: string; taskId?: string; status: string; output?: string; entry?: string }[];
  };
  tasks: PiSnapshotTask[];
  log: PiSnapshotCommit[];
}

/** One line of a session's crash stream (`${id}_pichaos`): an armed crash, and the kill. */
export type PiChaosLine =
  | { t: 'armed'; at: number; spec: ChaosSpec }
  | { t: 'fired'; at: number; spec: ChaosSpec; effectKey?: string; effectName?: string; by?: string };

export const PI_DURABLE = 'pi-durable';

const userText = (m: any): string =>
  typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('') : '';

const resultText = (m: any): string => (Array.isArray(m?.content) ? m.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : '');

const isGeneration = (t: PiSnapshotTask) => t.kind === 'pi.generation';
const isTool = (t: PiSnapshotTask) => t.kind === 'pi.tool';
const startOf = (t: PiSnapshotTask) => t.starts.at(-1);
const effectKeyOf = (t: PiSnapshotTask) => `${isTool(t) ? 'tool' : 'gen'}:${t.id}`;

/** The effect a crash fired now would kill: the running tool, else the running model call. */
export function runningEffect(snap: PiSnapshot): { key: string; name: string } | undefined {
  const live = snap.tasks.filter((t) => t.status !== 'terminal' && t.starts.length);
  const tool = live.find(isTool);
  if (tool) {
    const name = toolCall(snap, tool)?.name ?? 'tool';
    return { key: effectKeyOf(tool), name: `tool.${name}` };
  }
  const gen = live.find(isGeneration);
  return gen ? { key: effectKeyOf(gen), name: 'model' } : undefined;
}

function toolCall(snap: PiSnapshot, task: PiSnapshotTask): { name: string; arguments: unknown } | undefined {
  const callId = task.input?.callId;
  for (const e of snap.entries) {
    if (e.kind !== 'pi.assistant') continue;
    for (const c of e.model?.[0]?.content ?? []) if (c?.type === 'toolCall' && c.id === callId) return c;
  }
  const slot = snap.live?.tools?.find((s) => s.callId === callId);
  return slot ? { name: slot.name, arguments: {} } : undefined;
}

export interface PiProjection {
  view: SessionView;
  events: EventPage['events'];
}

/**
 * The session as the page shows it. `chaos` is the session's crash stream;
 * `files` (optional) overrides the workspace the tool results recorded.
 */
export function piProjection(snap: PiSnapshot, chaos: PiChaosLine[] = []): PiProjection {
  const commitOf = new Map<number, PiSnapshotCommit>();
  for (const c of snap.log) commitOf.set(c.slot, c);
  const resultOf = new Map<string, PiSnapshotEntry>();
  const assistantOf = new Map<string, PiSnapshotEntry>();
  for (const e of snap.entries) {
    if (!e.byTaskId) continue;
    if (e.kind === 'pi.tool-result') resultOf.set(e.byTaskId, e);
    if (e.kind === 'pi.assistant') assistantOf.set(e.byTaskId, e);
  }
  // Effects in the order their tasks started.
  const tasks = snap.tasks.filter((t) => (isGeneration(t) || isTool(t)) && t.starts.length).sort((a, b) => a.starts[0]!.slot - b.starts[0]!.slot);
  const users = snap.entries.filter((e) => e.kind === 'pi.user');
  const subIdOf = (e: PiSnapshotEntry) => commitOf.get(e.slot)?.eventId ?? `entry:${e.id}`;
  const submissions: SubmissionView[] = users.map((e) => ({ id: subIdOf(e), kind: 'prompt', text: userText(e.model?.[0]), placed: true, withdrawn: false }));
  let nextUser = 0;
  const liveGen = snap.live?.generation;

  const effects: EffectView[] = tasks.map((t) => {
    const key = effectKeyOf(t);
    const entry = isTool(t) ? resultOf.get(t.id) : assistantOf.get(t.id);
    // An attempt is a process that ran it before its entry landed: a process
    // that only resumed it afterwards (a generation's tools phase, settling an
    // interrupted tool) did not run it again.
    const starts = entry ? t.starts.filter((s) => s.slot < entry.slot) : t.starts;
    const start = starts.at(-1) ?? startOf(t)!;
    const interrupted = isTool(t) && !!entry?.model?.[0]?.isError && /interrupted/i.test(resultText(entry.model[0]));
    const base = { key, stepId: key, attempt: interrupted ? 1 : Math.max(1, starts.length), startedAt: start.at, placed: [] as string[] };
    if (isGeneration(t)) {
      // Inputs placed before this call started are what it answers.
      while (nextUser < users.length && users[nextUser]!.slot < t.starts[0]!.slot) base.placed.push(subIdOf(users[nextUser++]!));
      if (entry) {
        const m = entry.model?.[0] ?? {};
        const failed = m.stopReason === 'error' || m.stopReason === 'aborted';
        return {
          ...base,
          name: 'model',
          status: failed ? 'failed' : 'completed',
          input: {},
          output: { content: m.content ?? [], stopReason: m.stopReason, usage: m.usage },
          ...(failed ? { error: { message: m.errorMessage ?? `the model call ended: ${m.stopReason}` } } : {}),
        };
      }
      const running = t.status !== 'terminal';
      return {
        ...base,
        name: 'model',
        status: running ? 'running' : 'failed',
        input: {},
        output: running && liveGen?.message ? { content: liveGen.message.content ?? [] } : undefined,
        ...(running ? {} : { error: { message: 'the model call ended without an answer' } }),
        ...(running && liveGen?.attempt && liveGen.attempt > 1 ? { attempt: Math.max(base.attempt, liveGen.attempt) } : {}),
      };
    }
    const call = toolCall(snap, t);
    const name = `tool.${call?.name ?? 'tool'}`;
    const input = call?.arguments ?? {};
    if (entry) {
      const m = entry.model?.[0] ?? {};
      const out = resultText(m);
      if (m.isError && /interrupted/i.test(out)) return { ...base, name, status: 'failed', input, output: undefined, error: { interrupted: true, message: out } };
      if (m.isError) return { ...base, name, status: 'failed', input, output: undefined, error: { message: out || 'the tool failed' } };
      return { ...base, name, status: 'completed', input, output: { content: m.content ?? [] } };
    }
    if (t.status !== 'terminal') {
      const slot = snap.live?.tools?.find((s) => s.taskId === t.id);
      return { ...base, name, status: 'running', input, output: slot?.output ? slot.output : undefined };
    }
    return { ...base, name, status: 'failed', input, output: undefined, error: { message: 'the tool ended without a result' } };
  });
  // Inputs not answered yet (admitted after the last call started) still show.
  while (nextUser < users.length) {
    const last = [...effects].reverse().find((e) => e.name === 'model');
    if (last) last.placed.push(subIdOf(users[nextUser]!));
    nextUser++;
  }

  // Crashes: a fired kill is a completed `chaos` effect naming the step it killed.
  let armed: ChaosSpec | undefined;
  chaos.forEach((line, i) => {
    if (line.t === 'armed') {
      armed = line.spec;
      return;
    }
    armed = undefined;
    const key = `chaos:${i}`;
    effects.push({
      key,
      stepId: key,
      name: 'chaos',
      status: 'completed',
      attempt: 1,
      input: line.spec,
      output: { kind: 'process', crashedDuring: line.effectKey, effect: line.effectName ?? 'a step', afterMs: line.spec.afterMs ?? 0, ...(line.by ? { driver: line.by } : {}) },
      startedAt: new Date(line.at).toISOString(),
      placed: [],
    });
  });

  // Files: the newest workspace a tool result recorded (`details.files`), or the fold of each call's
  // changes (`details['hw.workspace'].files`: durable-harness/pi-durable's virtualEnv()).
  let files: Record<string, string> = {};
  for (const e of snap.entries) {
    const details = e.kind === 'pi.tool-result' ? e.model?.[0]?.details : undefined;
    const recorded = details?.files;
    if (recorded && typeof recorded === 'object') files = recorded;
    const changes = details?.['hw.workspace']?.files;
    if (!changes || typeof changes !== 'object') continue;
    files = { ...files };
    for (const [path, entry] of Object.entries(changes as Record<string, unknown>)) {
      if (entry === null) delete files[path];
      else if (typeof entry === 'string') files[path] = entry;
      else if (typeof (entry as { t?: unknown }).t === 'string') files[path] = (entry as { t: string }).t;
      else if (typeof (entry as { h?: unknown }).h === 'string') files[path] = `(${(entry as { n?: number }).n ?? '?'} bytes, in the session's blob stream)`;
      else files[path] = '(binary)';
    }
  }

  // The event log: one row per journal commit. A commit that started a model
  // call or tool (its first `running` write by a process) reads `step_started`,
  // one that wrote its entry `step_completed`, so the page's timings and
  // citations work; every row is one `hook_received` in the run's log.
  const startAt = new Map<number, string>();
  for (const t of tasks) {
    const entry = isTool(t) ? resultOf.get(t.id) : assistantOf.get(t.id);
    for (const s of t.starts) if (!entry || s.slot < entry.slot) startAt.set(s.slot, effectKeyOf(t));
  }
  const doneAt = new Map<string, string>();
  for (const t of tasks) {
    const entry = isTool(t) ? resultOf.get(t.id) : assistantOf.get(t.id);
    if (entry) doneAt.set(entry.id, effectKeyOf(t));
  }
  const userAt = new Set(users.map((u) => u.slot));
  const events: EventPage['events'] = [];
  for (const c of snap.log) {
    const stepName = c.valid ? c.summary.join(', ') : c.summary.join(', ') || 'ignored';
    const started = startAt.get(c.slot);
    const done = c.entryIds.map((id) => doneAt.get(id)).find(Boolean);
    if (started) events.push({ eventId: `${c.eventId}:start`, eventType: 'step_started', correlationId: started, stepName, createdAt: c.at });
    if (done) events.push({ eventId: c.eventId, eventType: 'step_completed', correlationId: done, stepName, createdAt: c.at });
    else if (!started || userAt.has(c.slot)) events.push({ eventId: c.eventId, eventType: 'hook_received', stepName, createdAt: c.at });
  }
  // A fired crash is not in the log (the process died); its row comes from the crash stream, in time order.
  chaos.forEach((line, i) => {
    if (line.t !== 'fired') return;
    const createdAt = new Date(line.at).toISOString();
    const row = { eventId: `${snap.sessionId}:chaos:${i}`, eventType: 'step_completed', correlationId: `chaos:${i}`, stepName: `crash: ${line.effectName ?? 'a step'} (crash stream)`, createdAt };
    const at = events.findIndex((e) => e.createdAt > createdAt);
    events.splice(at < 0 ? events.length : at, 0, row);
  });

  return {
    view: {
      id: snap.sessionId,
      harness: PI_DURABLE,
      status: 'running',
      // The page re-reads a view when this moves: crash lines count too (they live outside the log).
      eventCount: snap.eventCount + chaos.length,
      ...(armed ? { armedChaos: armed } : {}),
      ...(snap.unfinished ? { working: true } : {}),
      submissions,
      effects,
      files,
      supersededStepIds: [],
    },
    events,
  };
}

/** The text of the streamed partial, for live deltas. */
export function liveText(snap: PiSnapshot): string {
  const content = snap.live?.generation?.message?.content ?? [];
  return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '').join('');
}
