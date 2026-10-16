/**
 * One drive of a session, in a process of its own, on a world-local data
 * directory another process drives the same session on
 * (in-band-fence-processes.test.ts). Both drives wait for each other at the
 * start of the turn, so both decide from the same log before either writes.
 *
 *   node --import tsx fence-process.ts <dataDir> <sessionId> <name> <barrierDir>
 *
 * Prints one JSON line: what it ran, whether it reached the turn, and how
 * many of its writes the World refused.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld } from '@workflow/world-local';
import { deliver, type DriverOptions, type Harness, vercelAnchors } from '../index.ts';

const [dataDir, sessionId, name, barrier] = process.argv.slice(2) as [string, string, string, string];
const both = () => readdirSync(barrier).filter((f) => f.startsWith('turn-')).length >= 2;
const world = createWorld({ dataDir, recoverActiveRuns: false });
const calls = { model: 0, tool: 0 };
let reached = false;
const harness: Harness = {
  name: 'turns',
  async drive(ctx) {
    for (const sub of ctx.pending()) {
      reached = true;
      writeFileSync(join(barrier, `turn-${name}`), '');
      for (const start = Date.now(); !both() && Date.now() - start < 15_000; ) await new Promise((r) => setTimeout(r, 10));
      await ctx.effect(`model:${sub.id}`, { name: 'model', replay: 'safe', input: sub.text, placed: [sub.id] }, async () => (calls.model++, `plan from ${name}`));
      await ctx.effect(`tool:${sub.id}`, { name: 'tool.slow', replay: 'never', input: sub.text }, async () => (calls.tool++, `ran in ${name}`));
    }
  },
};
// Both processes are up before either reads the log.
writeFileSync(join(barrier, `up-${name}`), '');
for (const start = Date.now(); !(existsSync(join(barrier, 'up-a')) && existsSync(join(barrier, 'up-b'))) && Date.now() - start < 15_000; ) await new Promise((r) => setTimeout(r, 10));
const logs: string[] = [];
const options: DriverOptions = { world, harness, anchors: vercelAnchors(), contendedDelaySeconds: 1, log: (m) => logs.push(m) };
await deliver(options, sessionId, { anchor: { k: 'msg', m: `msg_${name}` } });
console.log(JSON.stringify({ name, calls, reached, refused: logs.filter((m) => m === 'in-band fence: a write was refused').length }));
await world.close?.();
