/**
 * The Worker: a small JSON API over durable sessions on the Cloudflare
 * Durable Objects World. Sessions are driven by their run objects, not by
 * these requests: `send` commits the message to the log and enqueues a wake,
 * and the run object delivers it to `sessions.handler` in its own isolate.
 *
 *   POST /sessions                  { harness?: 'pi' | 'ai-sdk' | 'echo' | 'workspace', durability?: 'strict' | 'run-ahead' } -> { sessionId }
 *   POST /sessions/:id/messages     { text, kind?: 'prompt' | 'steer' | 'followUp' } -> { submissionId }
 *   GET  /sessions/:id              the fold: status, effects, submissions, the last answer, idle
 *   GET  /sessions/:id/events       the raw event log (types, correlation ids, times)
 *   GET  /sessions/:id/ledger       the unsafe tools' side effects (a World stream)
 *   GET  /sessions/:id/files        the workspace, folded from the log
 *   GET  /sessions/:id/live         the live stream so far (JSON lines), for checks
 *   GET  /sessions/:id/object       what the run object holds (signals, events)
 *   POST /sessions/:id/withdraw     { submissionId }
 *   POST /sessions/:id/close
 *   GET  /health
 */
import { readLedger, readWorkspace } from 'harness-world-hands';
import { bytesToBase64, harnessOf, type SessionState, type Submission } from 'harness-world';
import { probeIdempotency, probeWorld } from './probe.ts';
import { DEPLOYMENT_ID, piA, sessions, world } from './sessions.ts';

export { RunObject, StepRunner, StreamObject, TokenObject } from '@workflow/world-cloudflare';

interface Env {
  WORKFLOW_RUNS: { getByName(name: string): { inspect(): Promise<unknown> } };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value, (_k, v) => (v instanceof Set ? [...v] : v instanceof Map ? Object.fromEntries(v) : v)), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [head, id, sub] = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/health') return json({ ok: true, deploymentId: DEPLOYMENT_ID });
      if (head === 'probe' && process.env.HARNESS_PROBES === '1') {
        return json(id === 'idempotency' ? await probeIdempotency(world) : await probeWorld(world));
      }
      const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, any>) : {};
      if (head === 'pi-durable') return piDurableRoute(request, id, sub, body);
      if (head !== 'sessions') return json({ error: 'not found' }, 404);

      if (!id && request.method === 'POST') {
        const { sessionId } = await sessions.start({
          harness: body.harness ?? 'pi',
          ...(body.durability ? { config: { durability: body.durability } } : {}),
        });
        return json({ sessionId });
      }
      if (!id) return json({ error: 'not found' }, 404);

      if (sub === 'messages' && request.method === 'POST') {
        const kind = (body.kind ?? 'prompt') as Exclude<Submission['kind'], 'withdraw'>;
        return json({ submissionId: await sessions.send(id, String(body.text), kind) });
      }
      if (sub === 'withdraw' && request.method === 'POST') return json({ result: await sessions.withdraw(id, String(body.submissionId)) });
      if (sub === 'close' && request.method === 'POST') {
        await sessions.close(id);
        return json({ closed: true });
      }
      if (!sub) return json(summarize(await sessions.inspect(id)));
      if (sub === 'events') {
        const page = await world.events.list({ runId: id, pagination: { limit: 1000, sortOrder: 'asc' }, resolveData: 'none' });
        return json(page.data.map((e) => ({ eventId: e.eventId, eventType: e.eventType, correlationId: e.correlationId, createdAt: e.createdAt })));
      }
      if (sub === 'ledger') return json(await readLedger(world, id));
      if (sub === 'files') {
        // A binary file (bytes that are not UTF-8) as { base64 }.
        const files = await readWorkspace(world, await sessions.inspect(id));
        return json(Object.fromEntries(Object.entries(files).map(([path, c]) => [path, typeof c === 'string' ? c : { base64: bytesToBase64(c) }])));
      }
      if (sub === 'live') {
        // What the stream holds now: read until it has been quiet for a moment.
        const lines: unknown[] = [];
        if ((await sessions.liveEnd(id)) > 0) {
          const stop = new AbortController();
          let quiet = setTimeout(() => stop.abort(), 1500);
          try {
            for await (const line of sessions.live(id, { startIndex: 0, signal: stop.signal, resume: false })) {
              lines.push(line);
              clearTimeout(quiet);
              quiet = setTimeout(() => stop.abort(), 500);
            }
          } catch {}
          clearTimeout(quiet);
        }
        return json(lines);
      }
      if (sub === 'object') return json(await env.WORKFLOW_RUNS.getByName(id).inspect());
      return json({ error: 'not found' }, 404);
    } catch (error) {
      const e = error as Error;
      return json({ error: e.message, name: e.name, stack: e.stack }, 500);
    }
  },
};

