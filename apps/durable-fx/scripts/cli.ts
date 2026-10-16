/**
 * The same agent as the web app (lib/agent.ts), in this process: off Vercel,
 * libfx keeps its sessions in local files, so no server is needed. Kill it
 * mid-turn (kill -9 works), then run it with the session id it printed and
 * the turn continues from its last record.
 *
 *   pnpm cli "..."               # a new session, your question
 *   pnpm cli <sessionId>         # continue the turn a killed run left open
 *   pnpm cli <sessionId> "..."   # a follow-up in the same session
 *
 * The AI Gateway credential is AI_GATEWAY_API_KEY.
 */
import { agent } from '../lib/agent.ts';
import { LEDGER, ledgerLines } from '../lib/tools.ts';

const [first, second] = process.argv.slice(2);
const sessionId = first?.startsWith('wrun_') ? first : undefined;
const question = sessionId ? second : (first ?? 'Explain closures in two sentences.');

const session = agent.session(sessionId);
const turn = question ? session.prompt(question) : session.resume();
console.error(`session ${(await turn.accepted).sessionId}`);
for await (const event of turn) {
  if (event.type === 'text_delta') process.stdout.write(event.delta);
  else if (event.type === 'tool_start') process.stdout.write(`\n[${event.name}]\n`);
}
const result = await turn.result;
process.stdout.write('\n');
console.error(`${result.stopReason}; ${LEDGER}: ${(await ledgerLines()).length} charge(s)`);
await agent.close();
