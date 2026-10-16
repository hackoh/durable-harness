import type { WorkspaceMachine } from 'harness-world-hands/runtime';
import { describe, expect, it } from 'vitest';
import type { ProcessHostLike, SessionMachine } from './environment.ts';
import { type HostedProcess, ProcessHost } from './host.ts';
import { isBrandedMachine as fromIndex, type ProcessLike } from './index.ts';
import { isBrandedMachine, machineBrand } from './machine-brand.ts';

/** A machine's shape, with nothing behind it (the brand is about provenance, not shape). */
function shape(): Omit<SessionMachine, 'brand'> {
  const never = () => Promise.reject(new Error('not a real machine'));
  return {
    sessionId: 'wrun_1',
    fence: { count: 7, fenced: true },
    root: '/workspace',
    workspace: { root: '/workspace', exec: never } as unknown as WorkspaceMachine,
    dirs: { home: '/var/lib/dh/s/home', config: '/var/lib/dh/s/config', 'codex-home': '/var/lib/dh/s/codex-home', tmp: '/var/lib/dh/s/tmp', cache: '/var/lib/dh/s/cache' },
    signal: new AbortController().signal,
    modelUrl: 'http://127.0.0.1:4100',
    modelKey: 'dhm-shape-only-model-key-00',
    notes: Object.freeze([]),
    spawn: never,
    files: { upload: never, wipe: never },
    tail: never,
    fsync: never,
    close: never,
  };
}

describe('the session machine brand', () => {
  const brand = machineBrand();

  it('is claimed once; what its minter brands passes, and a hand-written machine or a copy of a branded one does not', () => {
    expect(() => machineBrand()).toThrow(/already claimed/);
    const machine = brand(shape());
    expect(isBrandedMachine(machine)).toBe(true);
    expect(fromIndex).toBe(isBrandedMachine);
    // The same shape, written by hand, with any brand-like value.
    expect(isBrandedMachine({ ...shape(), brand: {} })).toBe(false);
    // A spread drops the (non-enumerable) brand; carrying it over by hand still names another object.
    expect(isBrandedMachine({ ...machine })).toBe(false);
    expect(isBrandedMachine({ ...machine, brand: machine.brand })).toBe(false);
    expect(isBrandedMachine(undefined)).toBe(false);
    expect(Object.keys(machine)).not.toContain('brand');
  });

  it('freezes what it brands: swapping spawn, a cache-file operation or the workspace shell throws and changes nothing, and the machine stays branded', () => {
    const machine = brand(shape());
    const spawn = machine.spawn;
    const hostSpawn = async () => ({}) as never;
    expect(Object.isFrozen(machine) && Object.isFrozen(machine.files) && Object.isFrozen(machine.dirs) && Object.isFrozen(machine.workspace)).toBe(true);
    // Test files are ES modules: strict mode, so a write to a frozen property throws.
    expect(() => {
      (machine as { spawn: unknown }).spawn = hostSpawn;
    }).toThrow(TypeError);
    expect(() => {
      (machine.files as { wipe: unknown }).wipe = hostSpawn;
    }).toThrow(TypeError);
    expect(() => {
      (machine.workspace as { exec: unknown }).exec = hostSpawn;
    }).toThrow(TypeError);
    expect(() => {
      (machine as { brand: unknown }).brand = {};
    }).toThrow(TypeError);
    expect(machine.spawn).toBe(spawn);
    expect(isBrandedMachine(machine)).toBe(true);
  });

  it('is not in the index: the minter is its own entry', async () => {
    const index = await import('./index.ts');
    expect('machineBrand' in index).toBe(false);
  });
});

describe('ProcessHostLike', () => {
  it('ProcessHost is one, and its children are ProcessLike', () => {
    const host: ProcessHostLike = new ProcessHost({ root: '/tmp/hwp-environment-test' });
    const child = (p: HostedProcess): ProcessLike => p;
    expect(typeof host.spawn).toBe('function');
    expect(typeof child).toBe('function');
  });
});
