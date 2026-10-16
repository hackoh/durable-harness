/**
 * A durable OpenCode v2 turn on world-local, from the command line:
 *
 *   pnpm --filter harness-world-opencode example "Write a haiku to haiku.txt"
 *
 * The credential is the AI Gateway's: `AI_GATEWAY_API_KEY`, or a Vercel
 * OIDC token (`VERCEL_OIDC_TOKEN`, from `vercel env pull`). The run's log is
 * in `.workflow-data`. `--resume <sessionId> [message]` opens the session
 * again: with a message, the next turn; without one, after a kill -9
 * mid-turn, the start re-enqueues the run and the cut-off turn finishes from
 * the log.
 */
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX } from 'harness-world';
import { filesFromState } from 'harness-world-hands';
import { workspaceRuntime } from 'harness-world-hands/runtime';
import { opencodeHarness } from 'harness-world-opencode';

const args = process.argv.slice(2);
const resumeAt = args.indexOf('--resume');
const resume = resumeAt >= 0 ? args.splice(resumeAt, 2)[1] : undefined;
const prompt = args.join(' ') || (resume ? '' : 'Write a haiku about durable logs to haiku.txt, then read it back to me.');

const world = createWorld({ dataDir: '.workflow-data', recoverActiveRuns: true });
const sessions = durableSessions({
  world,
  // OpenCode's own tools on a virtual workspace: its files in the run's log.
  harness: opencodeHarness({ workspace: { kind: 'virtual', runtime: workspaceRuntime() }, model: process.env.MODEL ?? 'anthropic/claude-haiku-4.5' }),
});
world.registerHandler(QUEUE_PREFIX, sessions.handler);
await world.start?.();

const sessionId = resume ?? (await sessions.start()).sessionId;
console.error(`session ${sessionId}`);
const done = new AbortController();
const from = await sessions.liveEnd(sessionId);
const live = (async () => {
  for await (const ev of sessions.live(sessionId, { startIndex: from, signal: done.signal }) as AsyncIterable<any>) {
    if (ev?.type === 'text') process.stdout.write(ev.delta);
    else if (ev?.type === 'tool_start') console.error(`\n[${ev.name} ${JSON.stringify(ev.args)}]`);
    else if (ev?.type === 'idle') break;
  }
})();
if (prompt) await sessions.send(sessionId, prompt);
await live;
done.abort();

const state = await sessions.inspect(sessionId);
console.error('\nworkspace:', filesFromState(state));
await world.close?.();
process.exit(0);
