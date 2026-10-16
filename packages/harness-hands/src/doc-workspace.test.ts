import { blobStreamName, durableSessions, type HostTool, liveStreamName, QUEUE_PREFIX, rawSessions, readBlobs, readJsonLines, type SessionState, sha256Hex } from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import {
  filesFromState,
  legacyWorkspaceTools,
  readWorkspace,
  WorkspaceDoc,
  workspaceManifest,
  workspaceTools,
} from './index.ts';
import { allEvents, type Call, localStore, scripted, toolRecords, until } from './test-harness.ts';

/**
 * The document-backed workspace (doc-workspace.ts): files in the
 * `hw.workspace` manifest and the session's blob stream, each call's change
 * riding on its own outcome.
 */

const stores: Awaited<ReturnType<typeof localStore>>[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll();
});

async function store() {
  const s = await localStore('hw-docws-');
  stores.push(s);
  return s;
}

type Sessions = ReturnType<typeof durableSessions>;

function serve(world: ReturnType<Awaited<ReturnType<typeof localStore>>['open']>, tools: HostTool[] = workspaceTools({ confirmMs: 10 }), extra: Partial<Parameters<typeof durableSessions>[0]> = {}): Sessions {
  const s = durableSessions({ world, harness: scripted(tools), ...extra });
  world.registerHandler(QUEUE_PREFIX, s.handler);
  return s;
}

/** Send each prompt and wait until the session has `count` settled tool calls. */
async function run(s: Sessions, sessionId: string, prompts: (Call | Call[])[]): Promise<SessionState> {
  const before = toolRecords(await s.inspect(sessionId)).length;
  const calls = prompts.reduce((n, p) => n + (Array.isArray(p) ? p.length : 1), 0);
  for (const p of prompts) await s.send(sessionId, JSON.stringify(p));
  let state!: SessionState;
  await until(async () => {
    state = await s.inspect(sessionId);
    if (state.status === 'failed') return true;
    const recs = toolRecords(state);
    return recs.length === before + calls && recs.every((r) => r.status === "completed" || r.status === "failed");
  }, 'tool calls');
  return state;
}

const big = (seed: string, bytes = 10_000) => `${seed}\n${'x'.repeat(bytes - seed.length - 2)}\n`;
const workspaceRevision = (s: SessionState) => s.docs.get(WorkspaceDoc.definition.kind)?.revision ?? 0;

