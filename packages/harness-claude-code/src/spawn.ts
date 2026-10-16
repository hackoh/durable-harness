import { EventEmitter } from 'node:events';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import type { CacheFile, SessionMachine, SessionProcess } from 'harness-world-process';

/**
 * The Agent SDK's `spawnClaudeCodeProcess` on the session's Vercel Sandbox VM
 * (docs/workspaces.md §5.6 "Spawn", "Env", "Resume files", "Mirror"): the
 * `claude` CLI runs in the VM, as the unprivileged user, in the session's
 * cgroup, over the relay; the SDK (its hooks, its MCP server, its session
 * store) stays in the Function, and talks to it over the CLI's stdio.
 *
 * The SDK wants the process back synchronously and the VM starts it
 * asynchronously, so this returns streams that are connected to the child
 * once it runs (the shape `hostedSpawn` had). Before the child starts:
 *
 * 1. **The env.** The SDK's `env` must be there (without it the SDK would
 *    pass `{...process.env}`), with exactly the variables the harness gave it
 *    and the SDK's own markers, each with the harness's value: anything else
 *    is refused, whatever its value. The child's environment is that env with
 *    the VM's config dir in place of the Function's (the machine checks it
 *    again: no credential name or shape, no value of the Function's own
 *    environment, the model key's name only with this attach's key).
 * 2. **The resume files.** On a resume the SDK writes the transcript it
 *    loaded from the log into a `claude-resume-*` dir under the Function's
 *    `os.tmpdir()` and points `CLAUDE_CONFIG_DIR` there. Only `projects/**`
 *    (the transcript and its subagents' sidechains) may be in it: anything
 *    else is refused. The cache dirs are wiped, `projects/**` is uploaded
 *    into the VM's config dir (`FILES`), and the local copy is deleted.
 * 3. **The spawn** (`SPAWN`), with the VM's executable and `/workspace` as
 *    the cwd.
 *
 * **The mirror.** The CLI reports each transcript batch as a
 * `transcript_mirror` line with the file it wrote, a path in the VM. The SDK
 * maps that path against the config dir it passed (the Function's), so each
 * such line's `filePath` is rewritten here, on the trusted side: the VM's
 * `<config>/projects/` prefix becomes the Function's, and the result must
 * stay under the Function's `projects/` (no `..`, no other root). A line
 * that doesn't map is never passed on, and `onUnmapped` is told (the harness
 * ends the turn with `Unavailable`: a dropped mirror would silently deny
 * every `never` built-in at its barrier and break the next resume).
 *
 * A failed start is reported to `onError` (the harness halts the drive) and
 * as the process's `error` event.
 */

/** The SDK's `SpawnOptions`, structurally. */
export interface SdkSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/** The SDK's `SpawnedProcess`, structurally. */
export interface SdkSpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit' | 'error', listener: (...args: any[]) => void): void;
  once(event: 'exit' | 'error', listener: (...args: any[]) => void): void;
  off(event: 'exit' | 'error', listener: (...args: any[]) => void): void;
}

/** The variables the SDK adds to the env it was given (0.3.296): its own markers, which the CLI reads. */
export const SDK_ENV_MARKERS: ReadonlySet<string> = new Set(['CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SDK_READS_SESSION_STATE']);

export interface SandboxSpawnOptions {
  /** The session's machine (branded: the harness checked it). */
  machine: SessionMachine;
  /** The CLI's path in the VM: the only command this spawns. */
  executable: string;
  /**
   * The env the harness gave the SDK (`query()`'s `env`), whose
   * `CLAUDE_CONFIG_DIR` is the Function's config dir: what a spawn's env
   * may hold besides `SDK_ENV_MARKERS`, and with these values.
   */
  env: Readonly<Record<string, string>>;
  /** The drive's signal: aborting it kills the session's processes. */
  signal: AbortSignal;
  /** The child could not be started. */
  onError: (err: unknown) => void;
  /** The child is running. */
  onSpawn?: (proc: SessionProcess) => void;
  /** A `transcript_mirror` line whose path doesn't map (it was dropped). Called once per spawn. */
  onUnmapped: (why: string) => void;
  /** Runs after the cache files are in place and before the `SPAWN` (the harness's checks of the VM). */
  prepare?: () => Promise<void> | void;
  /** The CLI's commands run under Claude Code's sandbox (a pid namespace of their own), or it runs none: the model port admits it (`MachineSpawn.isolatedCommands`). */
  isolatedCommands?: boolean;
}

/** Whether `path` is a resume dir the SDK made (a `claude-resume-*` directly under `os.tmpdir()`). */
export function isResumeDir(path: string): boolean {
  return resolve(dirname(path)) === resolve(tmpdir()) && basename(path).startsWith('claude-resume-');
}

