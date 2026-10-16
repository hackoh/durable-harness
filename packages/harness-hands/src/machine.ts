/**
 * The machine a workspace's tools run on: a filesystem and a shell, where
 * every command and file the model picks goes. Never the disk, the processes
 * or the environment of the machine that drives the session.
 *
 * `WorkspaceMachine` is what a harness's tool code uses (each harness's own
 * tools, written against it). Two implementations of it here, both just-bash
 * on an in-memory filesystem, with an explicit command list
 * (`VIRTUAL_COMMANDS`):
 *
 * - in a worker thread leased to one session, with an empty environment
 *   (the default on Node, worker.ts): the shell runs in a realm of its own,
 *   so just-bash's defense-in-depth can be on there (it patches the globals
 *   of the realm it runs in, which the realm that serves requests cannot
 *   afford), and a long command holds that thread, not the one serving every
 *   other session. just-bash's `normal` profile for counts (a loop, a
 *   script's commands), its `hardened` sizes (output, strings, input): a
 *   command's time is bounded by its deadline, at which the worker ends;
 * - in this realm (browsers, Cloudflare Workers, and Node when a worker
 *   cannot start), with defense-in-depth off and the `hardened` profile:
 *   nothing can stop a command that never yields here, so its counts are
 *   capped too.
 *
 * A Sandbox can implement the same interface (exec and files over its API).
 */

/** What a command printed and how it exited. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Working directory (virtual); default the workspace root. */
  cwd?: string;
  /** Variables for this command only (nothing of the host's environment is ever there). */
  env?: Record<string, string>;
  /** Argv entries appended to the first command, past shell parsing (like `spawn(cmd, args)`). */
  args?: string[];
  /** Standard input. */
  stdin?: string;
  signal?: AbortSignal;
  /** Stop the command after this long (as `signal` would): exit code 124, like `timeout`. */
  timeoutMs?: number;
}

export type PathType = 'file' | 'directory' | 'symlink';

export interface PathStat {
  type: PathType;
  size: number;
  /** Permission bits (`0o644`, `0o755`). */
  mode: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  type: PathType;
}

/** One path under a directory (`walk`): its type with links followed, and whether it is a link. */
export interface WalkEntry extends PathStat {
  path: string;
  /** The path itself is a symbolic link (`type` is its target's; a dangling link is left out). */
  link?: true;
}

/**
 * A filesystem and a shell. Paths are absolute virtual paths (a relative
 * path is taken from the root). Methods reject on failure with an Error
 * whose `code` is the POSIX one when there is one (`ENOENT`, `EISDIR`, ...).
 */
