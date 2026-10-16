import { harnessOf, type RawSessions, rawSessions } from 'harness-world';
import type { DemoClient, EventPage } from 'harness-world-demo-ui';
import { sessionView } from 'harness-world-demo-ui/view';
import { hasJspi, tabHarnesses } from './tab-harnesses.ts';

/**
 * Durability off, in this tab: the same Pi and fx harnesses as This Tab,
 * driven with no World at all (harness-world `rawSessions`). Nothing is
 * written anywhere; the session lives in this page's memory and is gone on
 * reload. The Event Log lists what a durable session would have written.
 */

let shared: RawSessions | undefined;
/** One raw runner per page, shared by the page's Off mode and the benchmark. */
export function tabRaw(): RawSessions {
  shared ??= rawSessions({ harness: tabHarnesses(), log: (m, f) => console.log(`[raw] ${m}`, f ?? '') });
  return shared;
}

export async function createClient(): Promise<DemoClient> {
  const raw = tabRaw();
  return {
    mode: 'tab',
    durability: 'off',
    worldName: 'browser',
    chaosEnabled: false,
    fxAvailable: hasJspi(),
    signalsReady: true,
    async list() {
      return raw
        .list()
        .map((s) => ({ id: s.id, harness: harnessOf(s.state.workflowName) ?? s.harness, status: s.state.status, createdAt: s.createdAt }))
        .reverse();
    },
    start: async (harness, prompt) => (await raw.start({ harness, ...(prompt ? { prompt } : {}) })).sessionId,
    send: async (id, text, kind) => {
      await raw.send(id, text, kind);
    },
    inspect: async (id) => sessionView(id, await raw.inspect(id)),
    async events(id, cursor): Promise<EventPage> {
      const all = raw.events(id);
      const from = cursor ? all.findIndex((e) => e.eventId === cursor) + 1 : 0;
      const events = all.slice(from);
      return { events, ...(all.length ? { cursor: all.at(-1)!.eventId } : {}) };
    },
    event: async () => ({ note: 'Durability is off: nothing was written, so there is no payload to read.' }),
    live(id, onEvent, onReady) {
      const off = raw.subscribe(id, onEvent);
      onReady?.();
      return off;
    },
    chaos: async () => {
      throw new Error('Durability is off: there is nothing to recover a crash from.');
    },
  };
}
