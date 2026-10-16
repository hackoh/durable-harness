/**
 * The victim process of sandbox.test.ts's crash case: libfx's own agent on
 * world-local at `dataDir` (`libfx/durable-world`), `fxTools(sandbox())` on
 * the sandbox stand-in (test/stand-in.ts), whose session sandbox is named
 * `name` on an existing Drive (`driveDir`, `driveId`). The scripted model
 * runs one command that is still running when the test SIGKILLs this process
 * (it writes `shell.pid` and `a.txt` first). Prints `{"sessionId": …}`, then
 * `{"type": "vm", "relayPid": …, "relayDir": …}` once its VM is up (the test
 * tears that down), and runs until killed.
 *
 *   node --import tsx test/sandbox-child.ts <dataDir> <name> <driveDir> <driveId>
 */
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { createWorld } from '@workflow/world-local';
import { createFxAgent } from 'libfx';
import { world as fxWorld } from 'libfx/durable-world';
import { agentTools, seededStandIn } from './stand-in.ts';

const [dataDir, name, driveDir, driveId] = process.argv.slice(2);
if (!dataDir || !name || !driveDir || !driveId) throw new Error('usage: sandbox-child.ts <dataDir> <name> <driveDir> <driveId>');
const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);

const { api, acquire } = seededStandIn({ name, dir: driveDir, driveId });
const timer = setInterval(() => {
  const relay = api.relayOf(name);
  if (!relay) return;
  clearInterval(timer);
  out({ type: 'vm', relayPid: relay.child().pid, relayDir: dirname(relay.configPath) });
}, 50);

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const command = 'echo $$ > shell.pid; echo one >> a.txt; sleep 30; echo two >> a.txt';
const script = [
  [
    { type: 'tool-call', toolCallId: 'call_crash', toolName: 'shell', input: JSON.stringify({ request: { action: 'run', command } }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
  ],
];
const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
  if ((init?.method ?? 'GET') === 'GET') return Response.json({ object: 'list', data: [] });
  const next = script.shift();
  if (!next) throw new Error('unexpected model request');
  return new Response([...next.map((p) => `data: ${JSON.stringify(p)}`), 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
};

const w = createWorld({ dataDir, recoverActiveRuns: false });
const host = hostname();
const durability = fxWorld(w, { name: 'local', livenessKnown: true, queueDurable: false, pollMs: 50, holderInfo: () => ({ pid: process.pid, host }), alive: (lease) => (lease.host === host && lease.pid === process.pid ? true : null) });
const agent = createFxAgent({ durability, apiKey: 'test', model: 'test/model', fetch, modelCatalog: [], tools: agentTools(acquire, w) as never });
const turn = agent.session().prompt('Make a.txt.');
out({ sessionId: (await turn.accepted).sessionId });
await new Promise(() => {}); // until killed
