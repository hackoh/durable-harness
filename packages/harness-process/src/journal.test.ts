import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DriveContext, durableSessions, emptyState, encode, Fatal, fold, type Harness, Restart, stepNameFor } from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import { blobStreamName, NativeJournal, readJournal } from './journal.ts';
import { JOURNAL, journalBatches, journalRecords, summarizeBatch, TRANSCRIPT, transcriptOf } from './records.ts';

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

/** Drive one session with `body` as the harness, once, and return its fold. */
async function drive(body: (ctx: DriveContext) => Promise<void>, options: { runAhead?: boolean; world?: LocalWorld; sessionId?: string } = {}) {
  const world = options.world ?? createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hwp-journal-')), recoverActiveRuns: false });
  if (!options.world) worlds.push(world);
  // Place the prompt first: a drive that leaves it pending is driven again (and again).
  const harness: Harness = {
    name: 'journaled',
    async drive(ctx) {
      const pending = ctx.pending();
      if (pending.length === 0) return;
      await ctx.effect(`place:${pending[0]!.id}`, { name: 'place', replay: 'safe', input: null, placed: pending.map((p) => p.id) }, async () => true);
      await body(ctx);
    },
  };
  const sessions = durableSessions({ world, harness, ...(options.runAhead !== undefined ? { runAhead: options.runAhead } : {}) });
  const sessionId = options.sessionId ?? (await sessions.start()).sessionId;
  await sessions.send(sessionId, 'go', 'prompt', { wake: 'backstop' });
  await sessions.drive(sessionId);
  return { world, sessions, sessionId, state: await sessions.inspect(sessionId) };
}

