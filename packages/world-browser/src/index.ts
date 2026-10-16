import type { World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createBus } from './bus.ts';
import { openDatabase, STORES, transact } from './idb.ts';
import { createQueue } from './queue.ts';
import { createStorage } from './storage.ts';
import { createStreamer } from './streamer.ts';

export interface BrowserWorldOptions {
  /** IndexedDB database name. One database is one World. */
  name?: string;
  /** Inject an IndexedDB implementation (fake-indexeddb in tests). */
  indexedDB?: IDBFactory;
  /** Concurrent queue deliveries in the leader tab. */
  concurrency?: number;
}

export type BrowserWorld = World & {
  close(): Promise<void>;
  /** Delete every run, event, stream and queued message. */
  clear(): Promise<void>;
};

/**
 * A Workflow World that lives in the browser.
 *
 * - Storage: IndexedDB. Each event is one transaction, and IndexedDB
 *   serializes overlapping transactions across tabs, so slot allocation is
 *   atomic without a server.
 * - Queue: durable rows in IndexedDB, consumed by whichever tab holds a
 *   Web Lock; a message is removed only after its handler returns, so
 *   closing the tab mid-turn just leaves it for the next tab.
 * - Streams: IndexedDB rows, tailed through BroadcastChannel hints.
 */
export async function createWorld(options: BrowserWorldOptions = {}): Promise<BrowserWorld> {
  const name = options.name ?? 'workflow-world';
  const db = await openDatabase(name, options.indexedDB ?? indexedDB);
  const bus = createBus(`world-browser:${name}`);
  const queue = createQueue(db, bus, `world-browser:${name}:queue`, options.concurrency);
  const storage = createStorage(db, (runId) => bus.emit({ type: 'event', runId }));
  const streamer = createStreamer(db, bus);

  return {
    specVersion: SPEC_VERSION_CURRENT,
    ...storage,
    ...streamer,
    getDeploymentId: queue.getDeploymentId,
    queue: queue.queue,
    createQueueHandler: queue.createQueueHandler,
    async start() {
      queue.start();
    },
    async close() {
      queue.stop();
      bus.close();
      db.close();
    },
    async clear() {
      await transact(db, Object.values(STORES), 'readwrite', async (tx) => {
        for (const store of Object.values(STORES)) tx.objectStore(store).clear();
      });
    },
  } as BrowserWorld;
}
