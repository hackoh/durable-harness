/**
 * The two processes of the SIGKILL drill, each a separate OS process.
 *
 * The victim opens world-local at `dataDir`, starts a session with one prompt
 * asking for a payment, prints the session id, and drives it until the parent
 * SIGKILLs it (the payment tool waits a minute for its "bank" after writing
 * the ledger line, so the kill lands after the side effect and before the
 * result).
 *
 * The recoverer (`--recover`) is a new process that never drove the session:
 * it opens the same World with recovery on, whose `start()` redelivers the
 * session, waits for the turn's checkpoint, prints what the log holds as one
 * JSON line, and exits.
 *
 *   node --import tsx src/crash-child.ts <dataDir> <ledger> scripted|<gateway model id>
 *   node --import tsx src/crash-child.ts <dataDir> <ledger> scripted|<gateway model id> --recover <sessionId>
 */
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX } from 'durable-harness';
import { CRASH_INSTRUCTIONS, CRASH_PROMPT, type Recovery, until } from './crash.ts';
import { aiSdkHarness } from './harness.ts';
import { scriptedModel, text, toolCall } from './scripted.ts';
import { makePayment } from './tools.ts';

const [dataDir, ledger, model, mode, recoverId] = process.argv.slice(2);
if (!dataDir || !ledger || !model || (mode && (mode !== '--recover' || !recoverId))) {
  throw new Error('usage: crash-child.ts <dataDir> <ledger> scripted|<model> [--recover <sessionId>]');
}
const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (mode === '--recover') {
  const scripted = model === 'scripted' ? scriptedModel([text('The payment may or may not have gone through; I will not retry it.')]) : undefined;
  const world = createWorld({ dataDir, recoverActiveRuns: true });
  const sessions = durableSessions({
    world,
    harness: aiSdkHarness({ model: scripted ?? model, instructions: CRASH_INSTRUCTIONS, tools: { make_payment: makePayment(ledger, 100) } }),
  });
  world.registerHandler(QUEUE_PREFIX, sessions.handler);
  const startedAt = Date.now();
  await world.start?.();
  let interruptedAt: number | undefined;
  const state = await until(async () => {
    const s = await sessions.inspect(recoverId!);
    if (s.status === 'failed') throw new Error(`session failed: ${s.failure?.message}`);
    if (s.effectOrder.some((e) => e.name === 'tool.make_payment' && e.status === 'failed')) interruptedAt ??= Date.now();
    return s.effects.get('checkpoint:0')?.status === 'completed' ? s : undefined;
  }, 150_000, 'checkpoint:0');
  const report: Recovery = {
    pid: process.pid,
    startedAt,
    interruptedAt,
    checkpointedAt: Date.now(),
    submissions: state.submissions.map((s) => s.text ?? ''),
    effects: state.effectOrder.map(({ key, name, status, replay, error }) => ({ key, name, status, replay, error })),
    checkpoint: state.effects.get('checkpoint:0')!.output as Recovery['checkpoint'],
    ...(scripted ? { modelCalls: scripted.calls.map((c) => c.prompt) } : {}),
  };
  say(report);
  await world.close?.();
  // world-local's queue keeps timers alive after close; nothing is in flight now.
  process.exit(0);
}

const world = createWorld({ dataDir, recoverActiveRuns: false });
const sessions = durableSessions({
  world,
  harness: aiSdkHarness({
    model:
      model === 'scripted'
        ? scriptedModel([toolCall('make_payment', { to: 'alice@example.com', amountUsd: 5, memo: 'lunch' }, 'call_pay_1')])
        : model,
    instructions: CRASH_INSTRUCTIONS,
    tools: { make_payment: makePayment(ledger, 60_000) },
  }),
});
world.registerHandler(QUEUE_PREFIX, sessions.handler);
await world.start?.();
const { sessionId } = await sessions.start({ prompt: CRASH_PROMPT });
say({ sessionId, pid: process.pid });
// Keep driving until killed.
setInterval(() => {}, 1 << 30);
