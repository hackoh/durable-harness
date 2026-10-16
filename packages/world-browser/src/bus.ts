export type BusMessage =
  | { type: 'stream'; name: string }
  | { type: 'queued' }
  | { type: 'event'; runId: string };

export interface Bus {
  emit(message: BusMessage): void;
  on(listener: (message: BusMessage) => void): () => void;
  close(): void;
}

/**
 * Notifications within a tab and across tabs of the same origin. Carries
 * only "something changed" hints; the data itself is always re-read from
 * IndexedDB, so a lost message costs latency, never correctness.
 */
export function createBus(name: string): Bus {
  const listeners = new Set<(message: BusMessage) => void>();
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(name);
  if (channel) {
    channel.onmessage = (e) => {
      for (const l of listeners) l(e.data as BusMessage);
    };
  }
  return {
    emit(message) {
      for (const l of listeners) l(message);
      channel?.postMessage(message);
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      channel?.close();
    },
  };
}
