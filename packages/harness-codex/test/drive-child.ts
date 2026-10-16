/**
 * One machine of the restart tests that SIGKILL a driver (docs/workspaces.md
 * §11.4, R1/R2): drives a Codex session on world-local in this process, on
 * a stand-in Sandbox API of its own (`FakeSandboxApi`, its "VMs" this
 * process's relay children), so nothing of the Function's side (the
 * factory's links and caches, the fake API's registry) survives the kill
 * into the recovery, which another process runs on a new VM. Its model is
 * the parent's `fakeModel()`.
 *
 * Usage (under `NODE_ENV=test DH_TEST_LOCAL_SANDBOX=1`, with tsx):
 * `drive-child.ts <dataDir> <gatewayUrl> <prompt>`. It reports on stdout,
 * one JSON object per line, the session id, the session's Drive (for the
 * recovering process to adopt) and every live event, so the test can kill
 * it at the worst time. It never exits by itself.
 */
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX } from 'harness-world';
import { unsafeTools } from 'harness-world-hands';
import { sandboxSession } from 'harness-world-sandbox';
import { sessionName } from 'harness-world-sandbox/names';
import { FakeSandboxApi } from 'harness-world-sandbox/testing/fake-api';
import { codexHarness } from '../src/harness.ts';
import { FAKE } from './stand-in.ts';

const [dataDir, gatewayUrl, prompt] = process.argv.slice(2);
if (!dataDir || !gatewayUrl || !prompt) throw new Error('usage: drive-child.ts <dataDir> <gatewayUrl> <prompt>');
const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

const api = new FakeSandboxApi();
const world = createWorld({ dataDir, recoverActiveRuns: false });
const sessions = durableSessions({
  world,
  harness: codexHarness({
    builtins: true,
    tools: unsafeTools({ confirmMs: 3000 }),
    machine: {
      acquire: sandboxSession({
        spec: { vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 10 * 1024 ** 3, budget: { vmSeconds: Infinity }, image: 'stand-in' },
        test: { api, allowDegraded: true, allowUnauthenticatedModel: true },
      }),
      env: { FAKE_CODEX_MODEL: 'remote' },
    },
    test: { command: process.execPath, args: [FAKE] },
    gatewayUrl,
    credential: async () => 'test-key',
    model: 'openai/gpt-5.4-mini',
  }),
});
world.registerHandler(QUEUE_PREFIX, sessions.handler);
await world.start?.();
const { sessionId } = await sessions.start();
say({ sessionId });
const from = await sessions.liveEnd(sessionId);
void (async () => {
  for await (const event of sessions.live(sessionId, { startIndex: from }) as AsyncIterable<{ type?: string }>) {
    // The Drive exists once a tool runs or a turn ended: reported for the recovering process to adopt.
    if (event.type === 'tool_start' || event.type === 'idle') say({ drive: api.driveInfo(sessionName('prj_stand_in', sessionId)) });
    say({ live: event });
  }
})();
await sessions.send(sessionId, prompt);
// The test kills this process; it never exits by itself.
setInterval(() => {}, 1 << 30);
