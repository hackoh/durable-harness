import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DriveContext, durableSessions, type Harness } from 'harness-world';
import { journalBatches, journalRecords, NativeJournal } from 'harness-world-process';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_STREAM, JournalSessionStore, type TranscriptLine, toolUseIds } from '../src/store.ts';

/**
 * The transcript mirror: the SDK's `sessionStore` over the drive's journal.
 * Entries go in as the SDK hands them over, and come back out, on another
 * drive, deep-equal and in order, whatever the machine (`projectKey`).
 */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/turn.json', import.meta.url), 'utf8')) as {
  appends: { key: { projectKey: string; sessionId: string }; entries: TranscriptLine[] }[];
};
const allEntries = fixture.appends.flatMap((a) => a.entries);
const key = fixture.appends[0]!.key;

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

/** Drive a session once with `body`, after placing its prompt. */
async function drive(body: (ctx: DriveContext) => Promise<void>, at?: { world: LocalWorld; sessionId: string }) {
  const world = at?.world ?? createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hwcc-store-')), recoverActiveRuns: false });
  if (!at) worlds.push(world);
  const harness: Harness = {
    name: 'claude-store',
    async drive(ctx) {
      const pending = ctx.pending();
      if (!pending.length) return;
      await ctx.effect(`place:${pending[0]!.id}`, { name: 'place', replay: 'safe', input: null, placed: pending.map((p) => p.id) }, async () => true);
      await body(ctx);
    },
  };
  const sessions = durableSessions({ world, harness });
  const sessionId = at?.sessionId ?? (await sessions.start()).sessionId;
  await sessions.send(sessionId, 'go', 'prompt', { wake: 'backstop' });
  await sessions.drive(sessionId);
  return { world, sessionId, state: await sessions.inspect(sessionId) };
}

const open = async (ctx: DriveContext, coalesceMs = 0) => {
  const journal = new NativeJournal(ctx);
  return { journal, store: new JournalSessionStore(journal, { records: await journal.read(), coalesceMs }) };
};

describe('JournalSessionStore', () => {
  it('mirrors a recorded transcript into the log, and a later drive loads it back deep-equal, on any machine', async () => {
    const first = await drive(async (ctx) => {
      const { journal, store } = await open(ctx);
      expect(store.hasSession).toBe(false);
      expect(await store.load(key)).toBeNull();
      for (const a of fixture.appends) await store.append(a.key, structuredClone(a.entries));
      await journal.flush();
    });
    const records = journalRecords<TranscriptLine>(first.state, CLAUDE_STREAM);
    expect(records.map((r) => r.data)).toEqual(allEntries);
    // Entries with a uuid carry it as the record id (dedupe).
    expect(records.filter((r) => r.id).map((r) => r.id)).toEqual(allEntries.filter((e) => e.uuid).map((e) => e.uuid));

    await drive(
      async (ctx) => {
        const { journal, store } = await open(ctx);
        expect(store.hasSession).toBe(true);
        // Another machine's cwd: a different projectKey, the same session.
        expect(await store.load({ ...key, projectKey: '-tmp-elsewhere-workspace' })).toEqual(allEntries);
        expect(await store.listSubkeys(key)).toEqual([]);
        // The prompt's user entry is found by its uuid.
        const user = allEntries.find((e) => e.type === 'user' && e.uuid)!;
        expect(store.hasUser(user.uuid!)).toBe(true);
        // A replay of the same entries adds only the ones without a uuid.
        const before = journal.length(CLAUDE_STREAM);
        await store.append(key, structuredClone(allEntries));
        await journal.flush();
        expect(journal.length(CLAUDE_STREAM) - before).toBe(allEntries.filter((e) => !e.uuid).length);
      },
      { world: first.world, sessionId: first.sessionId }
    );
  });

  it('a transcript with no message in it (queue operations committed before a crash) is not a session to resume', async () => {
    const ops = allEntries.filter((e) => e.type === 'queue-operation');
    expect(ops.length).toBeGreaterThan(0);
    const first = await drive(async (ctx) => {
      const { journal, store } = await open(ctx);
      await store.append(key, structuredClone(ops));
      await journal.flush();
    });
    const second = await drive(
      async (ctx) => {
        const { journal, store } = await open(ctx);
        // The CLI answers a resume of this "No conversation found", on every delivery.
        expect(store.hasSession).toBe(false);
        await store.append(key, structuredClone(allEntries.filter((e) => e.type === 'user')));
        await journal.flush();
      },
      { world: first.world, sessionId: first.sessionId }
    );
    await drive(
      async (ctx) => {
        const { store } = await open(ctx);
        expect(store.hasSession).toBe(true);
      },
      { world: second.world, sessionId: second.sessionId }
    );
  });

  it('keeps subagent transcripts apart, and round-trips a record too large to stay inline', async () => {
    const big: TranscriptLine = { type: 'attachment', uuid: 'big-1', attachment: { type: 'prompt_snapshot', text: 'x'.repeat(200_000) } };
    const sub: TranscriptLine = { type: 'assistant', uuid: 'sub-1', message: { content: [] } };
    const first = await drive(async (ctx) => {
      const { journal, store } = await open(ctx);
      await store.append(key, [big]);
      await store.append({ ...key, subpath: 'subagents/agent-a1' }, [sub]);
      await journal.flush();
    });
    // The big one is a blob reference in the log.
    expect(journalRecords(first.state, CLAUDE_STREAM)[0]).toMatchObject({ blob: expect.any(String), data: undefined });
    await drive(
      async (ctx) => {
        const { store } = await open(ctx);
        expect(await store.load(key)).toEqual([big]);
        expect(await store.listSubkeys(key)).toEqual(['subagents/agent-a1']);
        expect(await store.load({ ...key, subpath: 'subagents/agent-a1' })).toEqual([sub]);
      },
      { world: first.world, sessionId: first.sessionId }
    );
  });

  it('the barrier: resolves once the assistant entry that made the call is committed (held lines go at once), and refuses after its timeout', async () => {
    const assistant = fixture.appends.flatMap((a) => a.entries).find((e) => toolUseIds(e).length)!;
    const [callId] = toolUseIds(assistant);
    let committedAtBarrier = false;
    const { state } = await drive(async (ctx) => {
      // Lines are held for a minute before they go to the journal, unless something waits for them.
      const { store } = await open(ctx, 60_000);
      await expect(store.barrier('toolu_never_made', 50)).rejects.toThrow(/did not reach the log within 50 ms/);
      // The mirror delivers the entry a moment after the tool asked to run.
      setTimeout(() => void store.append(key, [structuredClone(assistant)]), 100);
      await store.barrier(callId!, 5000);
      committedAtBarrier = journalRecords(ctx.state(), CLAUDE_STREAM).some((r) => r.id === assistant.uuid);
      // Already there: at once.
      await store.barrier(callId!, 1);
    });
    expect(committedAtBarrier).toBe(true);
    expect(journalBatches(state)).toHaveLength(1);
  });

  it('coalesces: lines appended close together share a batch', async () => {
    const { state } = await drive(async (ctx) => {
      const { store } = await open(ctx, 50);
      for (const a of fixture.appends) {
        await store.append(a.key, structuredClone(a.entries));
        await new Promise((r) => setTimeout(r, 5));
      }
      await store.flush();
    });
    expect(journalRecords(state, CLAUDE_STREAM)).toHaveLength(allEntries.length);
    expect(journalBatches(state).length).toBeLessThanOrEqual(2);
  });
});
