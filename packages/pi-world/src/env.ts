import type { Context } from '@earendil-works/chord';
import {
  type BinaryReader,
  type DirReader,
  err,
  ExecutionError,
  type ExecutionEnv,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileKind,
  type FileWatcher,
  LineScanner,
  type LineScan,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  StreamDecoder,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from '@earendil-works/pi-durable/env';
import type { PathStat, WorkspaceMachine } from 'harness-world-hands/runtime';

/**
 * pi-durable's `ExecutionEnv` over a harness-world-hands `WorkspaceMachine`:
 * the files and the shell Pi's own tools (`CodingTools`) use, on a virtual
 * workspace (just-bash on an in-memory filesystem, in a worker leased to the
 * session) or on a Vercel Sandbox's `/workspace`. Nothing here reaches the
 * disk, the processes or the environment of the machine that drives the
 * session: every path and command goes to the machine.
 *
 * Each operation reaches the machine through `MachineAccess`, which decides
 * what the operation runs on (the call's own view of the workspace, or a
 * read of the committed files) and may refuse it.
 *
 * Differences from a real disk, as `ExecutionEnv` allows them:
 *
 * - A command's output arrives when it ends, stdout first, then stderr (one
 *   `onOutput` each); the shell is just-bash's (no network, no real binaries).
 * - A reader (`openBinaryReader`, `openTextLineReader`) holds the file as it
 *   was when it was opened; a directory reader lists the names at open and
 *   skips those that are gone when it reaches them.
 * - `watch` compares snapshots of the watched paths (`mode: 'polling'`).
 * - `inheritEnv` inherits nothing: a command gets only the variables it is
 *   given (there is no host environment to inherit).
 */

/** How an environment reaches its machine, one operation at a time. */
export interface MachineAccess {
  /**
   * Run `work` on the machine. `write`: the operation may change files or
   * runs a command. Throws to refuse the operation (its message is what the
   * tool reports).
   */
  use<T>(mode: 'read' | 'write', work: (machine: WorkspaceMachine) => Promise<T>): Promise<T>;
}

export interface MachineEnvOptions {
  /** The file namespace (`ExecutionEnv.id`): equal ids see the same files. */
  id: string;
  /** The working directory, an absolute path on the machine. */
  cwd: string;
  access: MachineAccess;
  /** Where temporary files and spilled output go. Default `/tmp`. */
  tmp?: string;
  /**
   * An operation the machine cut off: a command past its time limit, its
   * worker restarted, the call cancelled or out of memory. On a
   * transactional machine the call it was part of changed nothing.
   */
  onCutOff?: (error: Error) => void;
  /**
   * Whether a call the machine cut off changed nothing (a virtual
   * workspace rolls it back), so the command's error says so. Default true.
   * False on a Sandbox's Drive: a stopped command may have half-run.
   */
  transactional?: boolean;
  /** How often `watch` compares snapshots, in ms. Default 100. */
  pollMs?: number;
}

/** The error codes a machine fails a call with when it cut the operation off (its changes are rolled back). */
const CUT_OFF = new Set(['ETIMEDOUT', 'EINTR', 'ENOMEM', 'EGONE']);

const MAX_TIMEOUT_MS = 2_147_483_647;
const utf8 = new TextEncoder();
/** Like Node's `utf8` decoding: a byte-order mark stays in the text. */
const keepBom = () => new TextDecoder('utf-8', { ignoreBOM: true });

/** A machine error's POSIX code: its `code`, or the prefix just-bash puts in its message (`ENOENT: ...`). */
function posixCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string') return code;
  const match = /^([A-Z][A-Z0-9_]+):/.exec(String((error as { message?: unknown } | undefined)?.message ?? ''));
  return match?.[1];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const FILE_CODES: Record<string, FileErrorCode> = {
  ENOENT: 'not_found',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  ENOTDIR: 'not_directory',
  EISDIR: 'is_directory',
  EINVAL: 'invalid',
  ABORT_ERR: 'aborted',
};

function toFileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error;
  const code = posixCode(error);
  const cause = error instanceof Error ? error : undefined;
  if ((error as { name?: unknown } | undefined)?.name === 'AbortError') return new FileError('aborted', message(error), path, cause);
  return new FileError((code && FILE_CODES[code]) || 'unknown', message(error), path, cause);
}

const aborted = (context: Context, path?: string): Result<never, FileError> | undefined =>
  context.abortSignal?.aborted ? err(new FileError('aborted', 'aborted', path)) : undefined;

const closed = (what: string, path: string) => err<never, FileError>(new FileError('invalid', `${what} is closed`, path));

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1) || '/';

