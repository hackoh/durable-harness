/**
 * The helper on its own (`src/relay/helper.ts`), in this process: what the
 * stand-in can't arrange cheaply or deterministically. A listing whose JSON
 * would pass the budget is `E2BIG` before a byte of it is sent (the bound the
 * relay and the driver keep too, `envResultBytes`); a `CANCEL` that arrives
 * with its `CALL`, before the command started, stops it from starting.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Helper } from '../src/relay/helper.ts';
import { HELPER, HelperReader, helperFrame, pack, parse } from '../src/relay/protocol.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dh-helper-'));
  dirs.push(d);
  return d;
}

/** A helper whose frames are collected, and a way to wait for a call's result. */
function helper(jsonBytes?: number) {
  const reader = new HelperReader(1 << 30);
  const frames: Array<{ type: number; id: number; payload: Uint8Array }> = [];
  const exits: number[] = [];
  const h = new Helper({ PATH: process.env.PATH ?? '/usr/bin:/bin' }, async (bytes) => void frames.push(...reader.push(bytes)), { ...(jsonBytes !== undefined ? { jsonBytes } : {}), exit: (code) => void exits.push(code) });
  const call = (id: number, op: string, args: unknown[]) => helperFrame(HELPER.CALL, id, pack({ op, args }));
  const result = async (id: number) => {
    for (let i = 0; i < 500; i++) {
      const f = frames.find((x) => x.type === HELPER.RESULT && x.id === id);
      if (f) return { result: parse(f.payload) as { ok: boolean; error?: { code: string; message: string }; data?: string }, data: frames.filter((x) => x.type === HELPER.DATA && x.id === id).length };
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no result for call ${id}`);
  };
  return { h, call, result, exits };
}

describe('a listing over the JSON budget', () => {
  it('list and walk are E2BIG, with no DATA sent; under the budget they answer', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'd'));
    for (let i = 0; i < 40; i++) writeFileSync(join(root, 'd', `${'n'.repeat(40)}-${i}`), '');
    const { h, call, result } = helper(1_000);
    h.push(call(1, 'list', [join(root, 'd')]));
    h.push(call(2, 'walk', [root]));
    for (const id of [1, 2]) {
      const { result: r, data } = await result(id);
      expect(r).toMatchObject({ ok: false, error: { code: 'E2BIG' } });
      expect(data).toBe(0);
    }
    const big = helper(100_000);
    big.h.push(big.call(3, 'list', [join(root, 'd')]));
    big.h.push(big.call(4, 'walk', [root]));
    expect((await big.result(3)).result).toMatchObject({ ok: true, data: 'json' });
    expect((await big.result(4)).result).toMatchObject({ ok: true, data: 'json' });
  });

  it('counts the bytes as JSON writes them: a name of control characters costs six bytes each', async () => {
    const root = tempDir();
    // 20 names of 200 control characters: 4 KiB of names, about 24 KiB as JSON.
    for (let i = 0; i < 20; i++) writeFileSync(join(root, `${'\x01'.repeat(200)}${i}`), '');
    const { h, call, result } = helper(10_000);
    h.push(call(1, 'list', [root]));
    expect((await result(1)).result).toMatchObject({ ok: false, error: { code: 'E2BIG' } });
  });
});

describe('a CANCEL', () => {
  it('in the same chunk as its CALL, before the command started: it never runs (EINTR, "did not run")', async () => {
    const root = tempDir();
    const { h, call, result } = helper();
    h.push(Buffer.concat([call(1, 'exec', ['touch marker', { cwd: root }]), helperFrame(HELPER.CANCEL, 1)]));
    const { result: r } = await result(1);
    expect(r).toMatchObject({ ok: false, error: { code: 'EINTR' } });
    expect(r.error!.message).toMatch(/did not run/);
    await new Promise((res) => setTimeout(res, 300));
    expect(existsSync(join(root, 'marker'))).toBe(false);
  });

  it('while the command runs: its group is dead before the result is sent', async () => {
    const root = tempDir();
    const { h, call, result } = helper();
    h.push(call(1, 'exec', ['echo $$ > pid; sleep 30 & echo $! > child; wait', { cwd: root }]));
    for (let i = 0; i < 200 && !existsSync(join(root, 'child')); i++) await new Promise((r) => setTimeout(r, 10));
    const pids = ['pid', 'child'].map((f) => Number(readFileSync(join(root, f), 'utf8').trim()));
    h.push(helperFrame(HELPER.CANCEL, 1));
    expect((await result(1)).result).toMatchObject({ ok: false, error: { code: 'EINTR' } });
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });

  it('a second CALL for a live id ends the helper', async () => {
    const root = tempDir();
    const { h, call, exits } = helper();
    h.push(call(1, 'exec', ['sleep 1', { cwd: root }]));
    h.push(call(1, 'stat', [root]));
    expect(exits).toEqual([2]);
  });
});
