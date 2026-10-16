/**
 * The durable ToolLoopAgent on world-local, in this process: no server. The
 * queue route is the one line `world.registerHandler(QUEUE_PREFIX, ...)`.
 * Kill it mid-turn (kill -9 works) and run it again with the session id: the
 * turn finishes from the log.
 *
 *   pnpm cli "Write a haiku about logs to haiku.txt"   # new session
 *   pnpm cli <sessionId> "Now read it back"            # next turn, same session
 *   pnpm cli <sessionId>                               # reattach after a kill
 *
 * Credential: AI_GATEWAY_API_KEY, or VERCEL_OIDC_TOKEN from `vercel env pull`.
 * Model: DURABLE_AI_SDK_MODEL, default anthropic/claude-haiku-4.5.
 */
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX, type SessionState, virtual } from 'durable-harness';
import { createCodingTools } from 'durable-harness/pi';
import { aiSdkHarness, type Checkpoint } from './harness.ts';
import { fromHostTools, makePayment } from './tools.ts';

const world = createWorld({ dataDir: '.workflow-data' });
const sessions = durableSessions({
  world,
  // Nothing to wait out after a kill -9: the next run's start() redelivers
  // the session, and its open steps name a process that is gone.
  harness: aiSdkHarness({
    model: process.env.DURABLE_AI_SDK_MODEL ?? 'anthropic/claude-haiku-4.5',
    instructions:
      'You are a coding agent with a workspace at /workspace and a payment tool. ' +
      'If a payment comes back interrupted, do not retry it: tell the user. Keep answers short.',
    // Pi's coding tools (read, bash, edit, write) on a virtual workspace whose files are in the log.
    tools: { ...fromHostTools(createCodingTools(virtual())), make_payment: makePayment('.ledger.jsonl') },
  }),
});
world.registerHandler(QUEUE_PREFIX, sessions.handler);
await world.start?.();

const args = process.argv.slice(2);
const resume = args[0]?.startsWith('wrun_') ? args.shift() : undefined;
const sessionId = resume ?? (await sessions.start()).sessionId;
console.error(`session ${sessionId}`);

const stop = new AbortController();
const from = await sessions.liveEnd(sessionId);
if (args[0]) await sessions.send(sessionId, args[0]);
else if (!resume) await sessions.send(sessionId, 'Write a haiku about event logs to haiku.txt, then read it back.');

void (async () => {
  try {
    for await (const e of sessions.live(sessionId, { startIndex: from, signal: stop.signal }) as AsyncIterable<any>) {
      if (e.type === 'text') process.stdout.write(`${e.delta}\n`);
      else if (e.type === 'tool_start') process.stdout.write(`[${e.name}] ${JSON.stringify(e.args)}\n`);
    }
  } catch {}
})();

/** Idle: every prompt placed, every turn checkpointed. */
const idle = (s: SessionState) =>
  s.submissions.every((x) => x.kind === 'chaos' || x.kind === 'withdraw' || s.placed.has(x.id) || s.withdrawn.has(x.id)) &&
  s.effectOrder.filter((e) => e.name === 'turn').every((t) => s.effects.get(t.key.replace('turn', 'checkpoint'))?.status === 'completed');

try {
  for (;;) {
    const state = await sessions.inspect(sessionId);
    if (state.status === 'failed') throw new Error(state.failure?.message);
    if (idle(state)) {
      const last = state.effectOrder.findLast((e) => e.name === 'checkpoint')?.output as Checkpoint | undefined;
      if (last?.error) console.error(`the turn ended with an error: ${last.error}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
} finally {
  stop.abort();
  await world.close?.();
  // world-local's queue keeps timers alive after close; nothing is in flight now.
  process.exit(process.exitCode ?? 0);
}
