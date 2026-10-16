/**
 * The per-attach helper (docs/workspaces.md §5.4 "Privilege split", §4.1): the
 * process that serves `ENV_CALL`, the session's `/workspace` as files and
 * commands, for a Function-tier runtime's tools (`RemoteMachine`, `../env.ts`).
 *
 * The relay starts it on an attach's first `ENV_CALL` and kills it when the
 * attach ends. In the privileged tier it starts through the relay's root shim:
 * into the session cgroup's `env` leaf first, then into a mount namespace of
 * its own where the CLIs' state dirs (`codex-home`, `config`) are hidden under
 * an empty read-only tmpfs, then `setpriv` down to the unprivileged user with
 * `env -i` and the relay's allowlist as its whole environment. So everything
 * here runs as that user, and the guard on paths is uid separation, not a
 * check on the path: a model-made symlink `/workspace/x ->
 * /opt/dh/relay-<hash>.mjs` is followed like any process would, and the write
 * gets `EACCES` (root owns `/opt/dh`). A command it runs is in the `env` leaf
 * too, so the relay's `cgroup.kill` of that leaf (the helper went) or of the
 * session (a lost link) ends it with everything else.
 *
 * Paths come normalized and absolute from the driver (the relay passes them
 * on); the helper checks their shape again and nothing else. Files are opened
 * `O_NONBLOCK` so a FIFO a command made can't hold a call forever, and only a
 * regular file is read or written. Each command runs in a process group of its
 * own (`setsid`), killed at its deadline, on `CANCEL`, and once it exits: a
 * background job in its group doesn't outlive its call, and its outcome is
 * sent only once the group is gone. A job that left the group (`setsid cmd &`)
 * lives until the helper or the attach ends (the cgroup kills above; in the
 * degraded tier, without cgroups, it can outlive both). A `CANCEL` that comes
 * before the command started stops it from starting. Output and results are
 * bounded (`LIMITS`, `envResultBytes`): a listing whose JSON would pass the
 * bound is `E2BIG`, never an oversize result.
 *
 * The wire is the relay's pipe (`HELPER` frames on stdin and stdout, see
 * `protocol.ts`): a `CALL` in, `DATA` frames and one `RESULT` out. The TAIL
 * of a Codex rollout stays in the relay (A2: `O_NOFOLLOW`, an fd path check,
 * the owner and the inode), not here.
 */
import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fsp, type Stats } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { ENV_ERROR_CODE, ENV_ERROR_MESSAGE, HELPER, HELPER_RESULT_BYTES, HelperReader, LIMITS, MAX_TIMER_MS, ProtocolError, isCount, isEnvOp, isObject, json, unpack, helperFrame, type EnvOp } from './protocol.ts';

/** The most entries a `walk` returns. */
export const WALK_ENTRIES = 100_000;

/** An error with a POSIX code, as the driver reports it. */
function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The code a result carries: the error's own when it is POSIX-like, `EIO` otherwise. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (code === 'ERR_FS_EISDIR') return 'EISDIR';
  return typeof code === 'string' && ENV_ERROR_CODE.test(code) ? code : 'EIO';
}

function checkPath(p: unknown): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 4096 || p.includes('\0')) throw fail('EINVAL', 'a path must be absolute, without NUL, at most 4096 bytes');
  return p;
}

const typeOf = (s: Stats) => (s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : 'file');
const statOf = (s: Stats) => ({ type: typeOf(s), size: Number(s.size), mode: s.mode & 0o7777, mtimeMs: Math.max(0, s.mtimeMs) });
/** Nothing is there (or a component isn't a directory, or a link loops): `stat` answers undefined, as the in-memory machine does. */
const absent = (err: unknown) => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((err as { code?: string })?.code ?? '');

/** What a call answers: an inline value, or bytes (`DATA` frames) read as `bytes` or `json`. */
type Outcome = { value?: unknown; data?: { kind: 'bytes' | 'json'; parts: Uint8Array[] } | { kind: 'stream' } };

/** One call in progress: whether the relay cancelled it, and (once its command runs) how to stop it. */
interface Active {
  cancelled: boolean;
  kill?: () => void;
}

