/**
 * A durable Claude Code turn on world-local, with the CLI in a real Vercel
 * Sandbox VM (the session's, with a Drive at /workspace), end to end:
 *
 *   cd <a directory linked with `vercel link`> && AI_GATEWAY_API_KEY=... pnpm --filter harness-world-claude-code example
 *   # or a VERCEL_OIDC_TOKEN from `vercel env pull`
 *
 * The session's log lives in `.workflow-data/`; its files on the session's
 * Drive. Run it twice: the second run resumes the same session from the log
 * on whatever VM is up (pass the session id it printed). The project's base
 * snapshot is built on the first run (about 20 s).
 */
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX } from 'harness-world';
import { transcriptOf } from 'harness-world-process';
import { devRelayArtifact, kernelSandbox, prepareBase, sandboxSession } from 'harness-world-sandbox';
import { claudeCodeHarness } from 'harness-world-claude-code';

const world = createWorld({ dataDir: '.workflow-data' });
const acquire = sandboxSession({
  spec: { vcpus: 2, network: 'allow-all', idleMs: 5 * 60_000, driveSize: 10 * 1024 ** 3, budget: { vmSeconds: 4 * 60 * 60 } },
  base: async (region) => ({ snapshot: (await prepareBase({ region, relay: await devRelayArtifact() })).snapshotId }),
});
const sessions = durableSessions({
  world,
  harness: claudeCodeHarness({
    model: process.env.CLAUDE_CODE_MODEL ?? 'claude-haiku-4-5',
    builtins: true, // Claude Code's own Bash, Read, Edit, Write, ... in the VM, on /workspace
    sandbox: { ...kernelSandbox(acquire), network: 'allow-all', budget: { turnUsd: 1, sessionUsd: 5 } },
  }),
});
world.registerHandler(QUEUE_PREFIX, sessions.handler);
await world.start?.();

const resumed = process.argv[2];
const { sessionId } = resumed ? { sessionId: resumed } : await sessions.start();
const prompt = resumed ? 'What did you write, and where?' : 'Write a haiku about durable logs to haiku.txt, then read it back.';
console.log(`session ${sessionId}\n> ${prompt}`);
const from = await sessions.liveEnd(sessionId);
await sessions.send(sessionId, prompt);

// Live output from here on: text deltas, tool calls, and `idle` when the turn ends.
for await (const ev of sessions.live(sessionId, { startIndex: from }) as AsyncIterable<{ type: string; delta?: string; name?: string }>) {
  if (ev.type === 'text') process.stdout.write(ev.delta ?? '');
  if (ev.type === 'tool_start') console.log(`\n[tool ${ev.name}]`);
  if (ev.type === 'idle') break;
}
const state = await sessions.inspect(sessionId);
console.log('\n\nturns:', transcriptOf(state).filter((r) => r.data.type === 'turn').map((r) => r.data));
await world.close?.();
process.exit(0);
