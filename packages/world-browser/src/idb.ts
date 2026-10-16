/** A minimal promise wrapper over IndexedDB. No dependencies. */

export const STORES = {
  runs: 'runs',
  events: 'events',
  steps: 'steps',
  hooks: 'hooks',
  waits: 'waits',
  chunks: 'chunks',
  streams: 'streams',
  queue: 'queue',
} as const;

export function openDatabase(name: string, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(STORES.runs, { keyPath: 'runId' });
      db.createObjectStore(STORES.events, { keyPath: ['runId', 'slot'] });
      const steps = db.createObjectStore(STORES.steps, { keyPath: ['runId', 'stepId'] });
      steps.createIndex('runId', 'runId');
      const hooks = db.createObjectStore(STORES.hooks, { keyPath: 'hookId' });
      hooks.createIndex('token', 'token', { unique: true });
      hooks.createIndex('runId', 'runId');
      db.createObjectStore(STORES.waits, { keyPath: ['runId', 'waitId'] });
      db.createObjectStore(STORES.chunks, { keyPath: ['name', 'index'] });
      db.createObjectStore(STORES.streams, { keyPath: 'name' }).createIndex('runId', 'runId');
      db.createObjectStore(STORES.queue, { keyPath: 'messageId' }).createIndex('idempotencyKey', 'idempotencyKey', { unique: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run `fn` in one transaction and resolve when it commits. `fn` may only
 * await IndexedDB requests made on `tx`: awaiting anything else lets the
 * transaction auto-commit early.
 */
export function transact<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    let failed: unknown;
    fn(tx).then(
      (value) => {
        result = value;
      },
      (err) => {
        failed = err;
        try {
          tx.abort();
        } catch {}
      }
    );
    tx.oncomplete = () => (failed ? reject(failed) : resolve(result));
    tx.onabort = () => reject(failed ?? tx.error ?? new Error('transaction aborted'));
    tx.onerror = () => {};
  });
}