export interface HelperOptions {
  /** The most bytes a listing's JSON (`list`, `walk`) may take before it is `E2BIG`. Default `LIMITS.envBytes`; tests lower it. */
  jsonBytes?: number;
  /** How the helper exits (default `process.exit`); tests pass their own. */
  exit?: (code: number) => void;
}

export class Helper {
  private readonly reader = new HelperReader(LIMITS.envBytes + (1 << 20));
  /** Every call from the moment its `CALL` is read until its `RESULT` is written, so a `CANCEL` is never lost in between. */
  private readonly active = new Map<number, Active>();
  private ending = false;
  private readonly jsonBytes: number;
  private readonly exit: (code: number) => void;

  constructor(
    /** The environment every command starts from: the relay's allowlist, which is this process's whole environment. */
    private readonly baseEnv: Record<string, string>,
    private readonly write: (bytes: Uint8Array) => Promise<void>,
    options: HelperOptions = {}
  ) {
    this.jsonBytes = options.jsonBytes ?? LIMITS.envBytes;
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  /** Bytes from the relay. A malformed frame (or a second `CALL` for a live id) ends the helper (the relay starts another). */
  push(chunk: Uint8Array): void {
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch {
      return this.end(2);
    }
    for (const f of frames) {
      if (f.type === HELPER.CALL) {
        if (this.active.has(f.id)) return this.end(2);
        this.active.set(f.id, { cancelled: false });
        void this.call(f.id, f.payload);
      } else if (f.type === HELPER.CANCEL) {
        const a = this.active.get(f.id);
        if (a) {
          a.cancelled = true;
          a.kill?.();
        }
      } else return this.end(2);
    }
  }

  /** Kill every command this helper runs, then exit. */
  end(code = 0): void {
    if (this.ending) return;
    this.ending = true;
    for (const a of this.active.values()) a.kill?.();
    this.exit(code);
  }

  private async call(id: number, payload: Uint8Array): Promise<void> {
    try {
      let outcome: Outcome;
      try {
        const { header, bin } = unpack(payload);
        if (!isObject(header) || !isEnvOp(header.op) || !Array.isArray(header.args)) throw new ProtocolError('a malformed call');
        outcome = await this.op(id, header.op, header.args, bin);
        if (outcome.data?.kind === 'json' && outcome.data.parts.reduce((n, p) => n + p.length, 0) > this.jsonBytes) throw fail('E2BIG', `E2BIG: the result is larger than ${this.jsonBytes} bytes`);
      } catch (err) {
        return await this.result(id, { ok: false, error: { code: codeOf(err), message: String((err as Error)?.message ?? err).slice(0, ENV_ERROR_MESSAGE) } });
      }
      if (outcome.data?.kind === 'bytes' || outcome.data?.kind === 'json') {
        for (const part of outcome.data.parts) await this.data(id, part);
      }
      return await this.result(id, { ok: true, ...(outcome.value !== undefined ? { value: outcome.value } : {}), ...(outcome.data ? { data: outcome.data.kind === 'stream' ? 'bytes' : outcome.data.kind } : {}) });
    } finally {
      this.active.delete(id);
    }
  }

  private async data(id: number, bytes: Uint8Array): Promise<void> {
    for (let at = 0; at < bytes.length; at += LIMITS.chunkBytes) await this.write(helperFrame(HELPER.DATA, id, bytes.subarray(at, Math.min(bytes.length, at + LIMITS.chunkBytes))));
  }

  private result(id: number, value: unknown): Promise<void> {
    let bytes = json(value);
    if (bytes.length > HELPER_RESULT_BYTES) bytes = json({ ok: false, error: { code: 'E2BIG', message: 'the result was too large' } });
    return this.write(helperFrame(HELPER.RESULT, id, bytes));
  }

  private async op(id: number, op: EnvOp, args: unknown[], input: Uint8Array): Promise<Outcome> {
    switch (op) {
      case 'exec':
        return this.exec(id, args, input);
      case 'readFile':
        return this.readFile(id, checkPath(args[0]));
      case 'writeFile': {
        const options = isObject(args[1]) ? args[1] : {};
        const mode = options.mode;
        if (mode !== undefined && !(isCount(mode) && mode <= 0o7777)) throw fail('EINVAL', 'a mode must be 0..0o7777');
        return this.writeFile(checkPath(args[0]), input, mode as number | undefined, options.append === true);
      }
      case 'stat':
      case 'lstat': {
        const p = checkPath(args[0]);
        try {
          return { value: statOf(op === 'stat' ? await fsp.stat(p) : await fsp.lstat(p)) };
        } catch (err) {
          if (absent(err)) return { value: null };
          throw err;
        }
      }
      case 'list':
        return { data: { kind: 'json', parts: [json(await this.list(checkPath(args[0])))] } };
      case 'walk':
        return { data: { kind: 'json', parts: [json(await this.walk(checkPath(args[0])))] } };
      case 'mkdir':
        await fsp.mkdir(checkPath(args[0]), { recursive: isObject(args[1]) && args[1].recursive === true });
        return {};
      case 'remove': {
        const o = isObject(args[1]) ? args[1] : {};
        await fsp.rm(checkPath(args[0]), { recursive: o.recursive === true, force: o.force === true });
        return {};
      }
      case 'rename':
        await fsp.rename(checkPath(args[0]), checkPath(args[1]));
        return {};
      case 'symlink': {
        const target = args[0];
        if (typeof target !== 'string' || target.length === 0 || target.length > 4096 || target.includes('\0')) throw fail('EINVAL', 'a link target must be a non-empty string without NUL');
        await fsp.symlink(target, checkPath(args[1]));
        return {};
      }
      case 'readlink':
        return { value: await fsp.readlink(checkPath(args[0])) };
      case 'realpath':
        return { value: await fsp.realpath(checkPath(args[0])) };
      case 'chmod': {
        const mode = args[1];
        if (!(isCount(mode) && mode <= 0o7777)) throw fail('EINVAL', 'a mode must be 0..0o7777');
        await fsp.chmod(checkPath(args[0]), mode);
        return {};
      }
    }
  }

  /** A regular file's bytes, streamed as `DATA`; never more than `LIMITS.envBytes`. */
  private async readFile(id: number, p: string): Promise<Outcome> {
    const fh = await fsp.open(p, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      const st = await fh.stat();
      if (st.isDirectory()) throw fail('EISDIR', `EISDIR: illegal operation on a directory, read '${p}'`);
      if (!st.isFile()) throw fail('EINVAL', `EINVAL: not a regular file, read '${p}'`);
      if (st.size > LIMITS.envBytes) throw fail('EFBIG', `EFBIG: ${p} is larger than ${LIMITS.envBytes} bytes`);
      const buf = new Uint8Array(LIMITS.chunkBytes);
      let total = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > LIMITS.envBytes) throw fail('EFBIG', `EFBIG: ${p} grew past ${LIMITS.envBytes} bytes`);
        await this.data(id, buf.subarray(0, bytesRead));
      }
      return { data: { kind: 'stream' } };
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /** Write a file (its parent dirs made), keeping an existing file's mode unless `mode` is given. Only a regular file. */
  private async writeFile(p: string, content: Uint8Array, mode: number | undefined, append: boolean): Promise<Outcome> {
    await fsp.mkdir(dirname(p), { recursive: true });
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NONBLOCK | (append ? fsConstants.O_APPEND : fsConstants.O_TRUNC);
    const fh = await fsp.open(p, flags, 0o666);
    try {
      if (!(await fh.stat()).isFile()) throw fail('EINVAL', `EINVAL: not a regular file, write '${p}'`);
      let at = 0;
      while (at < content.length) at += (await fh.write(content, at, content.length - at, null)).bytesWritten;
      if (mode !== undefined) await fh.chmod(mode);
    } finally {
      await fh.close().catch(() => {});
    }
    return {};
  }

  /** A directory's entries, sorted by name, each with its own type (a link is a link). `E2BIG` past `WALK_ENTRIES` or the JSON budget. */
  private async list(dir: string): Promise<Array<{ name: string; type: string }>> {
    const out = [];
    const budget = jsonBudget(this.jsonBytes, `E2BIG: the listing of ${dir} is larger than ${this.jsonBytes} bytes`);
    for (const name of (await fsp.readdir(dir)).sort()) {
      const s = await fsp.lstat(join(dir, name)).catch(() => undefined);
      if (s) out.push(budget({ name, type: typeOf(s) }));
      if (out.length > WALK_ENTRIES) throw fail('E2BIG', `E2BIG: ${dir} has more than ${WALK_ENTRIES} entries`);
    }
    return out;
  }

  /**
   * Every path under `dir`, sorted: a link's type is its target's (`link:
   * true`), a dangling link is left out, and a link is never descended. A
   * directory this user can't read (the Drive's `lost+found`) is listed but not
   * entered. Nothing under a missing or non-directory `dir`. `E2BIG` past
   * `WALK_ENTRIES` or the JSON budget.
   */
  private async walk(dir: string): Promise<unknown[]> {
    const out: Array<Record<string, unknown> & { path: string }> = [];
    const budget = jsonBudget(this.jsonBytes, `E2BIG: the paths under ${dir} are larger than ${this.jsonBytes} bytes as a listing`);
    const visit = async (d: string, top: boolean): Promise<void> => {
      let names: string[];
      try {
        names = await fsp.readdir(d);
      } catch (err) {
        if (top && absent(err)) return;
        if (!top && ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes((err as { code?: string })?.code ?? '')) return;
        throw err;
      }
      for (const name of names) {
        const p = d === '/' ? `/${name}` : `${d}/${name}`;
        const l = await fsp.lstat(p).catch(() => undefined);
        if (!l) continue;
        if (l.isSymbolicLink()) {
          const s = await fsp.stat(p).catch(() => undefined);
          if (s) out.push(budget({ path: p, ...statOf(s), link: true }));
        } else {
          out.push(budget({ path: p, ...statOf(l) }));
          if (l.isDirectory()) await visit(p, false);
        }
        if (out.length > WALK_ENTRIES) throw fail('E2BIG', `E2BIG: more than ${WALK_ENTRIES} paths under ${dir}`);
      }
    };
    await visit(dir, true);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * Run `bash -c` in a process group of its own, with the base environment
   * plus the call's `env` (the driver checked it; the loader and shell names
   * are refused again here). `args` are appended to the command line as `"$@"`.
   * Stopped at `timeoutMs` (exit 124, as `timeout` does), at `limitMs` (the
   * driver says the machine's limit), on `CANCEL`, or when its output passes
   * `LIMITS.execOutputBytes`; once bash exits, its group is killed so a
   * background job doesn't outlive the call.
   */
  private async exec(id: number, args: unknown[], stdin: Uint8Array): Promise<Outcome> {
    const [command, rawOptions] = args;
    if (typeof command !== 'string' || command.includes('\0')) throw fail('EINVAL', 'a command must be a string without NUL');
    const o = isObject(rawOptions) ? rawOptions : {};
    const cwd = checkPath(o.cwd);
    const argv = o.args === undefined ? [] : o.args;
    if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string' && !a.includes('\0'))) throw fail('EINVAL', 'args must be strings without NUL');
    const env: Record<string, string> = { ...this.baseEnv };
    if (o.env !== undefined) {
      if (!isObject(o.env)) throw fail('EINVAL', 'env must be an object of strings');
      for (const [k, v] of Object.entries(o.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || LOADER_NAMES.test(k) || typeof v !== 'string' || v.includes('\0')) throw fail('EINVAL', `env ${k.slice(0, 64)} is refused`);
        env[k] = v;
      }
    }
    const deadline = (v: unknown) => (isCount(v) && v > 0 ? Math.min(v, MAX_TIMER_MS) : undefined);
    const timeoutMs = deadline(o.timeoutMs);
    const limitMs = deadline(o.limitMs);
    const where = await fsp.stat(cwd).catch((err: unknown) => {
      throw fail(codeOf(err), `cwd ${cwd}: ${(err as { code?: string })?.code ?? 'unusable'}`);
    });
    if (!where.isDirectory()) throw fail('ENOTDIR', `cwd ${cwd} is not a directory`);
    const active = this.active.get(id);
    if (active?.cancelled) throw fail('EINTR', 'the command did not run: its call was cancelled before it started');

    const script = argv.length ? `${command} "$@"` : command;
    const proc = spawn('bash', ['-c', script, 'bash', ...(argv as string[])], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let outLen = 0;
    let errLen = 0;
    let stopped: 'timeout' | 'limit' | 'output' | 'cancel' | undefined;
    const killGroup = () => {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {}
    };
    const stop = (why: NonNullable<typeof stopped>) => {
      stopped ??= why;
      killGroup();
    };
    if (active) active.kill = () => stop('cancel');
    const timers = [timeoutMs && setTimeout(() => stop('timeout'), timeoutMs), limitMs && setTimeout(() => stop('limit'), limitMs)].filter(Boolean) as ReturnType<typeof setTimeout>[];
    proc.stdout!.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen > LIMITS.execOutputBytes) return stop('output');
      out.push(d);
    });
    proc.stderr!.on('data', (d: Buffer) => {
      errLen += d.length;
      if (errLen > LIMITS.execOutputBytes) return stop('output');
      err.push(d);
    });
    proc.stdin!.on('error', () => {});
    proc.stdin!.end(stdin);
    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        proc.once('error', reject);
        proc.once('exit', (code, signal) => {
          // A background job in its group goes with it; output a job that left the group still holds is cut at a short grace.
          killGroup();
          const grace = setTimeout(() => {
            proc.stdout?.destroy();
            proc.stderr?.destroy();
          }, 200);
          proc.once('close', () => {
            clearTimeout(grace);
            resolve({ code, signal });
          });
        });
      });
      // The outcome comes after the group is dead: a stopped command is stopped when its call settles.
      await groupGone(proc.pid);
      if (stopped === 'output') throw fail('EFBIG', `the command's output passed ${LIMITS.execOutputBytes} bytes, so it was stopped`);
      if (stopped === 'cancel') throw fail('EINTR', 'the command was stopped: its call was cancelled');
      const exitCode = stopped === 'timeout' ? 124 : exit.code ?? 128 + ((exit.signal && osConstants.signals[exit.signal]) || 9);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      return {
        value: { exitCode, stdoutBytes: stdout.length, stderrBytes: stderr.length, ...(stopped === 'limit' ? { stopped: 'limit' } : {}) },
        data: { kind: 'bytes', parts: [stdout, stderr] },
      };
    } finally {
      for (const t of timers) clearTimeout(t);
      if (active) active.kill = undefined;
    }
  }
}

