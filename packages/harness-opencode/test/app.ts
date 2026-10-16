/**
 * A stand-in for the app's process, for the crash tests: world-local, the
 * kernel and the OpenCode harness, in a process the test (or a chaos crash)
 * can SIGKILL. Usage:
 *
 *   tsx test/app.ts <dataDir> <root> chaos-tool <prompt>   arm a crash at the next tool, then send: chaos SIGKILLs this process
 *   tsx test/app.ts <dataDir> <root> chaos-model <prompt>  arm a crash in the next model stream, then send
 *   tsx test/app.ts <dataDir> <root> chaos-model-at-tool <prompt>  send; arm a crash in the next model stream when the first tool starts
 *   tsx test/app.ts <dataDir> <root> stream <prompt>       send, and print live events as JSON lines (the test kills it)
 *   tsx test/app.ts <dataDir> <root> recover <sessionId>   restart: recover active runs, print live events until the turn ends
 *
 * Prints `{"sessionId": …}` first. With `HARNESS_TEST_WORLD=postgres` (and
 * `WORKFLOW_POSTGRES_URL`) the World is world-postgres, and `<dataDir>` is
 * unused. With `SANDBOX=1`, OpenCode's own tools run on the sandbox stand-in
 * (test/stand-in.ts), its session sandbox named `SANDBOX_NAME` on an existing
 * Drive (`SANDBOX_DRIVE_DIR`, `SANDBOX_DRIVE_ID`); once its VM is up it prints
 * `{"type": "vm", "relayPid": …, "relayDir": …}` (the test tears it down).
 */
import { dirname } from 'node:path';
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX } from 'harness-world';
import { unsafeTools, workspaceTools } from 'harness-world-hands';
import { workspaceRuntime } from 'harness-world-hands/runtime';
import { opencodeHarness } from '../src/index.ts';
import { postgresWorld } from './postgres.ts';

const [dataDir, root, mode, prompt = ''] = process.argv.slice(2) as [string, string, string, string?];
const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
const sandbox = process.env.SANDBOX === '1' ? await sandboxStandIn() : undefined;
const pg = process.env.HARNESS_TEST_WORLD === 'postgres' ? await postgresWorld() : undefined;
const world = pg?.world ?? createWorld({ dataDir, recoverActiveRuns: mode === 'recover' });
const sessions = durableSessions({
  world,
  // `BUILTINS=1`: OpenCode's own tools on a virtual workspace (and the example side-effect tools); else the workspace tools only.
  // `GATEWAY_URL`: a stand-in Gateway (the tests' scripted model).
  harness: opencodeHarness({
    ...(sandbox
      ? { workspace: sandbox }
      : process.env.BUILTINS === '1'
        ? { workspace: { kind: 'virtual', runtime: workspaceRuntime() }, tools: unsafeTools({ confirmMs: 4000 }) }
        : { tools: workspaceTools() }),
    root,
    model: process.env.MODEL ?? 'anthropic/claude-haiku-4.5',
    ...(process.env.GATEWAY_URL ? { gatewayUrl: process.env.GATEWAY_URL, credential: async () => 'a-test-credential' } : {}),
  }),
  chaos: true, // a crash SIGKILLs this process
});
if (pg) pg.serve(sessions.handler);
else (world as ReturnType<typeof createWorld>).registerHandler(QUEUE_PREFIX, sessions.handler);
await world.start?.();
if (mode === 'recover') {
  const sessionId = prompt;
  out({ sessionId });
  for await (const ev of sessions.live(sessionId) as AsyncIterable<any>) {
    if (ev?.type !== 'mark') out(ev);
    if (ev?.type === 'idle') break;
  }
  await world.close?.();
  process.exit(0);
}
const { sessionId } = await sessions.start();
out({ sessionId });
if (mode === 'chaos-tool') await sessions.chaos(sessionId, { at: 'tool', afterMs: Number(process.env.CRASH_AFTER_MS ?? 500) });
const model = { at: 'model' as const, afterMs: Number(process.env.CRASH_AFTER_MS ?? 1500) };
if (mode === 'chaos-model') await sessions.chaos(sessionId, model);
let armAtTool = mode === 'chaos-model-at-tool';
void (async () => {
  for await (const ev of sessions.live(sessionId) as AsyncIterable<any>) {
    if (ev?.type !== 'mark') out(ev);
    if (armAtTool && ev?.type === 'tool_start') {
      armAtTool = false;
      out({ armed: await sessions.chaos(sessionId, model) });
    }
  }
})();
await sessions.send(sessionId, prompt);
await new Promise(() => {}); // until killed

/** The sandbox stand-in on the Drive the test made, telling the test where its VM's relay is once it boots. */
async function sandboxStandIn() {
  const { seededStandIn } = await import('./stand-in.ts');
  const name = process.env.SANDBOX_NAME!;
  const { api, workspace } = seededStandIn({ name, dir: process.env.SANDBOX_DRIVE_DIR!, driveId: process.env.SANDBOX_DRIVE_ID! });
  const timer = setInterval(() => {
    const relay = api.relayOf(name);
    if (!relay) return;
    clearInterval(timer);
    out({ type: 'vm', relayPid: relay.child().pid, relayDir: dirname(relay.configPath) });
  }, 50);
  return workspace;
}
