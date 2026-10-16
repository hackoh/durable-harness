/**
 * The victim process of sandbox.test.ts's crash case: Pi on world-local at
 * `dataDir`, its coding tools on the sandbox stand-in (test/stand-in.ts),
 * whose session sandbox is named `name` on an existing Drive (`driveDir`,
 * `driveId`). The scripted model runs one command that is still running when
 * the test SIGKILLs this process (it writes `shell.pid` and `a.txt` first).
 * Prints `{"sessionId": …}`, then `{"type": "vm", "relayPid": …, "relayDir": …}`
 * once its VM is up (the test tears that down), and runs until killed.
 *
 *   node --import tsx test/sandbox-child.ts <dataDir> <name> <driveDir> <driveId>
 */
import { dirname } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createWorld } from '@workflow/world-local';
import { durableSessions, QUEUE_PREFIX } from 'harness-world';
import { piHarness } from '../src/index.ts';
import { seededStandIn } from './stand-in.ts';

const [dataDir, name, driveDir, driveId] = process.argv.slice(2);
if (!dataDir || !name || !driveDir || !driveId) throw new Error('usage: sandbox-child.ts <dataDir> <name> <driveDir> <driveId>');
const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);

const { api, tools } = seededStandIn({ name, dir: driveDir, driveId });
const timer = setInterval(() => {
  const relay = api.relayOf(name);
  if (!relay) return;
  clearInterval(timer);
  out({ type: 'vm', relayPid: relay.child().pid, relayDir: dirname(relay.configPath) });
}, 50);

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage(fauxToolCall('bash', { command: 'echo $$ > shell.pid; echo one > a.txt; sleep 30; echo two >> a.txt' }), { stopReason: 'toolUse' })]);

const world = createWorld({ dataDir, recoverActiveRuns: false });
const sessions = durableSessions({ world, harness: piHarness({ model: faux.getModel(), streamFn: models.streamSimple.bind(models), tools }) });
world.registerHandler(QUEUE_PREFIX, sessions.handler);
await world.start?.();
const { sessionId } = await sessions.start({ prompt: 'Make a.txt.' });
out({ sessionId });
await new Promise(() => {}); // until killed
