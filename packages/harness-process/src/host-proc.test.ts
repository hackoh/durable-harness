import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupAlive, killRegistered } from './host.ts';

// Reproduce the transient Linux /proc read on every platform, while killing
// real detached process groups so the ownership check remains exercised.
const proc = vi.hoisted(() => ({ path: '', environments: [] as string[], reads: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    existsSync: (path: Parameters<typeof fs.existsSync>[0]) => path === '/proc/self/environ' || fs.existsSync(path),
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== proc.path) return fs.readFileSync(...args);
      const environment = proc.environments[Math.min(proc.reads++, proc.environments.length - 1)]!;
      return environment;
    },
  };
});

let child: ChildProcess | undefined;
let registry: string | undefined;
afterEach(async () => {
  if (child) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    if (child.exitCode === null && child.signalCode === null) await exited;
  }
  if (registry) await rm(registry, { recursive: true, force: true });
  child = undefined;
  registry = undefined;
});

describe('registered group ownership during exec', () => {
  it.each([
    { name: 'the session environment appears after an empty read', environments: ['', 'HARNESS_PROCESS_SESSION=wrun_exec\0'], kill: true, reads: 2 },
    { name: 'the environment stays empty', environments: [''], kill: false, reads: 5 },
    { name: 'a foreign environment appears after an empty read', environments: ['', 'HARNESS_PROCESS_SESSION=another_run\0'], kill: false, reads: 2 },
    { name: 'a populated environment has no session marker', environments: ['OTHER=value\0'], kill: false, reads: 1 },
  ])('$name', async ({ environments, kill, reads }) => {
    child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
    const pgid = child.pid!;
    registry = await mkdtemp(join(tmpdir(), 'hwp-proc-'));
    await writeFile(join(registry, String(pgid)), String(Math.floor(Date.now() / 1000)));
    proc.path = `/proc/${pgid}/environ`;
    proc.environments = environments;
    proc.reads = 0;
    expect(killRegistered(registry, 'wrun_exec')).toEqual(kill ? [pgid] : []);
    expect(proc.reads).toBe(reads);
    if (!kill) expect(groupAlive(pgid)).toBe(true);
  });
});
