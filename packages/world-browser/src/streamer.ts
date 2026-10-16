import type { Streamer } from '@workflow/world';
import { req, STORES, transact } from './idb.ts';
import type { Bus } from './bus.ts';

const encoder = new TextEncoder();
const toBytes = (chunk: string | Uint8Array) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk);

/** Streams as IndexedDB rows, tailed live through the in-tab/cross-tab bus. */
export function createStreamer(db: IDBDatabase, bus: Bus): Streamer {
  async function append(runId: string, name: string, chunks: (string | Uint8Array)[], close = false) {
    await transact(db, [STORES.streams, STORES.chunks], 'readwrite', async (tx) => {
      const streams = tx.objectStore(STORES.streams);
      const meta = (await req(streams.get(name))) ?? { name, runId, count: 0, done: false };
      for (const chunk of chunks) {
        tx.objectStore(STORES.chunks).put({ name, index: meta.count++, data: toBytes(chunk) });
      }
      if (close) meta.done = true;
      streams.put(meta);
    });
    bus.emit({ type: 'stream', name });
  }

  async function read(name: string, from: number) {
    const tx = db.transaction([STORES.streams, STORES.chunks]);
    const meta = await req(tx.objectStore(STORES.streams).get(name));
    const rows = await req(
      tx.objectStore(STORES.chunks).getAll(IDBKeyRange.bound([name, from], [name, Number.MAX_SAFE_INTEGER]))
    );
    return { meta, rows: rows as { index: number; data: Uint8Array }[] };
  }

  return {
    streams: {
      write: (runId, name, chunk) => append(runId, name, [chunk]),
      writeMulti: (runId, name, chunks) => append(runId, name, chunks),
      close: (runId, name) => append(runId, name, [], true),
      async get(_runId, name, startIndex = 0) {
        let next = startIndex;
        let unsubscribe = () => {};
        return new ReadableStream<Uint8Array>({
          async start(controller) {
            if (next < 0) {
              const { meta } = await read(name, 0);
              next = Math.max(0, (meta?.count ?? 0) + next);
            }
            let pulling = false;
            let again = false;
            const pull = async () => {
              if (pulling) {
                again = true;
                return;
              }
              pulling = true;
              do {
                again = false;
                const { meta, rows } = await read(name, next);
                for (const row of rows) controller.enqueue(row.data);
                next += rows.length;
                if (meta?.done && next >= meta.count) {
                  unsubscribe();
                  controller.close();
                  return;
                }
              } while (again);
              pulling = false;
            };
            unsubscribe = bus.on((m) => {
              if (m.type === 'stream' && m.name === name) void pull();
            });
            await pull();
          },
          cancel() {
            unsubscribe();
          },
        });
      },
      async list(runId) {
        const rows = await req(db.transaction(STORES.streams).objectStore(STORES.streams).index('runId').getAll(runId));
        return rows.map((r: { name: string }) => r.name);
      },
      async getChunks(_runId, name, options = {}) {
        const from = options.cursor ? Number(options.cursor) : 0;
        const limit = options.limit ?? 100;
        const { meta, rows } = await read(name, from);
        if (!meta) throw Object.assign(new Error(`Stream "${name}" not found`), { status: 404 });
        const data = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        return {
          data,
          cursor: hasMore ? String(from + data.length) : null,
          hasMore,
          done: !!meta.done && from + data.length >= meta.count,
        };
      },
      async getInfo(_runId, name) {
        const { meta } = await read(name, Number.MAX_SAFE_INTEGER);
        return { tailIndex: (meta?.count ?? 0) - 1, done: !!meta?.done };
      },
    },
  };
}