describe('NativeJournal', () => {
  it('group-commits: one batch in flight, everything queued behind it in the next', async () => {
    const { state } = await drive(async (ctx) => {
      const j = new NativeJournal(ctx);
      j.append('native', { n: 0 });
      // These arrive while batch 0 is being written.
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      for (let i = 1; i < 6; i++) j.append('native', { n: i });
      j.message({ type: 'message', role: 'assistant', text: 'hi' });
      await j.flush();
      expect(j.length('native')).toBe(6);
    });
    const batches = journalBatches(state);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches.length).toBeLessThan(7);
    expect(journalRecords(state, 'native').map((r) => (r.data as { n: number }).n)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(journalRecords(state, 'native').map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(transcriptOf(state).map((r) => r.data)).toEqual([{ type: 'message', role: 'assistant', text: 'hi' }]);
    expect(batches.map((b) => b.record.key)).toEqual(batches.map((_, i) => `journal:${i}`));
    expect(state.effectOrder.filter((e) => e.name === JOURNAL).every((e) => e.status === 'completed')).toBe(true);
  });

  it('continues a session: positions, batch numbers and record ids carry over to the next drive', async () => {
    const first = await drive(async (ctx) => {
      const j = new NativeJournal(ctx);
      j.append('native', 'a', { id: 'r1' });
      j.append('native', 'b', { id: 'r2' });
      await j.flush();
    });
    const { state } = await drive(
      async (ctx) => {
        const j = new NativeJournal(ctx);
        expect(j.length('native')).toBe(2);
        expect(j.has('r1')).toBe(true);
        // Dedupe: the same record id again is not appended.
        expect(j.append('native', 'a again', { id: 'r1' })).toBe(false);
        expect(j.append('native', 'c', { id: 'r3' })).toBe(true);
        await j.flush();
      },
      { world: first.world, sessionId: first.sessionId }
    );
    expect(journalRecords(state, 'native').map((r) => [r.seq, r.data, r.id])).toEqual([
      [0, 'a', 'r1'],
      [1, 'b', 'r2'],
      [2, 'c', 'r3'],
    ]);
  });

  it('offloads large records to the blob stream and reads them back, hash-checked', async () => {
    const big = { text: 'x'.repeat(5000) };
    const { world, sessionId, state } = await drive(async (ctx) => {
      const j = new NativeJournal(ctx, { inlineMaxBytes: 1024 });
      j.append('native', big);
      j.append('native', big); // the same blob once
      j.append('native', 'small');
      // The transcript stays inline whatever its size.
      j.message({ type: 'message', role: 'assistant', text: 'y'.repeat(5000) });
      await j.flush();
      const back = await j.read('native');
      expect(back.map((r) => r.data)).toEqual([big, big, 'small']);
    });
    const records = journalRecords(state, 'native');
    expect(records[0]!.data).toBeUndefined();
    expect(records[0]!.blob).toMatch(/^[0-9a-f]{64}$/);
    expect(records[1]!.blob).toBe(records[0]!.blob);
    expect(records[2]!.data).toBe('small');
    expect((transcriptOf(state)[0]!.data as { text: string }).text).toHaveLength(5000);
    // The UI summary drops native payloads.
    expect(summarizeBatch(journalBatches(state)[0]!.batch)).toMatchObject({ streams: { native: { count: 3, blobs: 2 } } });

    const ctx = { world, runId: sessionId, state: () => state };
    expect((await readJournal(ctx, 'native')).map((r) => r.data)).toEqual([big, big, 'small']);
    // A blob whose bytes do not match its hash is not trusted: the record cannot be read.
    const tampered = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hwp-journal-')) });
    worlds.push(tampered);
    await tampered.streams.write(sessionId, blobStreamName(sessionId), new TextEncoder().encode(`${JSON.stringify({ h: records[0]!.blob, s: '"forged"' })}\n\n`));
    await expect(readJournal({ world: tampered, runId: sessionId, state: () => state }, 'native')).rejects.toBeInstanceOf(Fatal);
  });

  it('writes a blob larger than a stream chunk in pieces', async () => {
    const big = { text: 'z😀'.repeat(3000) };
    const { world, sessionId, state } = await drive(async (ctx) => {
      const j = new NativeJournal(ctx, { inlineMaxBytes: 100, blobPieceChars: 1001 });
      j.append('native', big);
      await j.flush();
    });
    expect((await readJournal({ world, runId: sessionId, state: () => state }, 'native'))[0]!.data).toEqual(big);
  });

  it('under run-ahead durability: the same records', async () => {
    const { state } = await drive(
      async (ctx) => {
        const j = new NativeJournal(ctx);
        for (let i = 0; i < 4; i++) j.append('native', i);
        await j.flush();
        for (let i = 4; i < 8; i++) j.append('native', i);
        await j.flush();
      },
      { runAhead: true }
    );
    expect(journalRecords(state, 'native').map((r) => r.data)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('a failed batch write poisons the journal and halts the drive', async () => {
    const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hwp-journal-')), recoverActiveRuns: false });
    worlds.push(world);
    const create = world.events.create.bind(world.events);
    const refused = new Error('refused');
    world.events.create = (async (runId: string, request: any, params?: any) => {
      if (String(request?.eventData?.stepName).endsWith('//journal')) throw refused;
      return create(runId, request, params);
    }) as typeof world.events.create;
    let seen: unknown;
    const run = drive(
      async (ctx) => {
        const j = new NativeJournal(ctx);
        j.append('native', 1);
        await j.flush().catch((err) => (seen = err));
        expect(j.poisoned).toBe(refused);
        expect(j.append('native', 2)).toBe(false);
        expect(ctx.signal.aborted).toBe(true);
      },
      { world }
    );
    await expect(run).rejects.toBe(refused);
    expect(seen).toBe(refused);
  });

  it('a batch number another writer took first is a Restart, not a batch silently lost', async () => {
    let seen: unknown;
    let aborted = false;
    const { state } = await drive(async (ctx) => {
      if (ctx.attempt > 0) return; // the rebuilt drive has nothing to add
      // Two writers on one session (two drives at once), both at batch 0.
      const mine = new NativeJournal(ctx);
      const theirs = new NativeJournal(ctx);
      theirs.append('native', 'theirs');
      await theirs.flush();
      // journal:0 is in this drive's fold now: ctx.effect would answer it with their result.
      mine.append('native', 'mine');
      await mine.flush().catch((err) => (seen = err));
      aborted = ctx.signal.aborted;
    });
    expect(seen).toBeInstanceOf(Restart);
    expect((seen as Error).message).toContain('journal batch 0 was written by another drive');
    expect(aborted).toBe(true);
    expect(journalRecords(state, 'native').map((r) => r.data)).toEqual(['theirs']);
  });
});

describe('the reader', () => {
  /** Hand-written log events for a journal effect. */
  const events = (runId: string) => {
    let slot = 0;
    const ev = (eventType: string, correlationId: string, eventData: Record<string, unknown>) => ({
      eventId: `evnt_${String(++slot).padStart(26, '0')}`,
      runId,
      eventType,
      correlationId,
      eventData,
      createdAt: new Date(),
    });
    // A born-running intent: the World writes its `step_created` with the `step_started`.
    const intent = (step: string, n: number, data: unknown[], retryOf?: string) => [
      ev('step_created', step, {
        stepName: stepNameFor(JOURNAL),
        input: encode({ key: `journal:${n}`, replay: 'safe', input: { v: 1, n, streams: { native: { from: 0, entries: data.map((d) => ({ data: d })) } } }, ...(retryOf ? { retryOf } : {}) }),
      }),
      ev('step_started', step, { stepName: stepNameFor(JOURNAL) }),
    ];
    const done = (step: string) => ev('step_completed', step, { stepName: stepNameFor(JOURNAL), result: encode(true) });
    const retrying = (step: string) => ev('step_retrying', step, { stepName: stepNameFor(JOURNAL), error: encode({ message: 'interrupted' }) });
    return { intent, done, retrying };
  };

  it('counts a batch only once its outcome is committed, and a released batch is replaced by its retry', () => {
    const { intent, done, retrying } = events('wrun_x');
    // Batch 0 done; batch 1's writer died after its intent.
    const state = fold(emptyState('wrun_x'), [...intent('s0', 0, ['a']), done('s0'), ...intent('s1', 1, ['lost'])] as never);
    expect(journalRecords(state).map((r) => r.data)).toEqual(['a']);
    // The recovery released it; the next writer's retry is batch 1 now.
    fold(state, [retrying('s1'), ...intent('s2', 1, ['b'], 's1'), done('s2')] as never);
    expect(journalRecords(state).map((r) => [r.seq, r.data, r.batch])).toEqual([
      [0, 'a', 0],
      [1, 'b', 1],
    ]);
    // A second writer racing for batch 1 lost (first writer wins per key).
    fold(state, [...intent('s3', 1, ['racer']), done('s3')] as never);
    expect(journalRecords(state).map((r) => r.data)).toEqual(['a', 'b']);
  });

  it('reads one stream or all of them, transcript included', () => {
    const state = emptyState('wrun_y');
    expect(journalRecords(state)).toEqual([]);
    expect(transcriptOf(state)).toEqual([]);
    expect(TRANSCRIPT).toBe('transcript');
  });
});
