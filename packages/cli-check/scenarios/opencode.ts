import type { DriveContext } from 'harness-world';
import { workspaceTools } from 'harness-world-hands';
import { type FromHost, type HostConnection, type HostInit, type OpenCodeEvent, opencodeHarness, pipePair, type ToHost } from 'harness-world-opencode';
import type { Scenario } from '../src/scenario.ts';
import { newHost, processBasic } from './process.ts';

/**
 * OpenCode (harness-world-opencode), the drive's side, against a scripted
 * OpenCode host (the same stand-in its own tests use): the host commits the
 * events OpenCode would, asks the model barrier, and runs a tool call
 * through the drive. No OpenCode, no model.
 */

/** A scripted OpenCode host, one per drive. */
export class ScriptedHost {
  seq: number;
  readonly inbound: ToHost[] = [];
  ended = false;
  private next = 0;
  private wakers: (() => void)[] = [];
  readonly conn: HostConnection;
  private readonly out: (m: FromHost) => void;
  constructor(
    readonly ctx: DriveContext,
    readonly init: HostInit
  ) {
    this.seq = init.events.at(-1)?.seq ?? -1;
    const { left, right } = pipePair<FromHost, ToHost>();
    this.out = (m) => right.send(m);
    void (async () => {
      for await (const m of right.messages) {
        this.inbound.push(m);
        this.wake();
      }
      this.ended = true;
      this.wake();
    })();
    this.conn = {
      send: (m) => left.send(m),
      messages: left.messages,
      close: async () => {
        left.send({ type: 'close' });
        right.close();
      },
      kill: () => {
        left.close();
        right.close();
      },
      tail: () => '',
      exited: Promise.resolve(),
    };
  }
  private wake() {
    for (const w of this.wakers.splice(0)) w();
  }
  async take<T extends ToHost['type']>(type: T): Promise<Extract<ToHost, { type: T }>> {
    for (;;) {
      const at = this.inbound.findIndex((m) => m.type === type);
      if (at >= 0) return this.inbound.splice(at, 1)[0] as Extract<ToHost, { type: T }>;
      if (this.ended) throw new Error(`the drive closed before sending ${type}`);
      await new Promise<void>((r) => this.wakers.push(r));
    }
  }
  commit(...events: [string, Record<string, unknown>?][]) {
    const out: OpenCodeEvent[] = events.map(([type, data]) => ({
      id: `evt_${this.seq + 1}`,
      seq: ++this.seq,
      created: Date.now(),
      type: `${type}.1`,
      data: { sessionID: this.init.sessionId, ...data },
    }));
    this.out({ type: 'events', events: out, blobs: [] });
  }
  send(m: FromHost) {
    this.out(m);
  }
  async request(m: { type: 'barrier'; kind: string } | { type: 'tool'; callId: string; name: string; input: unknown }) {
    const id = ++this.next + 1000;
    this.out({ ...m, id } as FromHost);
    for (;;) {
      const at = this.inbound.findIndex((x) => x.type === 'reply' && (x as { id?: number }).id === id);
      if (at >= 0) return this.inbound.splice(at, 1)[0] as Extract<ToHost, { type: 'reply' }>;
      if (this.ended) throw new Error('the drive closed before replying');
      await new Promise<void>((r) => this.wakers.push(r));
    }
  }
}

/** A new session's `session.created`, then ready. */
export function ready(h: ScriptedHost) {
  if (h.init.events.length === 0) h.commit(['session.created', { location: { directory: h.init.directory }, projectID: 'p' }]);
  h.send({ type: 'ready', seq: h.seq });
}

/** Admit the next prompt and start its execution, as OpenCode does. */
export async function admit(h: ScriptedHost) {
  const p = await h.take('prompt');
  h.send({ type: 'reply', id: p.id, ok: true });
  h.commit(
    ['session.inbox.enqueued', { inboxID: p.messageId, item: { type: 'user', payload: { text: p.text } } }],
    ['session.execution.started'],
    ['session.inbox.delivered', { inboxID: p.messageId }]
  );
  return p;
}

/** Turn 1: one `write_file` call through the drive, then an answer. */
async function toolTurn(h: ScriptedHost) {
  ready(h);
  await admit(h);
  await h.request({ type: 'barrier', kind: 'primary' });
  const input = { path: 'notes.txt', content: 'hi' };
  h.commit(['session.step.started'], ['session.text.ended', { text: 'Writing it.' }], ['session.tool.input.started', { id: 'toolu_1', name: 'write_file' }]);
  h.commit(['session.tool.called', { id: 'toolu_1', input }]);
  h.send({ type: 'text', delta: 'Writing it.' });
  const r = await h.request({ type: 'tool', callId: 'toolu_1', name: 'write_file', input });
  h.commit(['session.tool.success', { id: 'toolu_1', content: [{ type: 'text', text: r.ok ? r.text : '' }] }], ['session.step.ended']);
  await h.request({ type: 'barrier', kind: 'primary' });
  h.commit(['session.step.started'], ['session.text.ended', { text: 'Done.' }], ['session.step.ended'], ['session.execution.succeeded']);
  await h.take('close');
}

/** Turn 2: an answer, no tools. */
async function textTurn(h: ScriptedHost) {
  ready(h);
  const p = await admit(h);
  await h.request({ type: 'barrier', kind: 'primary' });
  h.commit(['session.step.started'], ['session.text.ended', { text: `echo: ${p.text}` }], ['session.step.ended'], ['session.execution.succeeded']);
  await h.take('close');
}

export const opencode: Scenario = {
  name: 'opencode',
  title: 'OpenCode (harness-world-opencode, scripted host)',
  blocking: true,
  sessions: [
    {
      label: 'basic',
      async run(storage) {
        const host = await newHost('opencode');
        const scripts = [toolTurn, textTurn];
        const errors: unknown[] = [];
        let drives = 0;
        const harness = opencodeHarness({
          // The bridged tools only (no workspace: tool-less): the scenario's scripted turns call them.
          tools: workspaceTools({ confirmMs: 3000 }),
          root: host.root,
          connect: async (ctx, init) => {
            const h = new ScriptedHost(ctx, init);
            const script = scripts[drives++];
            if (!script) throw new Error(`opencode scenario: no script for drive ${drives}`);
            void script(h).catch((err) => errors.push(err));
            return h.conn;
          },
        });
        const run = await processBasic(storage, harness, { name: 'opencode', host });
        if (errors.length) throw new Error(`the scripted OpenCode host failed: ${String(errors[0])}`);
        return run;
      },
    },
  ],
};
