/**
 * Drive a hybrid session from Node through exactly the tab's code path
 * (`createHybridClient`: remote World over /api/world, in-process queue,
 * `deliver` for the browser lane), against a running demo app.
 *
 *   HYBRID_ORIGIN=http://localhost:3100 npx tsx scripts/hybrid-proof.ts
 *
 * HYBRID_HARNESS=fx drives a hybrid fx session instead of Pi. The tab's
 * lane then runs libfx's native addon here in Node (the page runs its Wasm
 * build; both write the same tape).
 *
 * Against a protected deployment, put an automation bypass secret in a file
 * and point HYBRID_BYPASS_FILE at it; it is sent only to HYBRID_ORIGIN.
 */
import { readFileSync } from 'node:fs';
import { currentLane, type EffectRecord, type SessionState } from 'harness-world';
import { createHybridClient } from '../src/hybrid-client.ts';

const origin = (process.env.HYBRID_ORIGIN ?? 'http://localhost:3100').replace(/\/+$/, '');
const bypass = process.env.HYBRID_BYPASS_FILE ? readFileSync(process.env.HYBRID_BYPASS_FILE, 'utf8').trim() : undefined;
const turnTimeoutMs = Number(process.env.HYBRID_TURN_TIMEOUT_MS ?? 300_000);

// Everything that goes to the demo app, including the model calls pi-ai makes
// through the gateway proxy, carries the bypass header. Nothing else does.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!bypass || !url.startsWith(origin)) return realFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('x-vercel-protection-bypass', bypass);
  return realFetch(input, { ...init, headers });
}) as typeof fetch;

const PROMPTS = [
  'Write notes.md containing a haiku about durable logs. Use write_file.',
  'Look up customer acme-42 and tell me their plan and account manager.',
  'Use run_on_machine to run: node -e "console.log(process.version)" && python3 --version && cat notes.md',
  'Without using any tools: what is in notes.md, what plan is customer acme-42 on, and which node version did the sandbox report?',
];

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const quiet = process.env.HYBRID_QUIET === '1';
const fx = process.env.HYBRID_HARNESS === 'fx';
const client = await createHybridClient({
  origin,
  ...(fx ? { createFxEngine: (await import('libfx')).createFxEngine as never } : {}),
  log: (m, f) => {
    if (!quiet) console.log(`  ${at()} [tab] ${m}`, f ? JSON.stringify(f) : '');
  },
});

const sessionId = await client.start(undefined, fx ? 'hybrid-fx' : 'hybrid');
console.log(`${at()} session ${sessionId} on ${origin}`);

/** The turn is over: nothing queued, back in the tab's lane, last model call finished (fx: checkpointed). */
function idle(state: SessionState): boolean {
  if (state.effectOrder.some((e) => e.status === 'running')) return false;
  if (state.submissions.some((s) => s.kind !== 'withdraw' && !state.placed.has(s.id) && !state.withdrawn.has(s.id))) return false;
  if (currentLane(state) !== 'browser') return false;
  const last = state.effectOrder.filter((e) => e.name !== 'handoff' && e.name !== 'recover').at(-1);
  if (fx) return last?.name === 'checkpoint' && last.status === 'completed';
  return last?.name === 'model' && last.status === 'completed' && (last.output as { stopReason?: string }).stopReason !== 'toolUse';
}

function text(e: EffectRecord): string {
  const out = e.output as any;
  if (typeof out === 'string') return out;
  if (typeof out?.text === 'string') return out.text; // an fx model step
  if (out?.content) {
    return out.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');
  }
  return JSON.stringify(out ?? e.error);
}

const report: unknown[] = [];
for (const [i, prompt] of PROMPTS.entries()) {
  const before = (await client.state(sessionId)).effectOrder.length;
  console.log(`\n${at()} turn ${i + 1}: ${prompt}`);
  await client.sessions.send(sessionId, prompt);
  const deadline = Date.now() + turnTimeoutMs;
  let state = await client.state(sessionId);
  let stable = 0;
  let lastLane = currentLane(state);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    state = await client.state(sessionId);
    const lane = currentLane(state);
    if (lane !== lastLane) console.log(`  ${at()} lane: ${lastLane} -> ${lane}`);
    lastLane = lane;
    stable = idle(state) ? stable + 1 : 0;
    if (stable >= 2) break;
    if (Date.now() > deadline) throw new Error(`turn ${i + 1} did not finish; last effects: ${JSON.stringify(state.effectOrder.slice(-4).map((e) => [e.name, e.status]))}`);
  }
  const effects = state.effectOrder.slice(before);
  const lanes: string[] = [];
  for (const e of effects) {
    if (e.name === 'handoff') {
      const h = e.output as { from: string; to: string; reason: string };
      lanes.push(`handoff ${h.from}->${h.to} (${h.reason})`);
      console.log(`  handoff ${h.from} -> ${h.to}: ${h.reason}`);
    } else if (e.name.startsWith('tool.') || e.name === 'model') {
      console.log(`  ${e.name} [${e.status}] ${text(e).slice(0, 600).replaceAll('\n', '\n    ')}`);
    }
  }
  report.push({
    turn: i + 1,
    prompt,
    steps: effects.map((e) => e.name),
    handoffs: lanes,
    tools: effects.filter((e) => e.name.startsWith('tool.')).map((e) => ({ name: e.name, output: text(e) })),
    answer: text(effects.filter((e) => e.name === 'model').at(-1)!),
    stepsWithStatus: effects.map((e) => `${e.name}:${e.status}`),
  });
}

const final = await client.state(sessionId);
const laneSequence = ['browser'];
for (const e of final.effectOrder) {
  if (e.name === 'handoff') laneSequence.push((e.output as { to: string }).to);
}
console.log(`\n${at()} done. run ${sessionId} (${fx ? 'hybrid-fx' : 'hybrid'})`);
console.log(`steps: ${final.effectOrder.map((e) => e.name).join(', ')}`);
console.log(`lane sequence: ${laneSequence.join(' -> ')}`);
console.log(JSON.stringify({ runId: sessionId, laneSequence, report }, null, 2));
client.close();
process.exit(0);
