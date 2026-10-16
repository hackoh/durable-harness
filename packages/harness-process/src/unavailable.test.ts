import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EffectRecord, emptyState, type SessionState, unavailableOf } from 'harness-world';
import { describe, expect, it } from 'vitest';
import { ProcessHost, spawnFailure } from './host.ts';
import { lastTurnEnd, type TranscriptEntry } from './records.ts';
import { openTurn, recoveryNote } from './recovery.ts';

/**
 * A process harness's side of a turn the harness could not run (harness-world's
 * unavailable.ts): the host says when a child did not start because its binary
 * is not here, and a turn an `unavailable` fact failed is over (no recovery
 * note for it on the next drive).
 */

const errno = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('spawnFailure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-spawn-'));
  const bin = join(dir, 'tool');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o644);

  it('a binary that is not here is unavailable', () => {
    const err = spawnFailure(errno('spawn /var/task/claude ENOENT', 'ENOENT'), '/var/task/claude', dir);
    expect(unavailableOf(err)).toEqual({ code: 'binary_missing', message: '/var/task/claude is not on this machine (spawn ENOENT)' });
    expect((err as Error).cause).toBeInstanceOf(Error);
  });

  it('a binary that is here but cannot run is unusable', () => {
    expect(unavailableOf(spawnFailure(errno(`spawn ${bin} EACCES`, 'EACCES'), bin, dir))?.code).toBe('binary_unusable');
    expect(unavailableOf(spawnFailure(new Error(`spawn ${bin} Unknown system error -8`), bin, dir))?.code).toBe('binary_unusable');
  });

  it('ENOENT with the binary here, or with no working directory, is the error as it was', () => {
    const missingCwd = errno(`spawn ${bin} ENOENT`, 'ENOENT');
    expect(spawnFailure(missingCwd, bin, join(dir, 'gone'))).toBe(missingCwd);
    expect(spawnFailure(missingCwd, bin, dir)).toBe(missingCwd);
    const other = errno('spawn EAGAIN', 'EAGAIN');
    expect(spawnFailure(other, bin, dir)).toBe(other);
  });

  it('a real spawn of a missing binary rejects with it', async () => {
    const host = new ProcessHost({ root: mkdtempSync(join(tmpdir(), 'hw-host-')) });
    const err = await host.spawn('wrun_spawn', { command: join(dir, 'nope') }).catch((e: unknown) => e);
    expect(unavailableOf(err)?.code).toBe('binary_missing');
  });
});

function state(records: Partial<EffectRecord>[], submissions: string[]): SessionState {
  const s = emptyState('wrun_u');
  s.status = 'running';
  for (const id of submissions) s.submissions.push({ id, kind: 'prompt', text: id, receivedAt: new Date() });
  records.forEach((r, i) => {
    const record = { stepId: `step_${i}`, replay: 'safe', status: 'completed', attempt: 1, placed: [], input: null, ...r } as EffectRecord;
    s.effectOrder.push(record);
    s.effects.set(record.key, record);
    for (const id of record.placed) s.placed.add(id);
  });
  return s;
}
const batch = (n: number, entries: TranscriptEntry[]): Partial<EffectRecord> => ({
  key: `journal:${n}`,
  name: 'journal',
  input: { v: 1, n, streams: { transcript: { from: 0, entries: entries.map((data) => ({ data })) } } },
});

describe('a turn an unavailable fact failed', () => {
  it('is over: nothing to recover, and the next message starts a turn', () => {
    const s = state(
      [
        { key: 'place:s1', name: 'place', placed: ['s1'] },
        batch(0, [{ type: 'message', role: 'assistant', text: 'hi' }, { type: 'turn', status: 'completed' }]),
        { key: 'place:s2', name: 'place', placed: ['s2'] },
        batch(1, [{ type: 'message', role: 'assistant', text: 'starting' }]),
        { key: 'unavailable:drv_1:0', name: 'unavailable', placed: ['s3'], output: { code: 'module_missing' } },
      ],
      ['s1', 's2', 's3', 's4']
    );
    expect(lastTurnEnd(s)).toBe(4);
    expect(openTurn(s)).toBeUndefined();
    expect(recoveryNote(s)).toBeUndefined();
  });

  it('a crash after it is recovered as usual', () => {
    const s = state(
      [
        { key: 'unavailable:drv_1:0', name: 'unavailable', placed: ['s1'] },
        { key: 'place:s2', name: 'place', placed: ['s2'] },
        batch(0, [{ type: 'message', role: 'assistant', text: 'working' }]),
      ],
      ['s1', 's2']
    );
    const turn = openTurn(s)!;
    expect(turn.placed).toEqual(['s2']);
    expect(turn.entries.map((e) => e.data.type)).toEqual(['message']);
  });
});