describe('the document-backed workspace', () => {
  it('keeps small files inline and large ones in the blob stream, read back after a cold start', async () => {
    const st = await store();
    const worldA = st.open();
    const a = serve(worldA);
    const { sessionId } = await a.start();
    const content = big('large');
    let state = await run(a, sessionId, [
      { tool: 'write_file', input: { path: 'small.txt', content: 'hello\n' } },
      { tool: 'write_file', input: { path: 'dir/large.txt', content } },
    ]);
    expect(toolRecords(state).map((r) => r.status)).toEqual(['completed', 'completed']);
    // No fs steps: each call's change is an edit of the manifest, on its own outcome.
    expect(state.effectOrder.some((e) => e.name === 'fs')).toBe(false);
    expect(workspaceRevision(state)).toBe(2);
    const hash = await sha256Hex(content);
    expect(workspaceManifest(state)).toEqual([
      { path: '/workspace/dir/large.txt', bytes: 10_000, inline: false, hash },
      { path: '/workspace/small.txt', bytes: 6, inline: true, text: 'hello\n' },
    ]);
    // Synchronous readers have what is in the log; readWorkspace has everything.
    expect(filesFromState(state)).toEqual({ '/workspace/small.txt': 'hello\n' });
    expect(await readWorkspace(worldA, state)).toEqual({ '/workspace/small.txt': 'hello\n', '/workspace/dir/large.txt': content });

    // A fresh process: the workspace is rebuilt from the manifest and the blob stream.
    await st.closeAll();
    const worldB = st.open();
    const b = serve(worldB);
    state = await run(b, sessionId, [
      { tool: 'read_file', input: { path: 'dir/large.txt' } },
      { tool: 'bash', input: { command: 'wc -c < dir/large.txt && cat small.txt' } },
      // The same content again changes nothing: no edit, and no second blob.
      { tool: 'write_file', input: { path: 'dir/large.txt', content } },
    ]);
    const recs = toolRecords(state);
    expect(recs[2]!.output).toBe(content);
    expect(String(recs[3]!.output)).toContain('10000');
    expect(String(recs[3]!.output)).toContain('hello');
    expect(workspaceRevision(state)).toBe(2);
    expect((await readBlobs(worldB, sessionId)).size).toBe(1);
    const lines = (await worldB.streams.getChunks(sessionId, blobStreamName(sessionId), {})).data.length;
    expect(lines).toBe(1);
  });

  it('writes 2 events per mutating call (intent and outcome), where the legacy tools wrote 4', async () => {
    const count = async (tools: HostTool[]) => {
      const st = await store();
      const world = st.open();
      const s = serve(world, tools);
      const { sessionId } = await s.start();
      const state = await run(s, sessionId, [{ tool: 'write_file', input: { path: 'a.txt', content: 'a' } }]);
      expect(toolRecords(state)[0]!.status).toBe('completed');
      // The kernel's writes: an intent (`step_started`, which world-local also lists as `step_created`) and an outcome per step.
      const writes = (await allEvents(world, sessionId)).filter((e) => e.eventType === 'step_started' || e.eventType === 'step_completed');
      return writes.length;
    };
    expect(await count(workspaceTools())).toBe(2);
    expect(await count(legacyWorkspaceTools())).toBe(4);
  });

  it("publishes the manifest's revision on the live stream, not its value (read it when you want it)", async () => {
    const st = await store();
    const world = st.open();
    const s = serve(world);
    const { sessionId } = await s.start();
    await run(s, sessionId, [
      { tool: 'write_file', input: { path: 'a.txt', content: 'a'.repeat(3000) } },
      { tool: 'bash', input: { command: "printf '%03000d' 1 > b.txt" } },
    ]);
    // Live events are written after the outcome they follow commits, and are best effort (a slow write
    // does not hold back the next): wait for the second call's, and take them in revision order.
    const docs = async () => ((await readJsonLines(world, sessionId, liveStreamName(sessionId))) as Record<string, unknown>[]).filter((e) => e.type === 'doc');
    await until(async () => (await docs()).some((e) => e.revision === 2), "the second call's doc event");
    const events = (await docs()).sort((a, b) => Number(a.revision) - Number(b.revision));
    expect(events.map((e) => [e.kind, e.revision, 'value' in e])).toEqual([
      ['hw.workspace', 1, false],
      ['hw.workspace', 2, false],
    ]);
    expect(await s.doc(sessionId, WorkspaceDoc)).toMatchObject({ revision: 2, value: { files: { '/workspace/a.txt': 'a'.repeat(3000) } } });
  });

  it('runs concurrent calls one at a time, and keeps both of their edits', async () => {
    const st = await store();
    const s = serve(st.open());
    const { sessionId } = await s.start();
    const state = await run(s, sessionId, [
      [
        { tool: 'write_file', input: { path: 'a.txt', content: 'one\n' } },
        { tool: 'write_file', input: { path: 'b.txt', content: 'two\n' } },
        { tool: 'bash', input: { command: 'echo three > c.txt' } },
      ],
    ]);
    expect(toolRecords(state).every((r) => r.status === 'completed')).toBe(true);
    expect(filesFromState(state)).toEqual({ '/workspace/a.txt': 'one\n', '/workspace/b.txt': 'two\n', '/workspace/c.txt': 'three\n' });
    expect(workspaceRevision(state)).toBe(3);
  });

  it("syncs in an app's edit of the manifest before the next call", async () => {
    const st = await store();
    const s = serve(st.open());
    const { sessionId } = await s.start();
    await run(s, sessionId, [{ tool: 'write_file', input: { path: 'a.txt', content: 'from a tool\n' } }]);
    await s.updateDoc(sessionId, WorkspaceDoc, (d) => {
      d.files['/workspace/b.txt'] = 'from the app\n';
      delete d.files['/workspace/a.txt'];
    });
    const state = await run(s, sessionId, [{ tool: 'bash', input: { command: 'ls; cat b.txt' } }]);
    const out = String(toolRecords(state).at(-1)!.output);
    expect(out).toContain('from the app');
    expect(out).not.toContain('a.txt');
  });

  it('a failed call changes nothing, in the log or in the workspace the next call sees', async () => {
    const st = await store();
    const failing: HostTool = {
      name: 'scribble',
      description: 'changes the workspace, then fails',
      inputSchema: {},
      replay: 'safe',
      async execute(_input, io) {
        // The workspace call inside it succeeds (its update is made); then the call fails, so none of it lands.
        await workspaceTools()[0]!.execute({ command: 'echo junk > a.txt; echo junk > b.txt' }, io);
        throw new Error('then it failed');
      },
    };
    const s = serve(st.open(), [...workspaceTools(), failing]);
    const { sessionId } = await s.start();
    await run(s, sessionId, [{ tool: 'write_file', input: { path: 'a.txt', content: 'kept\n' } }]);
    let state = await run(s, sessionId, [{ tool: 'scribble', input: {} }]);
    expect(toolRecords(state).at(-1)!.status).toBe('failed');
    expect(workspaceRevision(state)).toBe(1);
    // The same drive's next call: the filesystem is synced back to the log.
    state = await run(s, sessionId, [{ tool: 'bash', input: { command: 'cat a.txt; ls' } }]);
    const out = String(toolRecords(state).at(-1)!.output);
    expect(out).toContain('kept');
    expect(out).not.toContain('junk');
    expect(out).not.toContain('b.txt');
  });

  it('refuses a write that would overflow the manifest, as a tool error, and rolls it back', async () => {
    const st = await store();
    const s = serve(st.open());
    const { sessionId } = await s.start();
    const dir = `deep/${'d'.repeat(100)}`;
    await run(s, sessionId, [{ tool: 'write_file', input: { path: 'keep.txt', content: 'kept\n' } }]);
    let state = await run(s, sessionId, [{ tool: 'bash', input: { command: `mkdir -p ${dir} && for i in $(seq 1 700); do echo $i > ${dir}/f$i; done; echo done` } }]);
    const last = toolRecords(state).at(-1)!;
    expect(last.status).toBe('failed');
    expect(last.error?.message).toMatch(/the workspace is full/);
    expect(workspaceRevision(state)).toBe(1);
    state = await run(s, sessionId, [{ tool: 'list_files', input: {} }]);
    expect(toolRecords(state).at(-1)!.output).toBe('/workspace/keep.txt');
  });

  it('fails the session when a blob the manifest names is missing (the World lost it)', async () => {
    const st = await store();
    const s = serve(st.open());
    const { sessionId } = await s.start();
    await s.updateDoc(sessionId, WorkspaceDoc, (d) => {
      d.files['/workspace/lost.txt'] = { n: 5000, h: 'a'.repeat(64) };
    });
    const state = await run(s, sessionId, [{ tool: 'read_file', input: { path: 'lost.txt' } }]);
    expect(state.status).toBe('failed');
    expect(state.failure?.message).toMatch(/lost\.txt's blob a{64} is missing/);
  });
});

describe('a session the legacy tools wrote', () => {
  it('converts on its first document-backed write, and the legacy tools then refuse to write', async () => {
    const st = await store();
    const legacy = serve(st.open(), legacyWorkspaceTools());
    const { sessionId } = await legacy.start();
    const content = big('legacy large');
    let state = await run(legacy, sessionId, [
      { tool: 'write_file', input: { path: 'a.txt', content: 'from fs steps\n' } },
      { tool: 'write_file', input: { path: 'large.txt', content } },
    ]);
    expect(state.effectOrder.filter((e) => e.name === 'fs')).toHaveLength(2);
    expect(workspaceRevision(state)).toBe(0);
    await st.closeAll();

    // The document-backed tools read the legacy files, and write nothing until something changes.
    const docsWorld = st.open();
    const docs = serve(docsWorld);
    state = await run(docs, sessionId, [{ tool: 'bash', input: { command: 'cat a.txt && wc -c < large.txt' } }]);
    expect(String(toolRecords(state).at(-1)!.output)).toContain('from fs steps');
    expect(String(toolRecords(state).at(-1)!.output)).toContain('10000');
    expect(workspaceRevision(state)).toBe(0);
    state = await run(docs, sessionId, [{ tool: 'write_file', input: { path: 'b.txt', content: 'from a document\n' } }]);
    expect(workspaceRevision(state)).toBe(1);
    // The manifest is the whole workspace now: the legacy files, the large one as a blob.
    expect(workspaceManifest(state).map((f) => [f.path, f.inline])).toEqual([
      ['/workspace/a.txt', true],
      ['/workspace/b.txt', true],
      ['/workspace/large.txt', false],
    ]);
    expect(await readWorkspace(docsWorld, state)).toEqual({
      '/workspace/a.txt': 'from fs steps\n',
      '/workspace/b.txt': 'from a document\n',
      '/workspace/large.txt': content,
    });
    await st.closeAll();

    // The legacy tools read a document-backed session, and refuse to write into it.
    const again = serve(st.open(), legacyWorkspaceTools());
    state = await run(again, sessionId, [
      { tool: 'read_file', input: { path: 'large.txt' } },
      { tool: 'write_file', input: { path: 'c.txt', content: 'diverging' } },
    ]);
    const [read, write] = toolRecords(state).slice(-2);
    expect(read!.output).toBe(content);
    expect(write!.status).toBe('failed');
    expect(write!.error?.message).toMatch(/document-backed/);
    expect(Object.keys(filesFromState(state)).sort()).toEqual(['/workspace/a.txt', '/workspace/b.txt']);
  });
});

describe('durability off (rawSessions: no World)', () => {
  it('keeps the legacy in-memory format, with no size limit', async () => {
    const raw = rawSessions({ harness: scripted(workspaceTools()) });
    const { sessionId } = await raw.start();
    const content = big('raw', 80_000);
    await raw.send(sessionId, JSON.stringify({ tool: 'write_file', input: { path: 'big.txt', content } }));
    await raw.send(sessionId, JSON.stringify({ tool: 'bash', input: { command: 'wc -c < big.txt' } }));
    await raw.idle(sessionId);
    const state = await raw.inspect(sessionId);
    expect(toolRecords(state).map((r) => r.status)).toEqual(['completed', 'completed']);
    expect(String(toolRecords(state)[1]!.output)).toContain('80000');
    expect(filesFromState(state)).toEqual({ '/workspace/big.txt': content });
    expect(workspaceRevision(state)).toBe(0);
  });
});
