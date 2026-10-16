import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { type DriveContext, durableSessions, type Harness } from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeJournal } from './journal.ts';
import { journalLedger, SPEND_STREAM } from './ledger.ts';

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close?.();
});

/** One drive of a session (a new invocation), with `body` as the harness; `world` and `sessionId` continue an earlier one. */
async function drive(body: (ctx: DriveContext) => Promise<void>, options: { world?: LocalWorld; sessionId?: string } = {}) {
  let ran = false;
  const world = options.world ?? createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hwp-ledger-')), recoverActiveRuns: false });
  if (!options.world) worlds.push(world);
  const harness: Harness = {
    name: 'ledgered',
    async drive(ctx) {
      const pending = ctx.pending();
      if (pending.length === 0) return;
      await ctx.effect(`place:${pending[0]!.id}`, { name: 'place', replay: 'safe', input: null, placed: pending.map((p) => p.id) }, async () => true);
      await body(ctx);
      ran = true;
    },
  };
  const sessions = durableSessions({ world, harness });
  const sessionId = options.sessionId ?? (await sessions.start()).sessionId;
  await sessions.send(sessionId, 'go', 'prompt', { wake: 'backstop' });
  await sessions.drive(sessionId);
  // The body's own expectations held (a failed one fails the drive, not this test).
  expect(ran).toBe(true);
  return { world, sessionId };
}

const charge = { method: 'POST', path: '/v1/messages' };

describe('journalLedger: the spend in the session log', () => {
  it("carries the session's and each turn's totals to a later invocation, which reads them from the log", async () => {
    const first = await drive(async (ctx) => {
      const journal = new NativeJournal(ctx);
      const ledger = journalLedger(journal);
      expect(ledger.spent()).toEqual({ turnUsd: 0, sessionUsd: 0 });
      ledger.turn('turn-a');
      ledger.add(0.25, charge);
      ledger.add(0.5, { ...charge, estimated: true });
      ledger.turn('turn-b');
      ledger.add(1, { ...charge, model: 'claude-haiku-4-5' });
      // Not charges: refused before they count.
      ledger.add(Number.NaN, charge);
      ledger.add(-3, charge);
      ledger.add(Infinity, charge);
      expect(ledger.spent()).toEqual({ turnUsd: 1, sessionUsd: 1.75 });
      // A record on the stream that isn't a charge (a poisoned or foreign entry) counts nothing.
      journal.append(SPEND_STREAM, { usd: 'lots', turn: 'turn-a' });
      journal.append(SPEND_STREAM, { usd: -2, turn: 'turn-b' });
      await journal.flush();
    });
    await drive(
      async (ctx) => {
        const journal = new NativeJournal(ctx);
        const ledger = journalLedger(journal);
        // A turn not started yet has nothing; the session has everything.
        expect(ledger.spent()).toEqual({ turnUsd: 0, sessionUsd: 1.75 });
        ledger.turn('turn-a');
        expect(ledger.spent()).toEqual({ turnUsd: 0.75, sessionUsd: 1.75 });
        ledger.turn('turn-b');
        expect(ledger.spent()).toEqual({ turnUsd: 1, sessionUsd: 1.75 });
        // A redelivered turn keeps its key, and so its total: more spend adds to it.
        ledger.turn('turn-a');
        ledger.add(0.25, charge);
        expect(ledger.spent()).toEqual({ turnUsd: 1, sessionUsd: 2 });
        const records = journal.records<{ usd: number; turn?: string; estimated?: boolean; model?: string }>(SPEND_STREAM);
        expect(records.map((r) => r.data)).toEqual([
          { usd: 0.25, turn: 'turn-a', path: '/v1/messages' },
          { usd: 0.5, turn: 'turn-a', estimated: true, path: '/v1/messages' },
          { usd: 1, turn: 'turn-b', path: '/v1/messages', model: 'claude-haiku-4-5' },
          { usd: 'lots', turn: 'turn-a' },
          { usd: -2, turn: 'turn-b' },
        ]);
        await journal.flush();
      },
      first
    );
  });

  it('reads charges offloaded to the blob stream, given the records read back (`journal.read()`)', async () => {
    const first = await drive(async (ctx) => {
      // Every record offloaded.
      const journal = new NativeJournal(ctx, { inlineMaxBytes: 8 });
      const ledger = journalLedger(journal);
      ledger.turn('turn-a');
      ledger.add(0.5, charge);
      await journal.flush();
    });
    await drive(
      async (ctx) => {
        const journal = new NativeJournal(ctx);
        expect(journal.records(SPEND_STREAM).every((r) => r.blob !== undefined)).toBe(true);
        const ledger = journalLedger(journal, { records: await journal.read() });
        ledger.turn('turn-a');
        expect(ledger.spent()).toEqual({ turnUsd: 0.5, sessionUsd: 0.5 });
      },
      first
    );
  });
});