/** `/`-separated segments joined, with `.` and `..` resolved (it is all one virtual tree: `..` stops at the root). */
function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out.at(-1) !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else out.push(seg);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

const kindOf = (s: PathStat): FileKind => s.type;
const infoOf = (path: string, s: PathStat): FileInfo => ({ name: baseName(path), path, kind: kindOf(s), size: s.size, mtimeMs: s.mtimeMs });

/** A program name as one shell word. */
const shellWord = (word: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** pi-durable's `ExecutionEnv` on a `WorkspaceMachine` (see the module comment). */
export class MachineEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  private readonly access: MachineAccess;
  private readonly tmp: string;
  private readonly onCutOff: ((error: Error) => void) | undefined;
  private readonly transactional: boolean;
  private readonly pollMs: number;
  private readonly temps = new Set<string>();
  private readonly running = new Set<AbortController>();

  constructor(options: MachineEnvOptions) {
    this.id = options.id;
    this.cwd = normalize(options.cwd);
    this.access = options.access;
    this.tmp = options.tmp ?? '/tmp';
    this.onCutOff = options.onCutOff;
    this.transactional = options.transactional ?? true;
    this.pollMs = options.pollMs ?? 100;
  }

  /** `path` as an absolute path on the machine: from the working directory, `~` the workspace's home (its root). */
  private resolve(path: string): string {
    let p = path;
    if (p.startsWith('file://')) {
      try {
        p = decodeURIComponent(new URL(p).pathname);
      } catch {}
    }
    if (p === '~' || p.startsWith('~/')) p = `${this.home()}${p.slice(1)}`;
    return normalize(p.startsWith('/') ? p : `${this.cwd}/${p}`);
  }

  /** The workspace root: the first segment of the working directory under it (`/workspace`). */
  private home(): string {
    const first = this.cwd.split('/')[1];
    return first ? `/${first}` : '/';
  }

  /** Run an operation on the machine; an error that cut it off is reported (`onCutOff`). */
  private async use<T>(mode: 'read' | 'write', work: (m: WorkspaceMachine) => Promise<T>): Promise<T> {
    try {
      return await this.access.use(mode, work);
    } catch (error) {
      const code = posixCode(error);
      if (code && CUT_OFF.has(code)) this.onCutOff?.(error instanceof Error ? error : new Error(message(error)));
      throw error;
    }
  }

  private async fileOp<T>(path: string, context: Context, mode: 'read' | 'write', work: (m: WorkspaceMachine) => Promise<T>): Promise<Result<T, FileError>> {
    const stop = aborted(context, path);
    if (stop) return stop;
    try {
      const value = await this.use(mode, work);
      return aborted(context, path) ?? ok(value);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(this.resolve(path));
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(normalize(parts.join('/')));
  }

  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const p = this.resolve(path);
    return this.fileOp(p, context, 'read', async (m) => keepBom().decode(await m.readFile(p)));
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const p = this.resolve(path);
    const bytes = await this.fileOp(p, context, 'read', (m) => m.readFile(p));
    if (!bytes.ok) return bytes;
    return ok(new BytesLineReader(bytes.value, p));
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    const lines: string[] = [];
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        lines.push(line.value.text);
      }
      return ok(lines);
    } finally {
      await opened.value.close(context);
    }
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const p = this.resolve(path);
    return this.fileOp(p, context, 'read', (m) => m.readFile(p));
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const p = this.resolve(path);
    const opened = await this.fileOp(p, context, 'read', async (m) => {
      if (options?.noFollow && (await m.lstat(p))?.type === 'symlink') throw new FileError('invalid', 'Refusing to follow a symbolic link', p);
      const s = await m.stat(p);
      if (!s) throw new FileError('not_found', `ENOENT: no such file or directory, open '${p}'`, p);
      if (s.type === 'directory') throw new FileError('is_directory', 'EISDIR: illegal operation on a directory, read', p);
      if (s.type !== 'file') throw new FileError('invalid', 'Not a regular file', p);
      return { bytes: await m.readFile(p), stat: s };
    });
    if (!opened.ok) return opened;
    return ok(new BytesReader(opened.value.bytes, p, opened.value.stat.mtimeMs));
  }

  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const p = this.resolve(path);
    return this.fileOp(p, context, 'write', (m) => m.writeFile(p, content));
  }

  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const p = this.resolve(path);
    return this.fileOp(p, context, 'write', (m) => m.writeFile(p, content, { append: true }));
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const p = this.resolve(path);
    if (!Number.isSafeInteger(size) || size < 0) return err(new FileError('invalid', 'File size must be a non-negative safe integer', p));
    return this.fileOp(p, context, 'write', async (m) => {
      const bytes = await m.readFile(p);
      const out = new Uint8Array(size);
      out.set(bytes.subarray(0, Math.min(size, bytes.length)));
      await m.writeFile(p, out);
    });
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const p = this.resolve(path);
    return this.fileOp(p, context, 'read', async (m) => {
      const s = await m.stat(p);
      if (!s) throw new FileError('not_found', `ENOENT: no such file or directory, open '${p}'`, p);
      if (s.type === 'directory') throw new FileError('is_directory', 'Is a directory', p);
    });
  }

  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const from = this.resolve(sourcePath);
    const to = this.resolve(destinationPath);
    return this.fileOp(from, context, 'write', (m) => m.rename(from, to));
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const p = this.resolve(path);
    return this.fileOp(p, context, 'read', async (m) => {
      const s = await m.lstat(p);
      if (!s) throw new FileError('not_found', `ENOENT: no such file or directory, lstat '${p}'`, p);
      return infoOf(p, s);
    });
  }

  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const p = this.resolve(path);
    return this.fileOp(p, context, 'read', async (m) => {
      const out: FileInfo[] = [];
      for (const entry of await m.list(p)) {
        const child = p === '/' ? `/${entry.name}` : `${p}/${entry.name}`;
        const s = await m.lstat(child);
        if (s) out.push(infoOf(child, s));
      }
      return out;
    });
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const p = this.resolve(path);
    const names = await this.fileOp(p, context, 'read', async (m) => {
      const s = await m.stat(p);
      if (!s) throw new FileError('not_found', `ENOENT: no such file or directory, opendir '${p}'`, p);
      if (s.type !== 'directory') throw new FileError('not_directory', `ENOTDIR: not a directory, opendir '${p}'`, p);
      return (await m.list(p)).map((e) => e.name);
    });
    if (!names.ok) return names;
    return ok(new NamesDirReader(this, p, names.value));
  }

  /** The entries of `names` under `dir` that are still there (a directory reader's page). */
  async infos(dir: string, names: string[], context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.fileOp(dir, context, 'read', async (m) => {
      const out: FileInfo[] = [];
      for (const name of names) {
        const child = dir === '/' ? `/${name}` : `${dir}/${name}`;
        const s = await m.lstat(child);
        if (s) out.push(infoOf(child, s));
      }
      return out;
    });
  }

  async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    const stop = aborted(context);
    if (stop) return stop;
    const resolved = targets.map((t) => ({ ...t, path: this.resolve(t.path) }));
    const take = () => this.use('read', (m) => snapshotTargets(m, resolved));
    let before: Map<string, string>;
    try {
      before = await take();
    } catch (error) {
      return err(toFileError(error));
    }
    return ok(new PollingWatcher(take, before, onChange, this.pollMs));
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const p = this.resolve(path);
    return this.fileOp(p, context, 'read', (m) => m.realpath(p));
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);
    if (info.ok) return ok(true);
    if (info.error.code === 'not_found') return ok(false);
    return err(info.error);
  }

  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const p = this.resolve(path);
    return this.fileOp(p, context, 'write', (m) => m.mkdir(p, { recursive: options?.recursive ?? true }));
  }

  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const p = this.resolve(path);
    return this.fileOp(p, context, 'write', (m) => m.remove(p, { recursive: options?.recursive ?? false, force: options?.force ?? false }));
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const dir = `${this.tmp}/${prefix ?? 'tmp-'}${newId().slice(0, 8)}`;
    const made = await this.fileOp(dir, context, 'write', (m) => m.mkdir(dir, { recursive: true }));
    if (!made.ok) return made;
    this.temps.add(dir);
    return ok(dir);
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir('tmp-', context);
    if (!dir.ok) return dir;
    const file = `${dir.value}/${options?.prefix ?? ''}${newId()}${options?.suffix ?? ''}`;
    const made = await this.fileOp(file, context, 'write', (m) => m.writeFile(file, ''));
    return made.ok ? ok(file) : made;
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError('aborted', 'aborted'));
    const timeout = options?.timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) return err(new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds'));
    if (timeout !== undefined && timeout * 1000 > MAX_TIMEOUT_MS) return err(new ExecutionError('timeout', `Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`));
    const timeoutMs = timeout === undefined ? undefined : timeout * 1000;
    const cwd = options?.cwd ? this.resolve(options.cwd) : this.cwd;
    let script: string;
    let args: string[] | undefined;
    if (typeof command === 'string') script = command;
    else {
      const [program, ...rest] = command;
      if (program === undefined) return err(new ExecutionError('spawn_error', 'Empty argv: no program to run'));
      script = shellWord(program);
      args = rest;
    }
    const controller = new AbortController();
    this.running.add(controller);
    const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, controller.signal]) : controller.signal;
    const started = Date.now();
    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await this.use('write', async (m) => {
        if ((await m.stat(cwd))?.type !== 'directory') {
          throw new ExecutionError('spawn_error', `Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
        }
        return m.exec(script, { cwd, env: { ...options?.env }, ...(args ? { args } : {}), signal, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      });
    } catch (error) {
      if (context.abortSignal?.aborted) return err(new ExecutionError('aborted', 'aborted'));
      if (error instanceof ExecutionError) return err(error);
      const code = posixCode(error);
      if (code && CUT_OFF.has(code)) return err(new ExecutionError('unknown', this.transactional ? `${message(error)}; nothing this call changed was kept` : message(error), error instanceof Error ? error : undefined));
      return err(new ExecutionError(error instanceof FileError ? 'shell_unavailable' : 'unknown', message(error), error instanceof Error ? error : undefined));
    } finally {
      this.running.delete(controller);
    }
    if (args && result.exitCode === 127 && /: command not found\n?$/.test(result.stderr)) return err(new ExecutionError('spawn_error', result.stderr.trim()));
    let spillPath: string | undefined;
    const spill = options?.spill;
    if (spill) {
      const all = result.stdout + result.stderr;
      const bytes = utf8.encode(all).length;
      const lines = all === '' ? 0 : all.split('\n').length - (all.endsWith('\n') ? 1 : 0);
      if (bytes > spill.afterBytes || lines > spill.afterLines) {
        const file = await this.createTempFile({ prefix: 'pi-output-', suffix: '.log' }, context);
        if (file.ok) {
          const written = await this.writeFile(file.value, all, context);
          if (written.ok) spillPath = file.value;
        }
      }
    }
    try {
      if (result.stdout) options?.onOutput?.(result.stdout, context, { stream: 'stdout' });
      if (result.stderr) options?.onOutput?.(result.stderr, context, { stream: 'stderr' });
    } catch (error) {
      return err(new ExecutionError('callback_error', message(error), error instanceof Error ? error : undefined));
    }
    const interrupted =
      timeoutMs !== undefined && result.exitCode === 124 && Date.now() - started >= timeoutMs
        ? new ExecutionError('timeout', `timeout:${timeout}`)
        : context.abortSignal?.aborted || controller.signal.aborted
          ? new ExecutionError('aborted', 'aborted')
          : undefined;
    if (interrupted) {
      if (spillPath !== undefined) interrupted.spillPath = spillPath;
      return err(interrupted);
    }
    return ok({ exitCode: result.exitCode, ...(spillPath !== undefined ? { spillPath } : {}) });
  }

  async cleanup(_context: Context): Promise<void> {
    for (const c of this.running) c.abort();
    this.running.clear();
    const temps = [...this.temps];
    this.temps.clear();
    for (const dir of temps) await this.use('write', (m) => m.remove(dir, { recursive: true, force: true })).catch(() => {});
  }
}

/** A text file's lines, from its bytes as they were when it was opened. */
class BytesLineReader implements TextLineReader {
  private buffered: string;
  private done = false;
  private shut = false;

  constructor(bytes: Uint8Array, private readonly path: string) {
    const decoder = new StreamDecoder();
    this.buffered = decoder.decode(bytes) + decoder.decode();
  }

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const stop = aborted(context, this.path);
    if (stop) return stop;
    if (this.shut) return err(new FileError('invalid', 'Text line reader is closed', this.path));
    const newline = this.buffered.indexOf('\n');
    if (newline !== -1) {
      const text = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      return ok({ text, terminated: true });
    }
    if (this.done || this.buffered.length === 0) {
      this.done = true;
      return ok(undefined);
    }
    const text = this.buffered;
    this.buffered = '';
    this.done = true;
    return ok({ text, terminated: false });
  }

  async close(_context: Context): Promise<void> {
    this.shut = true;
    this.buffered = '';
  }
}

/** Positional reads of a file as it was when it was opened (a rename or a rewrite of its path does not change it). */
class BytesReader implements BinaryReader {
  private shut = false;

  constructor(
    private bytes: Uint8Array,
    private readonly path: string,
    private readonly mtimeMs: number
  ) {}

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    const stop = aborted(context, this.path);
    if (stop) return stop;
    if (this.shut) return closed('Binary reader', this.path);
    return ok({ name: baseName(this.path), path: this.path, kind: 'file', size: this.bytes.length, mtimeMs: this.mtimeMs });
  }

  async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const stop = aborted(context, this.path);
    if (stop) return stop;
    if (this.shut) return closed('Binary reader', this.path);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return err(new FileError('invalid', 'Offset and length must be non-negative safe integers', this.path));
    }
    return ok(this.bytes.slice(Math.min(offset, this.bytes.length), Math.min(offset + length, this.bytes.length)));
  }

  async scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>> {
    const stop = aborted(context, this.path);
    if (stop) return stop;
    if (this.shut) return closed('Binary reader', this.path);
    let scanner: LineScanner;
    try {
      scanner = new LineScanner(options.startLine, options.endLine);
    } catch {
      return err(new FileError('invalid', 'Invalid line range', this.path));
    }
    scanner.push(this.bytes);
    return ok(scanner.finish());
  }

  async close(_context: Context): Promise<void> {
    this.shut = true;
    this.bytes = new Uint8Array(0);
  }
}

/** A directory's entries in pages, from the names it had when it was opened (one that is gone when its page is read is skipped). */
class NamesDirReader implements DirReader {
  private at = 0;
  private shut = false;

  constructor(
    private readonly env: MachineEnv,
    private readonly path: string,
    private readonly names: string[]
  ) {}

  async next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const stop = aborted(context, this.path);
    if (stop) return stop;
    if (this.shut) return closed('Directory reader', this.path);
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError('invalid', 'maxEntries must be a positive safe integer', this.path));
    const entries: FileInfo[] = [];
    while (this.at < this.names.length && entries.length < maxEntries) {
      const page = this.names.slice(this.at, this.at + (maxEntries - entries.length));
      this.at += page.length;
      const infos = await this.env.infos(this.path, page, context);
      if (!infos.ok) return infos;
      entries.push(...infos.value);
    }
    return ok({ entries, done: this.at >= this.names.length });
  }

  async close(_context: Context): Promise<void> {
    this.shut = true;
  }
}

/** Whether `rel` (a path below a watched directory) goes through an excluded entry. */
function excluded(rel: string, exclude: WatchTarget['exclude']): boolean {
  if (!exclude) return false;
  return rel.split('/').some((seg) => (exclude.hidden && seg.startsWith('.')) || (exclude.names?.includes(seg) ?? false));
}

const stamp = (s: PathStat) => `${s.type}:${s.size}:${s.mtimeMs}:${s.mode}`;

/** What each watched path holds, as `stamp`s by path (a missing target is `-`). */
async function snapshotTargets(m: WorkspaceMachine, targets: readonly (WatchTarget & { path: string })[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const t of targets) {
    const s = await m.stat(t.path);
    out.set(t.path, s ? stamp(s) : '-');
    if (s?.type !== 'directory') continue;
    if (t.recursive) {
      for (const e of await m.walk(t.path)) {
        if (excluded(e.path.slice(t.path.length + 1), t.exclude)) continue;
        out.set(e.path, stamp(e));
      }
    } else {
      for (const e of await m.list(t.path)) {
        if (excluded(e.name, t.exclude)) continue;
        const child = t.path === '/' ? `/${e.name}` : `${t.path}/${e.name}`;
        const cs = await m.stat(child);
        if (cs) out.set(child, stamp(cs));
      }
    }
  }
  return out;
}

/** A watcher that compares snapshots of its targets every `pollMs`. */
class PollingWatcher implements FileWatcher {
  readonly mode = 'polling' as const;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> = Promise.resolve();

  constructor(
    private readonly take: () => Promise<Map<string, string>>,
    private before: Map<string, string>,
    private readonly onChange: (change: WatchChange) => void,
    private readonly pollMs: number
  ) {
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.polling = this.poll().finally(() => this.schedule());
    }, this.pollMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async poll(): Promise<void> {
    let after: Map<string, string>;
    try {
      after = await this.take();
    } catch (error) {
      if (this.stopped) return;
      this.stopped = true;
      this.onChange({ error: toFileError(error) });
      return;
    }
    if (this.stopped) return;
    const paths = new Set<string>();
    // A change and the directory it is in: a directory replaced by one with the same stamp still reads as changed.
    const add = (path: string) => {
      paths.add(path);
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent && (after.has(parent) || this.before.has(parent))) paths.add(parent);
    };
    for (const [path, s] of after) if (this.before.get(path) !== s) add(path);
    for (const path of this.before.keys()) if (!after.has(path)) add(path);
    this.before = after;
    if (paths.size) this.onChange({ paths: [...paths].sort() });
  }

  async close(_context: Context): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.polling.catch(() => {});
  }
}
