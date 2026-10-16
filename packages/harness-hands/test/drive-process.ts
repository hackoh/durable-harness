/**
 * One delivery of a session, in a process of its own, on a world-local data
 * directory (just-bash-env.test.ts: an in-memory workspace is empty in a new
 * process). The session's prompts are lists of calls on the in-memory
 * workspace tools; the harness yields after the first call it runs.
 *
 *   node --import tsx drive-process.ts <dataDir> <sessionId>
 *
 * Prints one JSON line: where the shell ran.
 */
import { createWorld } from '@workflow/world-local';
import { type DriveContext, deliver, vercelAnchors } from 'harness-world';
import { machineIsolation } from '../src/isolation.ts';
import { yieldingAfterFirst } from '../src/test-harness.ts';
import { docWorkspaceTools } from '../src/tools.ts';

type World = DriveContext['world'];

const [dataDir, sessionId] = process.argv.slice(2) as [string, string];
const base = createWorld({ dataDir, recoverActiveRuns: false });
// Only these deliveries drive the session: a wake it sends goes nowhere.
const world = new Proxy(base, { get: (t, k) => (k === 'queue' ? async () => ({ messageId: 'msg_dropped' }) : (t as never)[k]) }) as unknown as World;
const harness = yieldingAfterFirst(docWorkspaceTools({ kind: 'virtual', durable: false }));
await deliver({ world, harness, anchors: vercelAnchors(), contendedDelaySeconds: 1 }, sessionId, { anchor: { k: 'msg', m: `msg_${process.pid}_${Date.now()}` } });
console.log(JSON.stringify({ isolation: await machineIsolation(), pid: process.pid }));
await base.close?.();
