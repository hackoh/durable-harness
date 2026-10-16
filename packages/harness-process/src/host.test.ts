import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Yield } from 'harness-world';
import { afterEach, describe, expect, it } from 'vitest';
import { groupAlive, groupOf, isAlive, ProcessHost } from './host.ts';
import { FileTail } from './tail.ts';

const strays = new Set<number>();
afterEach(() => {
  for (const pid of strays) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
  strays.clear();
});

async function until(fn: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Whether a shell registered `name`: the entry exists and holds its registration time. The shell
 * creates the file before `date` writes into it, and off Linux the host reads that time to tell
 * the group is the session's, so an empty entry is not registered yet.
 */
function registered(registry: string, name: string): boolean {
  try {
    return readFileSync(join(registry, name), 'utf8').trim() !== '';
  } catch {
    return false;
  }
}

/** A node child that runs `code`. */
const node = (code: string) => ({ command: process.execPath, args: ['-e', code] });

/** Spawns `sleep 30` in its own group (a grandchild that stays in it), prints both pids, then waits. */
const withGrandchild = node(`
  const { spawn } = require('node:child_process');
  const g = spawn('sleep', ['30'], { stdio: 'ignore' });
  console.log(JSON.stringify({ pid: process.pid, grandchild: g.pid }));
  setInterval(() => {}, 1000);
`);

describe('ProcessHost', () => {
  it('gives the child an explicit environment and a per-session home', async () => {
    const host = new ProcessHost({ root: await mkdtemp(join(tmpdir(), 'hwp-host-')) });
    process.env.HWP_SECRET_FOR_TEST = 'do-not-leak';
    const proc = await host.spawn('wrun_env', { ...node('console.log(JSON.stringify(process.env))'), env: { GIVEN: 'yes' } });
    strays.add(proc.pid);
    delete process.env.HWP_SECRET_FOR_TEST;
    let out = '';
    for await (const line of proc.lines()) out += line;
    const env = JSON.parse(out) as Record<string, string>;
    const dir = await host.dir('wrun_env');
    expect(env.GIVEN).toBe('yes');
    expect(env.HWP_SECRET_FOR_TEST).toBeUndefined();
    expect(env.HOME).toBe(dir.home);
    expect(env.TMPDIR).toBe(dir.tmp);
    expect(env.HARNESS_PROCESS_SESSION).toBe('wrun_env');
    // Nothing else of this process's environment (the OS may add its own, such as macOS's __CF_USER_TEXT_ENCODING).
    const os = (k: string) => k.startsWith('__CF') || k === 'PWD' || k === 'SHLVL' || k === '_';
    expect(Object.keys(env).filter((k) => !os(k)).sort()).toEqual([
      'BASH_ENV',
      'ENV',
      'GIVEN',
      'HARNESS_PROCESS_GROUPS',
      'HARNESS_PROCESS_SESSION',
      'HARNESS_PROCESS_TOKEN',
      'HOME',
      'PATH',
      'SHELL',
      'TMPDIR',
    ]);
    expect(env.HARNESS_PROCESS_GROUPS).toBe(dir.groups);
    expect((await proc.exited).code).toBe(0);
    // A clean exit removes the pidfile: nothing is stale.
    expect(await host.pidRecord('wrun_env')).toBeUndefined();
  });

  it('keeps a default root (`.sessions`) out of git', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'hwp-app-')), '.sessions');
    await new ProcessHost({ root }).dir('wrun_ignored');
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('*\n');
    const other = await mkdtemp(join(tmpdir(), 'hwp-root-'));
    await new ProcessHost({ root: other }).dir('wrun_ignored');
    expect(existsSync(join(other, '.gitignore'))).toBe(false);
  });

  it('kills the whole process group when the drive stops', async () => {
    const host = new ProcessHost({ root: await mkdtemp(join(tmpdir(), 'hwp-host-')) });
    const stop = new AbortController();
    const proc = await host.spawn('wrun_abort', { ...withGrandchild, signal: stop.signal });
    strays.add(proc.pid);
    const first = (await proc.lines()[Symbol.asyncIterator]().next()).value as string;
    const { grandchild } = JSON.parse(first) as { grandchild: number };
    expect(isAlive(grandchild)).toBe(true);
    stop.abort(new Error('halted'));
    expect((await proc.exited).signal).toBe('SIGKILL');
    await until(() => !isAlive(grandchild));
  });

  it('kills a stale child (and its group) a dead drive left, before the next one starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hwp-host-'));
    // The first "process": spawns a child, then dies without killing it.
    const first = new ProcessHost({ root });
    const stale = await first.spawn('wrun_stale', withGrandchild);
    strays.add(stale.pid);
    const { grandchild } = JSON.parse((await stale.lines()[Symbol.asyncIterator]().next()).value as string) as { grandchild: number };
    expect((await first.pidRecord('wrun_stale'))?.pid).toBe(stale.pid);

    // The next drive, in another process on the same machine.
    const second = new ProcessHost({ root });
    const fresh = await second.spawn('wrun_stale', node('setInterval(() => {}, 1000)'));
    strays.add(fresh.pid);
    await until(() => !isAlive(stale.pid) && !isAlive(grandchild));
    expect(fresh.alive()).toBe(true);
    expect((await second.pidRecord('wrun_stale'))?.pid).toBe(fresh.pid);
    fresh.kill();
    await fresh.exited;
  });

  it('leaves a reused pid alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hwp-host-'));
    const host = new ProcessHost({ root });
    const dir = await host.dir('wrun_reused');
    // Something unrelated now holds the recorded pid (its own group leader, too).
    const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    strays.add(other.pid!);
    await writeFile(join(dir.state, 'pid.json'), JSON.stringify({ pid: other.pid, token: 'x', argv: [process.execPath, 'fake-cli.mjs'], startedAt: Date.now() - 60_000, groups: [] }));
    expect(await host.killStale('wrun_reused')).toEqual([]);
    expect(isAlive(other.pid!)).toBe(true);
    expect(groupAlive(other.pid!)).toBe(true);
  });

  it('will not kill a child its own live drive still runs: the overlapping delivery yields', async () => {
    const host = new ProcessHost({ root: await mkdtemp(join(tmpdir(), 'hwp-host-')) });
    const proc = await host.spawn('wrun_live', node('setInterval(() => {}, 1000)'));
    strays.add(proc.pid);
    await expect(host.spawn('wrun_live', node('0'))).rejects.toBeInstanceOf(Yield);
    expect(proc.alive()).toBe(true);
    proc.kill();
    await proc.exited;
    // Once it exited, the session's next drive starts normally.
    const next = await host.spawn('wrun_live', node('0'));
    strays.add(next.pid);
    expect((await next.exited).code).toBe(0);
  });

  it('claims the session for the whole start: a concurrent start yields, and prepare runs before the child', async () => {
    const host = new ProcessHost({ root: await mkdtemp(join(tmpdir(), 'hwp-host-')) });
    const order: string[] = [];
    const first = host.spawn('wrun_race', {
      ...node('setInterval(() => {}, 1000)'),
      prepare: async (dir) => {
        await new Promise((r) => setTimeout(r, 50));
        await writeFile(join(dir.path, 'session.jsonl'), 'rebuilt\n');
        order.push('prepared');
      },
    });
    // The other delivery starts while the first is still preparing.
    await expect(host.spawn('wrun_race', node('0'))).rejects.toBeInstanceOf(Yield);
    const proc = await first;
    strays.add(proc.pid);
    order.push('spawned');
    expect(order).toEqual(['prepared', 'spawned']);
    expect(await readFile(join((await host.dir('wrun_race')).path, 'session.jsonl'), 'utf8')).toBe('rebuilt\n');
    proc.kill();
    await proc.exited;
  });

  it('records adopted groups and kills them with a stale child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hwp-host-'));
    const first = new ProcessHost({ root });
    const proc = await first.spawn('wrun_adopt', node('setInterval(() => {}, 1000)'));
    strays.add(proc.pid);
    const escaped = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    strays.add(escaped.pid!);
    await proc.adopt(escaped.pid!);
    expect(JSON.parse(await readFile(join((await first.dir('wrun_adopt')).state, 'pid.json'), 'utf8')).groups).toEqual([escaped.pid]);
    const killed = await new ProcessHost({ root }).killStale('wrun_adopt');
    expect(killed.sort()).toEqual([proc.pid, escaped.pid].sort());
    await until(() => !isAlive(proc.pid) && !isAlive(escaped.pid!));
  });
});