/** Pi variant A's API: its sessions are Pi journals, not kernel folds. */
async function piDurableRoute(request: Request, id: string | undefined, sub: string | undefined, body: Record<string, any>) {
  if (!id && request.method === 'POST') return json({ sessionId: await piA.create() });
  if (!id) return json({ error: 'not found' }, 404);
  if (sub === 'messages' && request.method === 'POST') return json({ submissionId: await piA.send(id, String(body.text), String(body.kind ?? 'prompt')) });
  if (sub === 'ledger') return json([]);
  if (sub === 'events') {
    const page = await world.events.list({ runId: id, pagination: { limit: 1000, sortOrder: 'asc' }, resolveData: 'none' });
    return json(page.data.map((e) => ({ eventId: e.eventId, eventType: e.eventType, correlationId: e.correlationId, createdAt: e.createdAt })));
  }
  if (sub) return json({ error: 'not found' }, 404);
  const snap = await piA.read(id);
  if (new URL(request.url).searchParams.has('raw')) return json(snap);
  type PiMessage = { role?: string; content?: unknown; toolName?: string; isError?: boolean; details?: { files?: Record<string, string> } };
  const messages = snap.entries.flatMap((e) => (e.model ?? []) as PiMessage[]);
  const said = messages.filter((m) => m.role === 'assistant').map((m) => (Array.isArray(m.content) ? textOf(m.content) : String(m.content ?? ''))).filter(Boolean);
  const results = messages.filter((m) => m.role === 'toolResult');
  // Tool names by call id, from the assistant messages that asked for them.
  const callName = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; id?: string; name?: string }[]) if (part.type === 'toolCall' && part.id && part.name) callName.set(part.id, part.name);
  }
  const tasks = snap.tasks.map((t) => {
    const callId = (t.input as { callId?: string } | undefined)?.callId;
    return { kind: t.kind, status: t.status, starts: t.starts.length, ...(callId ? { tool: callName.get(callId) } : {}) };
  });
  return json({
    unfinished: snap.unfinished,
    commits: snap.commits,
    eventCount: snap.eventCount,
    entries: snap.entries.map((e) => e.kind),
    tasks,
    running: tasks.filter((t) => t.kind === 'pi.tool' && t.status !== 'terminal').map((t) => t.tool),
    tools: results.map((m) => ({ name: m.toolName, isError: !!m.isError, text: (Array.isArray(m.content) ? textOf(m.content) : String(m.content ?? '')).slice(0, 200) })),
    // The workspace: the newest tool result that recorded one (pi-world's rule).
    files: results.findLast((m) => m.details?.files)?.details?.files ?? {},
    text: said.at(-1),
  });
}

/** What the drills and tests read: the fold, minus the payloads. */
function summarize(state: SessionState) {
  const effects = state.effectOrder.map((e) => ({
    key: e.key,
    name: e.name,
    status: e.status,
    stepId: e.stepId,
    ...(e.retryOf ? { retryOf: e.retryOf } : {}),
    ...(e.error ? { error: e.error.message, interrupted: !!e.error.interrupted } : {}),
    ...(e.name.startsWith('tool.') ? { input: e.input } : {}),
    // The workspace checks read what each call returned.
    ...(e.name.startsWith('tool.') && harnessName(state) === 'workspace' && e.status === 'completed' ? { output: e.output } : {}),
    placed: e.placed,
  }));
  const busy = state.effectOrder.some((e) => e.status === 'running' || e.status === 'pending');
  // Messages a turn must place (a withdraw or an armed crash is not one).
  const unplaced = state.submissions.filter((s) => (s.kind === 'prompt' || s.kind === 'steer' || s.kind === 'followUp') && !state.placed.has(s.id) && !state.withdrawn.has(s.id));
  // The last step of a turn's own (not a fact like `recover` or `fs`).
  const last = state.effectOrder.findLast((e) => e.name === 'model' || e.name === 'checkpoint' || e.name.startsWith('tool.'));
  const answered = !!last && (last.name === 'checkpoint' || (last.name === 'model' && (last.output as { stopReason?: string } | undefined)?.stopReason !== 'toolUse') || (last.name.startsWith('tool.') && (harnessName(state) === 'echo' || harnessName(state) === 'workspace')));
  return {
    workflowName: state.workflowName,
    status: state.status,
    idle: !busy && unplaced.length === 0 && answered,
    submissions: state.submissions.map((s) => ({ id: s.id, kind: s.kind, text: s.text, placed: state.placed.has(s.id), withdrawn: state.withdrawn.has(s.id) })),
    effects,
    text: lastText(state),
  };
}

const harnessName = (state: SessionState) => harnessOf(state.workflowName);

/** The last thing the model said: Pi's last model output, or the AI SDK's last checkpoint. */
function lastText(state: SessionState): string | undefined {
  for (const e of [...state.effectOrder].reverse()) {
    if (e.status !== 'completed') continue;
    if (e.name === 'model' && Array.isArray((e.output as { content?: unknown })?.content)) {
      const text = textOf((e.output as { content: unknown[] }).content);
      if (text) return text;
    }
    // fx records each model response with its text.
    if (e.name === 'model' && typeof (e.output as { text?: unknown })?.text === 'string' && (e.output as { text: string }).text.trim()) {
      return (e.output as { text: string }).text.trim();
    }
    if (e.name === 'checkpoint') {
      const messages = (e.output as { messages?: { role: string; content: unknown }[] })?.messages ?? [];
      const reply = messages.findLast((m) => m.role === 'assistant');
      if (reply) return typeof reply.content === 'string' ? reply.content : textOf(reply.content as unknown[]);
    }
  }
  return undefined;
}

const textOf = (parts: unknown[]) =>
  parts
    .map((p) => ((p as { type?: string }).type === 'text' ? (p as { text: string }).text : ''))
    .join('')
    .trim();
