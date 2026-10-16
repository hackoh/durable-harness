import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import * as harnessWorld from './index.ts';
import { type DriveContext, deliver, durableSessions, type Harness, QUEUE_PREFIX } from './index.ts';

/**
 * Nothing in this package judges liveness by silence: a drive
 * writes what it does and nothing on a timer, the queue's lease is the only
 * backstop, and the streams the heartbeat and the backstop wrote are gone.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let world: LocalWorld | undefined;
afterEach(async () => {
  await world?.close?.();
  world = undefined;
});

/** Count every World write (`events.create`, `writeToStream*`, `queue`) made while `during` is true. */
function counting(base: World) {
  const writes: string[] = [];
  let during = false;
  const wrap = <T extends object>(target: T, prefix: string, names: string[]): T =>
    new Proxy(target, {
      get(t, key) {
        const value = (t as Record<string | symbol, unknown>)[key];
        if (typeof value === 'function' && names.includes(String(key))) {
          return (...args: unknown[]) => {
            if (during) writes.push(`${prefix}${String(key)}${typeof args[1] === 'string' ? `:${args[1]}` : ''}`);
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (typeof value === 'function') return (value as (...a: unknown[]) => unknown).bind(t);
        if (key === 'events' && value && typeof value === 'object') return wrap(value as object, 'events.', ['create']);
        return value;
      },
    });
  const world = wrap(base, '', ['queue', 'writeToStream', 'writeToStreamMulti', 'closeStream']);
  return {
    world,
    writes,
    start() {
      during = true;
    },
    stop() {
      during = false;
    },
  };
}

describe('no heartbeats', () => {
  it('a drive writes nothing while a long tool runs: no beats, no lease renewals, no messages', async () => {
    world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-nohb-')), recoverActiveRuns: false });
    const watch = counting(world);
    let entered!: () => void;
    const inTool = new Promise<void>((r) => (entered = r));
    const harness: Harness = {
      name: 'long',
      async drive(ctx: DriveContext) {
        for (const sub of ctx.pending()) {
          await ctx.effect(`tool:${sub.id}`, { name: 'tool.long', replay: 'never', input: sub.text, placed: [sub.id] }, async () => {
            entered();
            await sleep(1500);
            return 'done';
          });
        }
      },
    };
    const sessions = durableSessions({ world, harness });
    const { sessionId } = await sessions.start({});
    // Its wake has nowhere to go: this test drives the session itself.
    world.registerHandler(QUEUE_PREFIX, async () => Response.json({}));
    await sessions.send(sessionId, 'go');
    const drive = deliver({ world: watch.world, harness }, sessionId);
    await inTool;
    // Let the intent's own writes settle (the ack, the live marks).
    await sleep(200);
    watch.start();
    await sleep(1200);
    watch.stop();
    await drive;
    expect(watch.writes).toEqual([]);
    expect((await sessions.inspect(sessionId)).effectOrder[0]).toMatchObject({ status: 'completed', output: 'done' });
  });

  it('the package exports no heartbeat, no backstop, and no liveness stream names', async () => {
    const names = Object.keys(harnessWorld);
    expect(names.filter((n) => /heartbeat|backstop|takeoverStream|quiet/i.test(n))).toEqual([]);
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> };
    expect(Object.keys(pkg.exports)).not.toContain('./heartbeat');
    const streams = await import('./streams.ts');
    expect(Object.keys(streams).filter((n) => /heartbeat|backstop|takeover/i.test(n))).toEqual([]);
  });

  it('DriverOptions takes no lease or beat settings', async () => {
    const source = await readFile(new URL('./driver.ts', import.meta.url), 'utf8');
    const options = source.slice(source.indexOf('export interface DriverOptions'), source.indexOf('\n}\n', source.indexOf('export interface DriverOptions')));
    for (const gone of ['leaseMs', 'quietMs', 'heartbeatMs', 'heartbeatTimer']) expect(options).not.toContain(`${gone}?:`);
  });
});