describe('the group registry', () => {
  /** A child that starts `command` the way a harness's shell tool does: detached (a group of its own), under its env. */
  const toolStarter = (shell: string, stdin: 'pipe' | 'ignore' = 'pipe') =>
    node(`
      const t = require('node:child_process').spawn(${JSON.stringify(shell)}, ['-c', 'sleep 30'], { detached: true, stdio: [${JSON.stringify(stdin)}, 'ignore', 'ignore'] });
      console.log(JSON.stringify({ tool: t.pid }));
      setInterval(() => {}, 1000);
    `);
  // The shells the harnesses' tools use. A non-interactive `sh -c` reads no startup file, so it
  // registers nothing (it stays in whatever group started it, which is then the one killed).
  const shells = ['/bin/bash', '/bin/zsh'].filter((s) => existsSync(s));

  it.each(shells.flatMap((sh) => [[sh, 'pipe'] as const, [sh, 'ignore'] as const]))(
    'a command %s starts in a group of its own (stdin %s) registers it, and a stale child is killed with it',
    async (shell, stdin) => {
      const root = await mkdtemp(join(tmpdir(), 'hwp-reg-'));
      const first = new ProcessHost({ root });
      const proc = await first.spawn('wrun_reg', toolStarter(shell, stdin));
      strays.add(proc.pid);
      const { tool } = JSON.parse((await proc.lines()[Symbol.asyncIterator]().next()).value as string) as { tool: number };
      strays.add(tool);
      const dir = await first.dir('wrun_reg');
      await until(() => registered(dir.groups, String(tool)));
      // The child's own group does not reach the command.
      expect(groupAlive(tool)).toBe(true);
      // The next drive on this machine, in another process.
      const killed = await new ProcessHost({ root }).killStale('wrun_reg');
      expect(killed).toContain(tool);
      await until(() => !groupAlive(tool) && !isAlive(proc.pid));
      expect(readdirSync(dir.groups)).toEqual([]);
    }
  );

  it('a command stays in the registered group when its shell turns job control on (as Claude Code\'s shell snapshot does)', async () => {
    // Claude Code's Bash sources a snapshot with `set -o monitor` after BASH_ENV: with job control on,
    // the command would get a group of its own that nothing registered, and outlive a crash.
    const job = "set -o monitor; /bin/sh -c 'echo $$; exec sleep 30'";
    const root = await mkdtemp(join(tmpdir(), 'hwp-reg-'));
    const first = new ProcessHost({ root });
    const proc = await first.spawn('wrun_jobs', node(`
      const t = require('node:child_process').spawn('/bin/bash', ['-c', ${JSON.stringify(job)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      t.stdout.once('data', (d) => console.log(JSON.stringify({ tool: t.pid, job: Number(String(d).trim()) })));
      setInterval(() => {}, 1000);
    `));
    strays.add(proc.pid);
    const { tool, job: pid } = JSON.parse((await proc.lines()[Symbol.asyncIterator]().next()).value as string) as { tool: number; job: number };
    strays.add(tool);
    strays.add(pid);
    expect(groupOf(pid)).toBe(tool);
    const dir = await first.dir('wrun_jobs');
    await until(() => registered(dir.groups, String(tool)));
    expect(await new ProcessHost({ root }).killStale('wrun_jobs')).toContain(tool);
    await until(() => !isAlive(pid));
  });

  it('a shell that cannot read its group (no ps: a sandbox) registers its pid, which the host resolves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hwp-reg-'));
    // A PATH with date and nothing else: `ps` is not there (on Linux /proc answers, so this checks macOS's path).
    const bin = await mkdtemp(join(tmpdir(), 'hwp-bin-'));
    const { symlinkSync } = await import('node:fs');
    // One link: on a merged-/usr system (Ubuntu, CI) both paths exist.
    const date = ['/bin/date', '/usr/bin/date'].find((d) => existsSync(d));
    if (date) symlinkSync(date, join(bin, 'date'));
    const first = new ProcessHost({ root });
    const proc = await first.spawn('wrun_pid', {
      ...node(`
        const t = require('node:child_process').spawn('/bin/bash', ['-c', '/bin/sleep 30'], { detached: true, stdio: 'ignore', env: { ...process.env, PATH: ${JSON.stringify(bin)} } });
        console.log(JSON.stringify({ tool: t.pid }));
        setInterval(() => {}, 1000);
      `),
    });
    strays.add(proc.pid);
    const { tool } = JSON.parse((await proc.lines()[Symbol.asyncIterator]().next()).value as string) as { tool: number };
    strays.add(tool);
    const dir = await first.dir('wrun_pid');
    const entry = existsSync('/proc/self/stat') ? String(tool) : `pid-${tool}`;
    await until(() => registered(dir.groups, entry));
    expect(await new ProcessHost({ root }).killStale('wrun_pid')).toContain(tool);
    await until(() => !groupAlive(tool));
  });

  it('a child that exits takes its tools with it; killGroups clears the registry', async () => {
    const host = new ProcessHost({ root: await mkdtemp(join(tmpdir(), 'hwp-reg-')) });
    const proc = await host.spawn('wrun_exit', node(`
      const t = require('node:child_process').spawn('bash', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
      console.log(JSON.stringify({ tool: t.pid }));
      setTimeout(() => process.exit(0), 300);
    `));
    const { tool } = JSON.parse((await proc.lines()[Symbol.asyncIterator]().next()).value as string) as { tool: number };
    strays.add(tool);
    expect((await proc.exited).code).toBe(0);
    await until(() => !groupAlive(tool));
    expect(await host.killGroups('wrun_exit')).toEqual([]);
  });

  it('leaves a registered group alone once its id belongs to something else', async () => {
    const host = new ProcessHost({ root: await mkdtemp(join(tmpdir(), 'hwp-reg-')) });
    const dir = await host.dir('wrun_reused_group');
    const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    strays.add(other.pid!);
    await new Promise((r) => setTimeout(r, 100));
    // Registered long before this process group started.
    await writeFile(join(dir.groups, String(other.pid)), String(Math.floor(Date.now() / 1000) - 600));
    expect(await host.killGroups('wrun_reused_group')).toEqual([]);
    expect(groupAlive(other.pid!)).toBe(true);
  });

  it('the watchdog: a SIGKILL of the drive process takes the child and its tools with it', async () => {
    const parent = spawn(process.execPath, ['--import', 'tsx', new URL('./fixtures/watchdog-parent.ts', import.meta.url).pathname, await mkdtemp(join(tmpdir(), 'hwp-watch-'))], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const { pid, tool } = await new Promise<{ pid: number; tool: number }>((r) => parent.stdout!.once('data', (d: Buffer) => r(JSON.parse(d.toString()))));
    strays.add(pid);
    strays.add(tool);
    expect(groupAlive(pid) && groupAlive(tool)).toBe(true);
    parent.kill('SIGKILL');
    await until(() => !groupAlive(pid) && !groupAlive(tool), 5000);
  });
});

describe('FileTail', () => {
  it('returns complete lines only, and refuses a file that shrank', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'hwp-tail-')), 'session.jsonl');
    const tail = new FileTail(file);
    expect(tail.read()).toEqual([]);
    writeFileSync(file, '{"a":1}\n{"b":');
    expect(tail.read()).toEqual(['{"a":1}']);
    appendFileSync(file, '2}\n');
    expect(tail.read()).toEqual(['{"b":2}']);
    expect(tail.read()).toEqual([]);
    writeFileSync(file, 'x\n');
    expect(() => tail.read()).toThrow(/shrank/);
  });
});
