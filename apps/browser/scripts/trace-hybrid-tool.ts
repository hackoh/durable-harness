/**
 * Trace one hybrid tool turn through exactly the tab's code path, from Node:
 * every HTTP call the tab makes (World ops by name, model calls, token and
 * config reads) with when it started and how long it took to answer, then
 * the steps the turn committed. Shows which writes are serial on the path
 * between two model calls.
 *
 *   HYBRID_ORIGIN=https://… HYBRID_BYPASS_FILE=/tmp/bypass npx tsx scripts/trace-hybrid-tool.ts [bash|write|sandbox]
 *
 * HYBRID_HARNESS=fx traces a hybrid fx session (libfx's native addon here).
 * Times are to the response's headers: a streamed body (the model's, a tail)
 * goes on after its line.
 */
import { readFileSync } from 'node:fs';
import { currentLane, type SessionState } from 'harness-world';
import { wire } from '../../../packages/world-remote/src/wire.ts';
import { createHybridClient } from '../src/hybrid-client.ts';

const origin = (process.env.HYBRID_ORIGIN ?? 'http://localhost:3100').replace(/\/+$/, '');
const bypass = process.env.HYBRID_BYPASS_FILE ? readFileSync(process.env.HYBRID_BYPASS_FILE, 'utf8').trim() : undefined;
const which = process.argv[2] ?? 'bash';
const fx = process.env.HYBRID_HARNESS === 'fx';
const PROMPTS: Record<string, string> = {
  bash: "Run `echo hi` with the bash tool, then reply 'done'.",
  write: "Write the file notes.txt containing exactly 'hi' using write_file, then reply 'done'.",
  sandbox: 'Use run_on_machine to run: node -v. Then reply with just the version.',
};
if (!PROMPTS[which]) throw new Error(`expected one of ${Object.keys(PROMPTS).join(', ')}`);

const T0 = performance.now();
const ms = () => Math.round(performance.now() - T0);
const at = (t: number) => String(t).padStart(6);

/** A request as a line: World ops by name (and event type or stream), anything else by path. */
function label(url: string, body: unknown): string {
  if (url.startsWith(`${origin}/api/world`) && typeof body === 'string') {
    try {
      const { op, args } = wire.parse(body) as { op: string; args: any[] };
      if (op === 'events.create') return `world ${op} ${args[1]?.eventType} ${args[1]?.correlationId ?? ''}`;
      if (op === 'streams.write' || op === 'streams.writeMulti') return `world ${op} ${String(args[1]).replace(/^wrun_[^_]+_/, '')}`;
      return `world ${op}`;
    } catch {}
  }
  if (url.startsWith(origin)) return url.slice(origin.length);
  const u = new URL(url);
  return `${u.host}${u.pathname}`;
}

// Everything to the app carries the bypass header (when given); nothing else does.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (bypass && url.startsWith(origin)) headers.set('x-vercel-protection-bypass', bypass);
  const name = label(url, init?.body);
  const start = ms();
  const tail = url.includes('op=streams.get') || name.includes('streams.get');
  if (tail) console.log(`${at(start)}   tail  ${name}`);
  try {
    const res = await realFetch(input, { ...init, headers });
    if (!tail) console.log(`${at(start)} ${String(ms() - start).padStart(5)}ms ${res.status} ${name}`);
    return res;
  } catch (err) {
    console.log(`${at(start)} ${String(ms() - start).padStart(5)}ms ERR ${name} ${String(err)}`);
    throw err;
  }
}) as typeof fetch;

const client = await createHybridClient({
  origin,
  ...(fx ? { createFxEngine: (await import('libfx')).createFxEngine as never } : {}),
  log: (m, f) => console.log(`${at(ms())}   log   ${m} ${f ? JSON.stringify(f).slice(0, 300) : ''}`),
});
const sessionId = await client.start(undefined, fx ? 'hybrid-fx' : 'hybrid');
console.log(`${at(ms())} session ${sessionId}`);
// Let the session's start settle (its watch, the hints tail) before the turn.
await new Promise((r) => setTimeout(r, 4000));
console.log(`${at(ms())} === send (${which})`);
const sent = ms();
await client.sessions.send(sessionId, PROMPTS[which]!);

/** The turn is over: nothing running, back in the tab, the last model call finished (fx: checkpointed). */
function idle(state: SessionState): boolean {
  if (state.effectOrder.some((e) => e.status === 'running')) return false;
  if (currentLane(state) !== 'browser') return false;
  const last = state.effectOrder.filter((e) => e.name !== 'handoff' && e.name !== 'recover' && e.name !== 'host').at(-1);
  if (fx) return last?.name === 'checkpoint' && last.status === 'completed';
  return last?.name === 'model' && last.status === 'completed' && (last.output as { stopReason?: string }).stopReason !== 'toolUse';
}
let state = await client.peek(sessionId);
for (let i = 0; !idle(state) && i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  state = await client.peek(sessionId);
}
console.log(`${at(ms())} === ${idle(state) ? 'idle' : 'gave up'} (${ms() - sent} ms after send)`);
console.log(`steps: ${state.effectOrder.map((e) => `${e.name}:${e.status}`).join(' ')}`);
client.close();
process.exit(0);
