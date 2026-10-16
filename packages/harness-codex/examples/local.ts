/**
 * A durable Codex turn on world-local, its log in this Node process and
 * Codex in the session's Vercel Sandbox VM (from a directory `vercel link`
 * linked, with the CLI logged in):
 *
 *   pnpm --filter harness-world-codex example                 # a turn with a tool
 *   pnpm --filter harness-world-codex example "your prompt"
 *
 * The Gateway credential is AI_GATEWAY_API_KEY, or VERCEL_OIDC_TOKEN (from
 * `vercel env pull`); it stays in this process. The session's log lives in
 * `.workflow-data`; run it again with SESSION=<id> to continue the same
 * session on whatever VM it gets (its thread is restored from the log).
 * Until the relay authenticates the VM's model port (A5), the session
 * factory refuses to relay model calls outside tests, so this fails with
 * that `Unavailable`.
 */
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX } from 'harness-world';
import { filesFromState, workspaceTools } from 'harness-world-hands';
import { transcriptOf } from 'harness-world-process';
import { devRelayArtifact, prepareBase, sandboxSession } from 'harness-world-sandbox';
import { codexHarness } from 'harness-world-codex';

// The session's VM and Drive: the base snapshot (the relay, the pinned codex, bwrap) built once per region.
const acquire = sandboxSession({
  spec: { vcpus: 2, network: 'allow-all', idleMs: 5 * 60_000, driveSize: 10 * 1024 ** 3, budget: { vmSeconds: 60 * 60 } },
  base: async (region) => ({ snapshot: (await prepareBase({ region, relay: await devRelayArtifact() })).snapshotId }),
  log: (message, fields) => console.error(`[sandbox] ${message}`, fields ?? ''),
});

const world = createWorld({ dataDir: '.workflow-data' });
const sessions = durableSessions({
  world,
  harness: codexHarness({
    model: process.env.CODEX_MODEL ?? 'openai/gpt-5.4-mini',
    tools: workspaceTools(), // Codex's built-ins are off: these are its only tools
    machine: { acquire }, // `codex app-server` in the session's VM, /workspace on its Drive
    instructions: 'You work in /workspace through your tools. Keep answers short.',
  }),
});
// An app mounts sessions.handler where the World delivers the kernel's queue
// (/.well-known/durable-harness/v1/flow); a script hands it to world-local
// directly.
world.registerHandler(QUEUE_PREFIX, sessions.handler);
await world.start?.(); // re-enqueues the runs a dead process left active

const prompt = process.argv[2] ?? 'Create hello.txt saying hello from a durable Codex, then read it back.';
const sessionId = process.env.SESSION ?? (await sessions.start()).sessionId;
console.log(`session ${sessionId}`);

// Stream the text as it arrives.
const live = (async () => {
  for await (const event of sessions.live(sessionId, { startIndex: await sessions.liveEnd(sessionId) })) {
    const e = event as { type?: string; delta?: string; name?: string };
    if (e.type === 'text') process.stdout.write(e.delta ?? '');
    if (e.type === 'tool_start') process.stdout.write(`\n[${e.name}]\n`);
    if (e.type === 'idle') return;
  }
})();

const before = transcriptOf(await sessions.inspect(sessionId)).filter((r) => r.data.type === 'turn').length;
await sessions.send(sessionId, prompt);
for (;;) {
  const state = await sessions.inspect(sessionId);
  if (transcriptOf(state).filter((r) => r.data.type === 'turn').length > before) {
    await Promise.race([live, new Promise((r) => setTimeout(r, 1000))]);
    console.log('\n\nworkspace:', filesFromState(state));
    console.log('turn:', transcriptOf(state).at(-1)?.data);
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
await world.close?.();
process.exit(0);
