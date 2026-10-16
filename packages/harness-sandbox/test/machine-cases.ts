/**
 * The `WorkspaceMachine` cases (harness-world-hands' interface,
 * `packages/harness-hands/src/machine.ts`), written once and run against every
 * machine that claims it: the in-memory one (`createMachine`, just-bash) and
 * `RemoteMachine` (the VM's `/workspace` over the relay's helper), on the
 * stand-in (`machine-conformance.test.ts`) and in a real VM (`live-env.test.ts`).
 * harness-world-hands has no reusable suite of its own, so this is it: each
 * case says what the interface promises, and both machines must agree.
 *
 * Paths are built from `machine.root` (`/workspace` in a VM and on the
 * in-memory machine, a temp dir on the stand-in). Where a real filesystem
 * reports more than the in-memory one can (a directory's size, an mtime), the
 * case checks the shape, not the number.
 */
import { describe, expect, it } from 'vitest';
import type { WorkspaceMachine } from 'harness-world-hands/runtime';

/** A fresh, empty machine for one case, and how to free it. */
export interface MachineUnderTest {
  machine: WorkspaceMachine;
  dispose(): Promise<void>;
}

/**
 * The POSIX code a call failed with (undefined if it didn't fail): its `code`,
 * or the code its message starts with (`ENOENT: no such file or directory, …`).
 * The in-memory machine's errors carry the code only in the message today;
 * `RemoteMachine`'s carry both (its own test checks `code`).
 */