/** The largest resume upload: the relay's `FILES` bound. */
const RESUME_MAX_BYTES = 256 << 20;

/**
 * The resume files of a `claude-resume-*` dir: every regular file under
 * `projects/`, with its path relative to the dir. Anything else in it (a
 * credential or settings file the SDK copied from a config dir, a symlink,
 * a file beside `projects/`) is refused: only the transcript leaves the
 * Function.
 */
export async function resumeFiles(dir: string): Promise<CacheFile[]> {
  const out: CacheFile[] = [];
  let total = 0;
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name !== 'projects') throw new TypeError(`harness-world-claude-code: the resume dir holds ${JSON.stringify(e.name)}: only projects/** may leave the Function`);
      const st = await lstat(join(dir, path));
      if (st.isDirectory()) await walk(path);
      else if (st.isFile()) {
        total += st.size;
        if (total > RESUME_MAX_BYTES) throw new RangeError('harness-world-claude-code: the resume files are over 256 MiB');
        out.push({ path, bytes: new Uint8Array(await readFile(join(dir, path))) });
      } else throw new TypeError(`harness-world-claude-code: the resume dir holds ${JSON.stringify(path)}, which is not a regular file`);
    }
  };
  await walk('');
  return out;
}

/** The env the child gets, after checking the SDK's against the harness's (see `sandboxSpawn`). */
export function childEnv(given: Readonly<Record<string, string>>, sdk: Readonly<Record<string, string | undefined>> | undefined, vmConfigDir: string): Record<string, string> {
  if (!sdk || typeof sdk !== 'object') throw new TypeError('harness-world-claude-code: the Agent SDK passed no env to the spawn (it would fall back to the Function\'s own)');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sdk)) {
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new TypeError(`harness-world-claude-code: spawn env ${JSON.stringify(key)} is not a string`);
    if (SDK_ENV_MARKERS.has(key)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new TypeError(`harness-world-claude-code: the SDK's spawn env ${JSON.stringify(key)} has an unexpected value`);
    } else if (key === 'CLAUDE_CONFIG_DIR') {
      // The Function's config dir, or the SDK's resume dir under the Function's tmpdir: mapped to the VM's.
      if (value !== given.CLAUDE_CONFIG_DIR && !isResumeDir(value)) throw new TypeError('harness-world-claude-code: the SDK chose a config dir the harness did not give it');
      out[key] = vmConfigDir;
      continue;
    } else if (!Object.hasOwn(given, key)) throw new TypeError(`harness-world-claude-code: the SDK added ${JSON.stringify(key)} to the spawn env, which the harness did not set (a newer SDK? it must be reviewed before it reaches the VM)`);
    else if (given[key] !== value) throw new TypeError(`harness-world-claude-code: the SDK changed the spawn env ${JSON.stringify(key)}`);
    out[key] = value;
  }
  for (const key of Object.keys(given)) if (!Object.hasOwn(out, key)) throw new TypeError(`harness-world-claude-code: the SDK dropped ${JSON.stringify(key)} from the spawn env`);
  return out;
}

/** Why a VM `filePath` doesn't map into `fnConfig/projects/`, or the mapped path. */
export function mapMirrorPath(filePath: unknown, vmConfig: string, fnConfig: string): { path: string } | { why: string } {
  if (typeof filePath !== 'string' || filePath.length > 4096 || filePath.includes('\0')) return { why: 'a filePath that is not a short string' };
  const prefix = `${vmConfig.replace(/\/+$/, '')}/projects/`;
  if (!filePath.startsWith(prefix)) return { why: "a filePath outside the VM's projects dir" };
  const rel = filePath.slice(prefix.length);
  const parts = rel.split('/');
  if (!rel || parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\'))) return { why: 'a filePath with an empty, . or .. segment' };
  const base = posix.join(resolve(fnConfig), 'projects');
  const mapped = posix.join(base, ...parts);
  if (!mapped.startsWith(`${base}/`)) return { why: "a filePath that leaves the Function's projects dir" };
  return { path: mapped };
}

/**
 * The `transcript_mirror` line, rewritten for the Function's config dir;
 * undefined when the line is not one; `{ why }` when it doesn't map. A frame
 * is told by what the SDK reads (`JSON.parse`, then `type`), never by its
 * bytes: keys in another order, whitespace, or an escaped `type` value are the
 * same frame to the SDK. Only a line with neither the word nor a `\u`
 * escape is passed without parsing (it can't parse to one).
 */
export function rewriteMirror(line: string, vmConfig: string, fnConfig: string): string | { why: string } | undefined {
  if (!line.includes('transcript_mirror') && !line.includes('\\u')) return undefined;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    // Not JSON: the SDK can't read it as a frame either; one that says it is one is refused.
    return /"type"\s*:\s*"transcript_mirror"/.test(line) ? { why: 'a transcript_mirror line that is not JSON' } : undefined;
  }
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame) || (frame as { type?: unknown }).type !== 'transcript_mirror') return undefined;
  const mapped = mapMirrorPath((frame as { filePath?: unknown }).filePath, vmConfig, fnConfig);
  if ('why' in mapped) return mapped;
  return JSON.stringify({ ...(frame as Record<string, unknown>), filePath: mapped.path });
}