/** Counts a listing's JSON as its entries are added: `E2BIG` (`message`) once it passes `max` bytes. Returns each entry it is given. */
function jsonBudget(max: number, message: string): <T>(entry: T) => T {
  let total = 2;
  return (entry) => {
    total += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (total > max) throw fail('E2BIG', message);
    return entry;
  };
}

/** Wait (at most 1 s) until no process is left in group `pgid`. */
async function groupGone(pgid: number | undefined): Promise<void> {
  if (!pgid) return;
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Names that change how a loader or shell starts (the driver's `env-check.ts` and the relay refuse them too). */
const LOADER_NAMES = /^(?:LD_[A-Z0-9_]*|BASH_ENV|ENV|BASHOPTS|SHELLOPTS|PS4|PROMPT_COMMAND|BASH_FUNC_.*)$/;

/** The helper's process: frames on stdin and stdout, until stdin closes (the relay went) or a `SIGTERM` (the session is killed). */
export function runHelper(): void {
  process.umask(0o022);
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') baseEnv[k] = v;
  const write = (bytes: Uint8Array) =>
    new Promise<void>((resolve) => {
      if (process.stdout.write(bytes)) resolve();
      else process.stdout.once('drain', () => resolve());
    });
  const helper = new Helper(baseEnv, write);
  process.stdout.on('error', () => helper.end(0));
  process.stdin.on('data', (d: Buffer) => helper.push(d));
  process.stdin.on('end', () => helper.end(0));
  process.on('SIGTERM', () => helper.end(0));
}