export async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    return /^(E[A-Z0-9]+):/.exec(String((err as Error)?.message))?.[1] ?? 'no code';
  }
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 256);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Register the cases under `name`, each on a fresh machine from `make`. */
export function machineCases(name: string, make: () => Promise<MachineUnderTest>, options: { timeout?: number } = {}): void {
  const t = options.timeout ?? 30_000;
  const on = (title: string, body: (m: WorkspaceMachine, at: (p: string) => string) => Promise<void>) =>
    it(
      title,
      async () => {
        const { machine, dispose } = await make();
        try {
          await body(machine, (p) => `${machine.root}/${p}`);
        } finally {
          await dispose();
        }
      },
      t
    );

  describe(`WorkspaceMachine: ${name}`, () => {
    on('a written file reads back byte for byte, its parent directories made', async (m, at) => {
      await m.writeFile(at('a/b/c.txt'), 'hello\n');
      expect(text(await m.readFile(at('a/b/c.txt')))).toBe('hello\n');
      const bin = bytes(70_000);
      await m.writeFile(at('bin/data'), bin);
      expect(Buffer.from(await m.readFile(at('bin/data'))).equals(Buffer.from(bin))).toBe(true);
      expect((await m.stat(at('a/b')))?.type).toBe('directory');
    });

    on('a relative path is taken from the root, and .. is folded', async (m, at) => {
      await m.writeFile('rel/x.txt', 'r');
      expect(text(await m.readFile(at('rel/x.txt')))).toBe('r');
      await m.writeFile(at('rel/../folded.txt'), 'f');
      expect(text(await m.readFile(at('folded.txt')))).toBe('f');
    });

    on('append adds to a file; an overwrite keeps its mode unless one is given', async (m, at) => {
      await m.writeFile(at('log'), 'one\n');
      await m.writeFile(at('log'), 'two\n', { append: true });
      expect(text(await m.readFile(at('log')))).toBe('one\ntwo\n');
      expect((await m.stat(at('log')))?.mode).toBe(0o644);
      await m.chmod(at('log'), 0o755);
      await m.writeFile(at('log'), 'three\n');
      expect((await m.stat(at('log')))?.mode).toBe(0o755);
      await m.writeFile(at('log'), 'four\n', { mode: 0o600 });
      expect((await m.stat(at('log')))?.mode).toBe(0o600);
      expect(text(await m.readFile(at('log')))).toBe('four\n');
    });

    on('stat follows links and lstat does not; nothing there is undefined', async (m, at) => {
      await m.writeFile(at('f.txt'), '12345');
      await m.mkdir(at('d'));
      await m.symlink('f.txt', at('link'));
      expect(await m.stat(at('f.txt'))).toMatchObject({ type: 'file', size: 5, mode: 0o644 });
      expect((await m.stat(at('f.txt')))?.mtimeMs).toBeTypeOf('number');
      expect(await m.stat(at('d'))).toMatchObject({ type: 'directory', mode: 0o755 });
      expect(await m.stat(at('link'))).toMatchObject({ type: 'file', size: 5 });
      expect((await m.lstat(at('link')))?.type).toBe('symlink');
      expect(await m.stat(at('missing'))).toBeUndefined();
      expect(await m.lstat(at('missing'))).toBeUndefined();
      expect(await m.stat(at('f.txt/under-a-file'))).toBeUndefined();
    });

    on("list gives a directory's entries sorted by name, a link as a link", async (m, at) => {
      await m.writeFile(at('dir/b.txt'), 'b');
      await m.writeFile(at('dir/a.txt'), 'a');
      await m.mkdir(at('dir/sub'));
      await m.symlink('a.txt', at('dir/l'));
      expect(await m.list(at('dir'))).toEqual([
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
        { name: 'l', type: 'symlink' },
        { name: 'sub', type: 'directory' },
      ]);
      expect(await codeOf(m.list(at('nope')))).toBe('ENOENT');
    });

    on('walk gives every path under a directory, sorted; a link is its target, flagged; a dangling one is left out', async (m, at) => {
      await m.writeFile(at('w/a.txt'), 'aa');
      await m.writeFile(at('w/sub/b.txt'), 'b');
      await m.symlink('a.txt', at('w/link'));
      await m.symlink('nowhere', at('w/dangling'));
      const shape = (entries: Awaited<ReturnType<WorkspaceMachine['walk']>>) =>
        entries.map((e) => ({ path: e.path, type: e.type, ...(e.type === 'file' ? { size: e.size } : {}), ...(e.link ? { link: true } : {}) }));
      expect(shape(await m.walk(at('w')))).toEqual([
        { path: at('w/a.txt'), type: 'file', size: 2 },
        { path: at('w/link'), type: 'file', size: 2, link: true },
        { path: at('w/sub'), type: 'directory' },
        { path: at('w/sub/b.txt'), type: 'file', size: 1 },
      ]);
      expect(shape(await m.walk(at('w/sub')))).toEqual([{ path: at('w/sub/b.txt'), type: 'file', size: 1 }]);
      expect(await m.walk(at('not-there'))).toEqual([]);
      // The default is the root.
      expect((await m.walk()).map((e) => e.path)).toContain(at('w/sub/b.txt'));
    });

    on('mkdir: a missing parent is ENOENT and an existing path EEXIST, unless recursive', async (m, at) => {
      expect(await codeOf(m.mkdir(at('p/q')))).toBe('ENOENT');
      await m.mkdir(at('p/q'), { recursive: true });
      expect((await m.stat(at('p/q')))?.type).toBe('directory');
      expect(await codeOf(m.mkdir(at('p')))).toBe('EEXIST');
      await m.mkdir(at('p'), { recursive: true });
    });

    on('remove: a file, a tree only when recursive, and a missing path only with force', async (m, at) => {
      await m.writeFile(at('r/one.txt'), '1');
      await m.writeFile(at('r/deep/two.txt'), '2');
      await m.remove(at('r/one.txt'));
      expect(await m.stat(at('r/one.txt'))).toBeUndefined();
      expect(await codeOf(m.remove(at('r')))).not.toBeUndefined();
      expect((await m.stat(at('r/deep/two.txt')))?.type).toBe('file');
      await m.remove(at('r'), { recursive: true });
      expect(await m.stat(at('r'))).toBeUndefined();
      expect(await codeOf(m.remove(at('r')))).toBe('ENOENT');
      await m.remove(at('r'), { force: true });
    });

    on('rename moves a file and a directory with its contents', async (m, at) => {
      await m.writeFile(at('old.txt'), 'o');
      await m.rename(at('old.txt'), at('new.txt'));
      expect(await m.stat(at('old.txt'))).toBeUndefined();
      expect(text(await m.readFile(at('new.txt')))).toBe('o');
      await m.writeFile(at('tree/x/y.txt'), 'y');
      await m.rename(at('tree'), at('moved'));
      expect(text(await m.readFile(at('moved/x/y.txt')))).toBe('y');
      expect(await m.stat(at('tree'))).toBeUndefined();
    });

    on('symlink, readlink (the target as written) and realpath (resolved)', async (m, at) => {
      await m.writeFile(at('target.txt'), 't');
      await m.symlink('target.txt', at('ln'));
      expect(await m.readlink(at('ln'))).toBe('target.txt');
      expect(await m.realpath(at('ln'))).toBe(await m.realpath(at('target.txt')));
      expect(text(await m.readFile(at('ln')))).toBe('t');
      expect(await codeOf(m.readlink(at('target.txt')))).toBe('EINVAL');
    });

    on('chmod sets the permission bits', async (m, at) => {
      await m.writeFile(at('x.sh'), 'echo');
      await m.chmod(at('x.sh'), 0o700);
      expect((await m.stat(at('x.sh')))?.mode).toBe(0o700);
    });

    on('reading what is not a file fails with its POSIX code', async (m, at) => {
      expect(await codeOf(m.readFile(at('missing.txt')))).toBe('ENOENT');
      await m.mkdir(at('adir'));
      expect(await codeOf(m.readFile(at('adir')))).toBe('EISDIR');
    });

    on('exec: stdout, stderr and the exit code, in the root by default', async (m) => {
      const r = await m.exec('echo out; echo err >&2; exit 3');
      expect(r).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
      const pwd = await m.exec('pwd');
      expect(pwd.stdout.trim()).toBe(await m.realpath(m.root));
    });

    on('exec: cwd, env, stdin and args', async (m, at) => {
      await m.mkdir(at('work'));
      expect((await m.exec('pwd', { cwd: 'work' })).stdout.trim()).toBe(await m.realpath(at('work')));
      expect((await m.exec('echo "$GREETING"', { env: { GREETING: 'hi there' } })).stdout).toBe('hi there\n');
      expect((await m.exec('cat', { stdin: 'from stdin\n' })).stdout).toBe('from stdin\n');
      expect((await m.exec('printf "%s|"', { args: ['a b', '$HOME', '*'] })).stdout).toBe('a b|$HOME|*|');
    });

    on('exec and the file methods see the same files', async (m, at) => {
      await m.writeFile(at('shared.txt'), 'from writeFile\n');
      expect((await m.exec('cat shared.txt')).stdout).toBe('from writeFile\n');
      await m.exec('mkdir -p made && echo from-exec > made/by.txt');
      expect(text(await m.readFile(at('made/by.txt')))).toBe('from-exec\n');
      expect((await m.list(at('made'))).map((e) => e.name)).toEqual(['by.txt']);
    });

    on("exec: a command past its own timeoutMs exits 124, as timeout does", async (m) => {
      const started = Date.now();
      const r = await m.exec('sleep 5; echo never', { timeoutMs: 400 });
      expect(r.exitCode).toBe(124);
      expect(r.stdout).toBe('');
      expect(Date.now() - started).toBeLessThan(4_000);
    });
  });
}