export function sandboxSpawn(options: SandboxSpawnOptions): (spawn: SdkSpawnOptions) => SdkSpawnedProcess {
  const { machine } = options;
  return (spawn) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = new EventEmitter();
    // An 'error' with no listener would throw; the SDK listens, but a late one should not crash the process.
    events.on('error', () => {});
    let proc: SessionProcess | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let killed = false;
    let pendingKill: NodeJS.Signals | undefined;
    let unmapped = false;

    const start = async (): Promise<SessionProcess> => {
      if (spawn.command !== options.executable) throw new TypeError(`harness-world-claude-code: the SDK spawned ${JSON.stringify(spawn.command.slice(0, 200))}, not the CLI in the VM`);
      if (!Array.isArray(spawn.args) || !spawn.args.every((a) => typeof a === 'string')) throw new TypeError('harness-world-claude-code: the SDK passed malformed spawn arguments');
      const env = childEnv(options.env, spawn.env, machine.dirs.config);
      const fnConfig = spawn.env.CLAUDE_CONFIG_DIR!;
      const resumeDir = isResumeDir(fnConfig);
      try {
        const resume = resumeDir ? await resumeFiles(fnConfig) : undefined;
        await machine.files.wipe();
        if (resume?.length) await machine.files.upload('config', resume);
      } finally {
        // The SDK's copy of the transcript leaves the Function's tmpdir whatever happened to the upload.
        if (resumeDir) await rm(fnConfig, { recursive: true, force: true }).catch(() => {});
      }
      await options.prepare?.();
      const signal = AbortSignal.any([options.signal, spawn.signal]);
      return machine.spawn({ command: options.executable, args: spawn.args, env, cwd: machine.root, signal, ...(options.isolatedCommands ? { isolatedCommands: true } : {}) });
    };

    start().then(
      (p) => {
        proc = p;
        const fnConfig = spawn.env.CLAUDE_CONFIG_DIR!;
        // stdin: the SDK writes JSON lines; the relay takes them one line at a time.
        let pending = '';
        const decoder = new TextDecoder();
        stdin.on('data', (chunk: Buffer) => {
          pending += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = pending.indexOf('\n')) >= 0) {
            p.send(pending.slice(0, nl));
            pending = pending.slice(nl + 1);
          }
        });
        stdin.on('end', () => {
          pending += decoder.decode();
          if (pending) p.send(pending);
          p.end();
        });
        void (async () => {
          try {
            for await (const line of p.lines()) {
              const rewritten = rewriteMirror(line, machine.dirs.config, fnConfig);
              if (rewritten === undefined) stdout.write(`${line}\n`);
              else if (typeof rewritten === 'string') stdout.write(`${rewritten}\n`);
              else if (!unmapped) {
                unmapped = true;
                options.onUnmapped(rewritten.why);
              }
            }
          } finally {
            stdout.end();
          }
        })();
        void p.exited.then(({ code, signal }) => {
          exit = { code, signal: signal as NodeJS.Signals | null };
          events.emit('exit', code, signal);
        });
        if (pendingKill) p.kill(pendingKill === 'SIGINT' || pendingKill === 'SIGKILL' ? pendingKill : 'SIGTERM');
        options.onSpawn?.(p);
      },
      (err) => {
        options.onError(err);
        exit = { code: 1, signal: null };
        events.emit('error', err instanceof Error ? err : new Error(String(err)));
        stdout.end();
        events.emit('exit', 1, null);
      }
    );
    return {
      stdin,
      stdout,
      get killed() {
        return killed;
      },
      get exitCode() {
        return exit?.code ?? null;
      },
      get signalCode() {
        return exit?.signal ?? null;
      },
      kill(signal) {
        killed = true;
        const s = signal === 'SIGINT' || signal === 'SIGKILL' ? signal : 'SIGTERM';
        if (proc) proc.kill(s);
        else pendingKill = s;
        return true;
      },
      on: (event, listener) => void events.on(event, listener),
      once: (event, listener) => void events.once(event, listener),
      off: (event, listener) => void events.off(event, listener),
    };
  };
}