export interface WorkspaceMachine {
  /** The workspace root: `/workspace`. */
  readonly root: string;
  /** Where commands run: `worker` (an isolated thread), `process` (this realm), or a Sandbox's own. */
  readonly isolation: string;
  /** Its files are gone (the thread it ran in was restarted): make a new one. */
  readonly lost: boolean;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  /** Write a file, creating its parent directories. An existing file keeps its mode unless `mode` is given. */
  writeFile(path: string, content: string | Uint8Array, options?: { mode?: number; append?: boolean }): Promise<void>;
  /** With links followed; undefined when nothing is there. */
  stat(path: string): Promise<PathStat | undefined>;
  /** The path itself (a link is a link); undefined when nothing is there. */
  lstat(path: string): Promise<PathStat | undefined>;
  /** A directory's entries, sorted by name. */
  list(dir: string): Promise<DirEntry[]>;
  /** Every path under `dir` (default the root), recursively, sorted. */
  walk(dir?: string): Promise<WalkEntry[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  /** Free it (its files are gone). Also done when it is garbage-collected. */
  dispose(): void;
}

/** A file's bytes and mode, as the transaction operations move them. */
export type FileBytes = [path: string, bytes: Uint8Array, mode: number];

/**
 * The operations both machines run, on just-bash. Self-contained (it refers
 * to nothing outside itself, not even a helper of a bundler), because the
 * worker runs its source text (`machineOps.toString()`): the same code runs
 * in this realm and in the worker.
 *
 * Besides the filesystem and the shell, the transaction operations the
 * document-backed workspace needs, done where the files are so a call moves
 * only what changed: `apply` (make files hold given contents), `checkpoint`
 * (remember the files under the root), `diff` (what changed since, after
 * making links copies: the manifest holds no links), `rollback`, `release`.
 */
export function machineOps(jb: any, config: { defenseInDepth: unknown; profile: 'normal' | 'hardened'; limits?: Record<string, number> }) {
  const machines = new Map<string, any>();
  const encoder = new TextEncoder();
  const bytesOf = (c: string | Uint8Array): Uint8Array => (typeof c === 'string' ? encoder.encode(c) : c);
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const get = (id: string) => {
    const m = machines.get(id);
    if (!m) throw Object.assign(new Error('this workspace is gone'), { code: 'EGONE' });
    return m;
  };
  const abs = (m: any, path: string): string => {
    const p = path.startsWith('/') ? path : `${m.root}/${path}`;
    const out: string[] = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return `/${out.join('/')}`;
  };
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  /** A full filesystem or a file over the cap, as an error that says so (undefined for any other error). */
  const capError = (err: unknown): Error | undefined => {
    const message = String((err as Error)?.message ?? err);
    if (message.startsWith('ENOSPC')) return Object.assign(new Error(`${message}: the workspace is full. Delete files to make room.`), { code: 'ENOSPC' });
    if (message.startsWith('EFBIG')) return Object.assign(new Error(message), { code: 'EFBIG' });
    return undefined;
  };
  /** Run `fn` with the file size cap off: the machine is made to hold what a record has. */
  const restoring = async <T>(m: any, fn: () => Promise<T>): Promise<T> => {
    m.fs.uncapped = true;
    try {
      return await fn();
    } finally {
      m.fs.uncapped = false;
    }
  };
  /** Run a write, its cap errors saying what they are. */
  const capped = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw capError(err) ?? err;
    }
  };
  const typeOf = (s: any) => (s.isSymbolicLink ? 'symlink' : s.isDirectory ? 'directory' : 'file');
  const statOf = (s: any) => ({ type: typeOf(s), size: s.size, mode: s.mode & 0o7777, mtimeMs: s.mtime instanceof Date ? s.mtime.getTime() : 0 });
  const under = (m: any, p: string) => p.startsWith(`${m.root}/`);
  /** Regular files under the root, links followed: path to bytes and mode. */
  const files = async (m: any): Promise<Map<string, { bytes: Uint8Array; mode: number }>> => {
    const out = new Map();
    for (const p of m.fs.getAllPaths()) {
      if (!under(m, p)) continue;
      const s = await m.fs.stat(p).catch(() => undefined);
      if (!s?.isFile) continue;
      out.set(p, { bytes: await m.fs.readFileBuffer(p), mode: s.mode & 0o7777 });
    }
    return out;
  };
  const put = async (m: any, p: string, bytes: Uint8Array, mode: number) => {
    await m.fs.mkdir(parent(p), { recursive: true });
    await m.fs.writeFile(p, bytes);
    // just-bash leaves a written file at 0o644, whatever it was: set the mode after the write.
    await m.fs.chmod(p, mode);
  };
  /** Make every link under the root a copy of the file it names, or nothing (a dangling link, a link to a directory). */
  const unlink = async (m: any) => {
    for (const p of m.fs.getAllPaths()) {
      if (!under(m, p)) continue;
      if (!(await m.fs.lstat(p).catch(() => undefined))?.isSymbolicLink) continue;
      const target = await m.fs.stat(p).catch(() => undefined);
      const file = target?.isFile ? { bytes: await m.fs.readFileBuffer(p), mode: target.mode & 0o7777 } : undefined;
      await m.fs.rm(p, { force: true });
      if (file) await put(m, p, file.bytes, file.mode);
    }
  };
  return {
    async create(id: string, options: { root: string; maxBytes: number; maxFileBytes: number; timeoutMs: number; commands: readonly string[] }) {
      const { maxFileBytes } = options;
      const sizeOf = (c: string | Uint8Array, o: unknown) => {
        if (typeof c !== 'string') return c.length;
        const enc = typeof o === 'string' ? o : (o as { encoding?: string } | undefined)?.encoding;
        return enc && enc !== 'utf8' && enc !== 'utf-8' ? c.length : encoder.encode(c).length;
      };
      const tooLarge = (p: string) =>
        Object.assign(new Error(`EFBIG: ${p} would be over the workspace's largest file size (${maxFileBytes} bytes)`), { code: 'EFBIG' });
      // Every write goes through writeFileSync (writeFile calls it) or appendFile: the file size cap is
      // there. Off while the machine is made to hold what a record has (`apply`, `rollback`).
      // (No class fields: this function's source runs as written in the worker, whatever transpiled it.)
      const Base: new (files: unknown, options: { maxTotalBytes: number }) => any = jb.InMemoryFs;
      class CappedFs extends Base {
        writeFileSync(p: string, c: string | Uint8Array, o?: unknown, meta?: unknown) {
          if (!this.uncapped && sizeOf(c, o) > maxFileBytes) throw tooLarge(p);
          return super.writeFileSync(p, c, o, meta);
        }
        async appendFile(p: string, c: string | Uint8Array, o?: unknown) {
          const before = await this.stat(p).then((s: { size: number }) => s.size, () => 0);
          if (!this.uncapped && before + sizeOf(c, o) > maxFileBytes) throw tooLarge(p);
          return super.appendFile(p, c, o);
        }
      }
      const fs = new CappedFs(undefined, { maxTotalBytes: options.maxBytes });
      await fs.mkdir(options.root, { recursive: true });
      const bash = new jb.Bash({
        fs,
        cwd: options.root,
        commands: [...options.commands],
        executionLimitProfile: config.profile,
        // The command's own deadline; a worker that runs past it anyway is ended (worker.ts).
        executionLimits: { ...config.limits, maxExecutionTimeMs: options.timeoutMs },
        defenseInDepth: config.defenseInDepth,
      });
      machines.set(id, { fs, bash, root: options.root, checkpoint: undefined });
    },
    dispose(id: string) {
      machines.delete(id);
    },
    async exec(id: string, command: string, options: { cwd?: string; env?: Record<string, string>; args?: string[]; stdin?: string } = {}, signal?: AbortSignal) {
      const m = get(id);
      try {
        const r = await m.bash.exec(command, {
          ...(options.cwd ? { cwd: abs(m, options.cwd) } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.args ? { args: options.args } : {}),
          ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
          ...(signal ? { signal } : {}),
        });
        // just-bash stopped it at the machine's time limit: it says so, last on stderr, and exits 124. (Its
        // deadline fires from a timer as well as from its own checks, and a timer can fire early, so how
        // long the command took cannot tell this from a command that exits 124 itself. A command that
        // prints that line itself and exits 124 is taken at its word: it fails the same way.)
        const limited = r.exitCode === 124 && /(?:^|\n)bash: [^\n]* exceeded (?:its execution deadline|execution deadline \(\d+ms\))\n$/.test(r.stderr);
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ...(limited ? { limited: true } : {}) };
      } catch (err) {
        // A full workspace (or a file over the size cap) can escape just-bash as a thrown error: it is the command's failure.
        const full = capError(err);
        if (!full) throw err;
        return { exitCode: 1, stdout: '', stderr: `${full.message}\n` };
      }
    },
    async readFile(id: string, path: string) {
      const m = get(id);
      return m.fs.readFileBuffer(abs(m, path));
    },
    async writeFile(id: string, path: string, content: string | Uint8Array, options: { mode?: number; append?: boolean } = {}) {
      const m = get(id);
      const p = abs(m, path);
      const before = await m.fs.stat(p).catch(() => undefined);
      await m.fs.mkdir(parent(p), { recursive: true });
      await capped(() => (options.append ? m.fs.appendFile(p, bytesOf(content)) : m.fs.writeFile(p, bytesOf(content))));
      const mode = options.mode ?? (before?.isFile ? before.mode & 0o7777 : undefined);
      if (mode !== undefined) await m.fs.chmod(p, mode);
    },
    async stat(id: string, path: string) {
      const m = get(id);
      const s = await m.fs.stat(abs(m, path)).catch(() => undefined);
      return s ? statOf(s) : undefined;
    },
    async lstat(id: string, path: string) {
      const m = get(id);
      const s = await m.fs.lstat(abs(m, path)).catch(() => undefined);
      return s ? statOf(s) : undefined;
    },
    async list(id: string, dir: string) {
      const m = get(id);
      const p = abs(m, dir);
      const out = [];
      for (const name of [...(await m.fs.readdir(p))].sort()) {
        const s = await m.fs.lstat(`${p === '/' ? '' : p}/${name}`).catch(() => undefined);
        if (s) out.push({ name, type: typeOf(s) });
      }
      return out;
    },
    async walk(id: string, dir?: string) {
      const m = get(id);
      const root = abs(m, dir ?? m.root);
      const prefix = root === '/' ? '/' : `${root}/`;
      const out = [];
      for (const p of [...m.fs.getAllPaths()].sort()) {
        if (!p.startsWith(prefix) || p === root) continue;
        const l = await m.fs.lstat(p).catch(() => undefined);
        if (!l) continue;
        const s = l.isSymbolicLink ? await m.fs.stat(p).catch(() => undefined) : l;
        if (!s) continue;
        out.push({ path: p, ...statOf(s), ...(l.isSymbolicLink ? { link: true } : {}) });
      }
      return out;
    },
    async mkdir(id: string, path: string, options: { recursive?: boolean } = {}) {
      const m = get(id);
      await m.fs.mkdir(abs(m, path), { recursive: options.recursive ?? false });
    },
    async remove(id: string, path: string, options: { recursive?: boolean; force?: boolean } = {}) {
      const m = get(id);
      await m.fs.rm(abs(m, path), options);
    },
    async rename(id: string, from: string, to: string) {
      const m = get(id);
      await m.fs.mv(abs(m, from), abs(m, to));
    },
    async symlink(id: string, target: string, path: string) {
      const m = get(id);
      await m.fs.symlink(target, abs(m, path));
    },
    async readlink(id: string, path: string) {
      const m = get(id);
      return m.fs.readlink(abs(m, path));
    },
    async realpath(id: string, path: string) {
      const m = get(id);
      return m.fs.realpath(abs(m, path));
    },
    async chmod(id: string, path: string, mode: number) {
      const m = get(id);
      await m.fs.chmod(abs(m, path), mode);
    },
    /** Every regular file under the root. */
    async snapshot(id: string) {
      const out = [];
      for (const [p, f] of await files(get(id))) out.push([p, f.bytes, f.mode]);
      return out;
    },
    /** Remove `removes`, write `writes` (bytes and mode), and set `chmods` (mode only). */
    async apply(id: string, writes: [string, Uint8Array, number][], removes: string[], chmods: [string, number][] = []) {
      const m = get(id);
      await restoring(m, async () => {
        for (const p of removes) await m.fs.rm(p, { force: true });
        for (const [p, bytes, mode] of writes) await capped(() => put(m, p, bytes, mode));
        for (const [p, mode] of chmods) await m.fs.chmod(p, mode);
      });
    },
    async checkpoint(id: string) {
      const m = get(id);
      m.checkpoint = await files(m);
    },
    /** What changed under the root since the checkpoint (`null`: removed); with `unlink`, links become copies first. */
    async diff(id: string, options: { unlink?: boolean } = {}) {
      const m = get(id);
      if (!m.checkpoint) throw new Error('diff without a checkpoint');
      if (options.unlink) await unlink(m);
      const after = await files(m);
      const out = [];
      for (const [p, f] of after) {
        const b = m.checkpoint.get(p);
        if (!b || b.mode !== f.mode || !sameBytes(b.bytes, f.bytes)) out.push([p, f.bytes, f.mode]);
      }
      for (const p of m.checkpoint.keys()) if (!after.has(p)) out.push([p, null, 0]);
      return out;
    },
    /** Put the files under the root back to the checkpoint (links a call made go first: a checkpoint holds none). */
    async rollback(id: string) {
      const m = get(id);
      const before = m.checkpoint;
      if (!before) return;
      await restoring(m, async () => {
        for (const p of m.fs.getAllPaths()) {
          if (under(m, p) && (await m.fs.lstat(p).catch(() => undefined))?.isSymbolicLink) await m.fs.rm(p, { force: true });
        }
        const now = await files(m);
        for (const p of now.keys()) if (!before.has(p)) await m.fs.rm(p, { force: true });
        for (const [p, f] of before) {
          const n = now.get(p);
          if (!n || n.mode !== f.mode || !sameBytes(n.bytes, f.bytes)) await put(m, p, f.bytes, f.mode);
        }
      });
    },
    async release(id: string) {
      get(id).checkpoint = undefined;
    },
  };
}

export type MachineOps = ReturnType<typeof machineOps>;
export type MachineOp = keyof MachineOps;
