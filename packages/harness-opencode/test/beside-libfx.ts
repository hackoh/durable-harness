/**
 * A process that serves libfx's agents and OpenCode's sessions side by side,
 * as one Function that has both does: a real libfx engine (the workspace's
 * libfx, its native addon) runs a turn, then OpenCode drives a session in
 * this process, and so on, `<rounds>` times, with freed memory reused in
 * between, the way libfx's own environment crash reproduces.
 *
 * libfx's addon keeps a pointer to the process's environment array. Once
 * the process has set any variable (a test runner, a framework, dotenv),
 * that array is libc's own allocation, and a variable added later makes
 * libc move it and free the old one: libfx's next lookup of a variable that
 * isn't set reads freed memory and can crash the process. So OpenCode must
 * never change `process.env`, before or after its first drive.
 *
 * Usage: tsx test/beside-libfx.ts <dir> <rounds>
 *
 * Prints `ok` and exits 0. Exits 1, printing what changed, if the
 * environment changed while libfx was running; a crash ends it with a
 * signal.
 */
import { join } from 'node:path';
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX } from 'harness-world';
import { transcriptOf } from 'harness-world-process';
import { opencodeHarness } from '../src/index.ts';
import { scriptedGateway, text } from './scripted-gateway.ts';

const [dir, roundsArg = '10'] = process.argv.slice(2) as [string, string?];
const rounds = Number(roundsArg);

// As a host does before libfx loads: from now on the environment's array is libc's own allocation.
process.env.HARNESS_OPENCODE_BESIDE_LIBFX = '1';
const { createFxEngine } = await import('libfx');

// A model that says "hi" (AI SDK stream parts), so neither engine needs a network or a key.
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const sse = (parts: unknown[]) =>
  new Response([...parts.map((p) => `data: ${JSON.stringify(p)}`), 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
const fxFetch = async (_url: unknown, init?: RequestInit) =>
  (init?.method ?? 'GET') === 'GET'
    ? Response.json({ object: 'list', data: [] })
    : sse([{ type: 'text-delta', id: 't', delta: 'hi' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]);

async function fxTurn(): Promise<void> {
  const engine = await createFxEngine({ apiKey: 'test', model: 'test/model', fetch: fxFetch as typeof fetch, modelCatalog: [], tools: [] });
  const turn = engine.prompt('hello');
  for await (const _ of turn);
  await turn.result;
  await engine.close();
}

const gateway = await scriptedGateway();
const world = createWorld({ dataDir: join(dir, 'world'), recoverActiveRuns: false });
const sessions = durableSessions({
  world,
  harness: opencodeHarness({ root: join(dir, 'sessions'), gatewayUrl: gateway.url, credential: async () => 'a-test-credential' }),
});
world.registerHandler(QUEUE_PREFIX, sessions.handler);
await world.start?.();

async function openCodeTurn(prompt: string): Promise<void> {
  gateway.script.push(() => text('hi'));
  const { sessionId } = await sessions.start({ prompt });
  const deadline = Date.now() + 90_000;
  for (;;) {
    const records = transcriptOf(await sessions.inspect(sessionId));
    const turn = records.find((r) => r.data.type === 'turn')?.data as { status?: string } | undefined;
    if (turn) {
      if (turn.status !== 'completed') throw new Error(`OpenCode's turn ended ${JSON.stringify(turn)}`);
      return;
    }
    if (Date.now() > deadline) throw new Error("OpenCode's turn did not end");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const entries = () => JSON.stringify(Object.entries(process.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
function envChanges(before: string): string[] {
  const was = new Map<string, string | undefined>(JSON.parse(before));
  const now = new Map<string, string | undefined>(Object.entries(process.env));
  const names = [...new Set([...was.keys(), ...now.keys()])].sort();
  return names.filter((k) => was.get(k) !== now.get(k)).map((k) => `${k} ${!was.has(k) ? 'added' : !now.has(k) ? 'removed' : 'changed'}`);
}

// libfx first: its engine has started (and its native threads keep running) before OpenCode is first imported.
await fxTurn();
const before = entries();
const keep: Buffer[] = [];
for (let round = 0; round < rounds; round++) {
  await openCodeTurn(`round ${round}`);
  const changed = envChanges(before);
  if (changed.length) {
    process.stdout.write(`${JSON.stringify({ round, envChanged: changed })}\n`);
    process.exit(1);
  }
  // Reuse freed memory with bytes that are not pointers, then let libfx look the environment up again.
  for (let i = 0; i < 2000; i++) keep.push(Buffer.allocUnsafeSlow(64 + (i % 64) * 16).fill(0x41));
  if (keep.length > 20000) keep.splice(0, 10000);
  await fxTurn();
}
await world.close?.();
await gateway.close();
process.stdout.write('ok\n');
process.exit(0);
