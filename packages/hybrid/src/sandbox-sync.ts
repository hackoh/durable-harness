import type { SessionState } from 'harness-world';
import { type FileChanges, fileChangesOf } from 'harness-world-hands';

/**
 * A real machine for the `sandbox` lane, behind an interface small enough to
 * fake: a Vercel Sandbox in production (`harness-world-hybrid/sandbox`), a
 * just-bash VM in tests (`FakeSandboxProvider`).
 *
 * The session's files still live in the log. The sandbox is a *cache* of
 * them: before each command the workspace fold is written into it (only
 * files whose content hash differs), and after the command whatever it
 * changed under the workspace root is recorded back as an `fs` step, so the
 * browser and function lanes see it too.
 */
export interface SandboxProvider {
  /** For display: `vercel` or `fake`. */
  readonly kind: string;
  /**
   * The push callback of the detached path, when one is configured (a
   * Vercel Sandbox's `callback`, the fake's `push`). `run_on_machine` waits
   * for its command inside the call and refuses a provider that has one:
   * a callback makes the VM's egress proxy carry the deployment's protection
   * bypass to app routes (docs/workspaces.md §8).
   */
  readonly callback?: unknown;
  /** The persistent sandbox for a session, created on first use. */
  open(sessionId: string): Promise<SandboxHandle>;
  /**
   * Forget any cached connection to the session's sandbox, so the next
   * `open` reconnects: resumes the persistent sandbox, or creates a fresh one
   * if there is nothing to resume. Called after `SandboxLostError`.
   */
  invalidate?(sessionId: string): void;
  /**
   * Where a finished command reports (push), for a new job: a URL and a
   * capability token for this one step. `undefined`: no callback is
   * configured, so results are collected by polling (pull).
   */
  reportFor?(job: { runId: string; stepId: string; sandbox: string; timeoutSeconds: number; startedAt: number }): Promise<{ url: string; token: string } | undefined>;
  /** Where a parked command stands, from the Sandbox API. Never resumes a stopped VM. */
  inspect(owner: SandboxOwner): Promise<Inspection>;
  /** A handle on the VM session a parked command runs in, or `lost` if that session is gone. */
  attach(owner: SandboxOwner): Promise<SandboxHandle | 'lost'>;
  /** Stop the VM (the Kill Sandbox VM crash). */
  stopVm?(owner: SandboxOwner): Promise<void>;
  /**
   * Pre-warming keepalive: give the VM named `name` (a host
   * fact's `vm`) at least `minLeftMs` before its timeout. Never creates or resumes a VM: a
   * stopped one is left stopped (its idle teardown).
   */
  keepalive?(name: string, minLeftMs: number): Promise<KeepaliveResult>;
  /** How many of this app's VMs are warm (running or starting) right now, for the team cap. */
  countWarm?(): Promise<number>;
  /**
   * Delete the VM named `name` (an unused pre-warmed one): no
   * snapshot is kept. `keep`, given the running VM's port URLs, can veto it.
   */
  deleteVm?(name: string, keep?: (domain: (port: number) => string) => Promise<boolean>): Promise<'deleted' | 'absent' | 'kept'>;
}

/** What `keepalive` found and did. */
export interface KeepaliveResult {
  /** The VM's status (`absent`: there is none). */
  status: string;
  /** Time left before the VM's timeout, after any extension. */
  leftMs?: number;
  /** How much the timeout was extended by, if it was. */
  extendedMs?: number;
}

/**
 * The owner of a parked `sandbox_exec` (the `park` step's `owner`): which VM
 * session and command have the step, and when it must be done by. Times are
 * the server's clock and are only compared with the server's clock.
 */
export interface SandboxOwner {
  kind: 'sandbox';
  /** The sandbox name (`hybrid-<runId>`). */
  sandbox: string;
  /** The VM session the command runs in (a stop and resume is a new one). */
  sessionId: string;
  /** The wrapper's command id. */
  cmdId: string;
  /** `/tmp/harness/<stepId>` in the VM: the job, its output and `result.json`. */
  jobDir: string;
  startedAt: number;
  deadlineAt: number;
  timeoutSeconds: number;
  /** A callback was configured for this command (the VM reports; checks only back it up). */
  push: boolean;
  /**
   * sha256 of the `baseline.json` the function wrote. The command can
   * rewrite anything in its job dir, so a collector reading the baseline
   * back from the VM trusts it only if it matches.
   */
  baselineSha256?: string;
  [key: string]: unknown;
}

export type Inspection =
  | { state: 'running'; expiresAt?: number }
  | { state: 'exited'; exitCode: number }
  | { state: 'lost'; why: 'deleted' | 'stopped' | 'replaced' | 'command-missing'; code?: string }
  | { state: 'unknown'; error: string };

/** What the wrapper writes to `result.json` (and POSTs): the command's own report. */
export interface SandboxReport {
  v: 1;
  exitCode: number;
  timedOut?: boolean;
  stdout: ClippedStream;
  stderr: ClippedStream;
  endedAt?: number;
}

export interface ClippedStream {
  bytes: number;
  head: string;
  /** The end of the stream, when it was longer than twice the head (else empty). */
  tail: string;
}

/** One detached command: what `start` needs (its files are written with the sync). */
export interface SandboxJob {
  runId: string;
  stepId: string;
  key: string;
  command: string;
  timeoutSeconds: number;
  startedAt: number;
  report?: { url: string; token: string };
}

/**
 * The machine went away under a call: the VM stopped, was deleted, or its
 * session ended mid-command. `phase` says what was lost: `start` (nothing
 * ran, so reconnecting and retrying is safe) or `run` (the command may have
 * done anything before it died). `stdout` / `stderr` are what it printed.
 */
export class SandboxLostError extends Error {
  readonly phase: 'start' | 'run' | 'sync';
  readonly code?: string;
  readonly stdout: string;
  readonly stderr: string;
  constructor(options: { phase: 'start' | 'run' | 'sync'; sandbox: string; cause?: unknown; code?: string; stdout?: string; stderr?: string }) {
    const why = options.code ?? (options.cause instanceof Error ? options.cause.message : options.cause ? String(options.cause) : 'unknown');
    super(`sandbox ${options.sandbox} was lost during ${options.phase} (${why})`, options.cause ? { cause: options.cause } : undefined);
    this.name = 'SandboxLostError';
    this.phase = options.phase;
    if (options.code) this.code = options.code;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
  }
}

export interface SandboxHandle {
  readonly name: string;
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  /**
   * Text files under `root` (absolute paths) with the sha256 hex of their
   * bytes and their size, skipping `skipDirs` and binary files.
   */
  manifest(root: string, options: ManifestOptions): Promise<Manifest>;
  /** Text, or bytes (a binary file of the workspace). */
  writeFiles(files: { path: string; content: string | Uint8Array }[]): Promise<void>;
  /** A file's contents, or `null` if it is missing or not UTF-8 text. */
  readTextFile(path: string): Promise<string | null>;
  remove(paths: string[]): Promise<void>;
  /** Best-effort kill of a command a previous (dead) call left running. */
  kill?(cmdId: string): Promise<void>;
  /** The VM session this handle talks to. */
  readonly sessionId?: string;
  /** Start a job's wrapper, detached (its files are already in the job dir). */
  start(job: SandboxJob): Promise<{ cmdId: string; sessionId: string }>;
  /** Wait up to `ms` for a command to exit. `undefined`: still running. */
  waitFor(cmdId: string, ms: number): Promise<{ exitCode: number } | undefined>;
  /**
   * Files from a job dir, each read only if asked for (default `result` and
   * `baseline`) and never past `JOB_READ_LIMITS`: the job dir is writable by
   * the command, so anything in it may be huge, a symlink, or a device.
   */
  readJob(jobDir: string, want?: JobParts): Promise<JobFiles>;
  /** Kill a job's command (its process group); the wrapper survives and reports. */
  killCommand(target: { cmdId: string; jobDir?: string }): Promise<void>;
  /** Make sure the VM stays up at least `ms` longer. */
  ensureTimeout?(ms: number): Promise<void>;
}

export interface JobParts {
  /** `result.json` (the wrapper's report). */
  result?: boolean;
  /** `baseline.json`, as raw text (check it against the park's `baselineSha256` before trusting it). */
  baseline?: boolean;
  /** The head of `stdout` / `stderr` (only for a wrapper killed before it reported). */
  output?: boolean;
}

export interface JobFiles {
  result?: SandboxReport;
  baselineText?: string;
  stdout?: string;
  stderr?: string;
}

/** The most bytes read from each job file. Past the limit a file reads as missing (`result`, `baseline`) or truncated (output). */
export const JOB_READ_LIMITS = {
  result: 64 * 1024,
  baseline: 8 * 1024 * 1024,
  output: 16_000,
};

export interface ExecOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
  /** The command started, with an id `kill` accepts. */
  onStart?: (cmdId: string) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ManifestOptions {
  skipDirs: readonly string[];
}

export type Manifest = Map<string, { hash: string; size: number }>;

/** Directories never copied back into the log (dependencies, VCS, caches). */
export const SANDBOX_SKIP_DIRS = [
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  '.npm',
] as const;

export const SYNC_LIMITS = {
  /** Largest single file recorded back into the log. */
  maxFileBytes: 256 * 1024,
  /** Most bytes one command records back. */
  maxTotalBytes: 1024 * 1024,
  /** Most files one command records back. */
  maxFiles: 200,
};

/** A Vercel Sandbox name for a session: lowercase, `[a-z0-9-]`, bounded. */
export function sandboxNameFor(sessionId: string, prefix = 'hybrid'): string {
  const slug = sessionId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${prefix}-${slug}`.slice(0, 63).replace(/-+$/, '');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Every path any `fs` step (or sandbox settlement) ever wrote, so a deletion can be told from "never tracked". */
export function trackedPaths(state: SessionState): Set<string> {
  const out = new Set<string>();
  for (const e of state.effectOrder) {
    const files = fileChangesOf(e, state);
    if (files) for (const path of Object.keys(files)) out.add(path);
  }
  return out;
}

export interface SyncIn {
  written: string[];
  removed: string[];
  /** The sandbox's manifest right after the sync, the baseline for `syncOut`. */
  baseline: Map<string, string>;
}

/**
 * Make the sandbox's workspace match the fold: write files whose hash
 * differs, and remove files the log deleted. Files the log never tracked
 * (dependencies, build output, binaries) are left alone.
 */
export async function syncIn(
  handle: SandboxHandle,
  root: string,
  fold: Map<string, string>,
  tracked: Set<string>,
  /** Files to write in the same call (a job's files, the workspace's binary files), given the baseline. They are not in it. */
  extra?: (baseline: Map<string, string>) => { path: string; content: string | Uint8Array }[]
): Promise<SyncIn> {
  const remote = await handle.manifest(root, { skipDirs: SANDBOX_SKIP_DIRS });
  const baseline = new Map([...remote].map(([p, e]) => [p, e.hash]));
  const writes: { path: string; content: string | Uint8Array }[] = [];
  for (const [path, content] of fold) {
    // The log's paths only: a fold holds nothing else, but never write outside the root.
    if (!underRoot(path, root)) continue;
    const hash = await sha256Hex(content);
    if (remote.get(path)?.hash !== hash) writes.push({ path, content });
    baseline.set(path, hash);
  }
  const removed = [...remote.keys()].filter((p) => !fold.has(p) && tracked.has(p) && underRoot(p, root));
  for (const p of removed) baseline.delete(p);
  const extras = extra?.(baseline) ?? [];
  if (writes.length || extras.length) await handle.writeFiles([...writes, ...extras]);
  if (removed.length) await handle.remove(removed);
  return { written: writes.map((w) => w.path), removed, baseline };
}

export interface SyncOut {
  files: FileChanges['files'];
  /** Changed in the sandbox but too large, binary, or over budget: left there only. */
  skipped: string[];
  /**
   * Paths the VM's manifest named that are not strictly under the root (a
   * `..` or `.` segment, an empty one, an absolute path elsewhere): never
   * read and never recorded. The VM is the command's, and so is its manifest.
   */
  refused: string[];
}

/** Strictly under `root`, with no empty, `.` or `..` segments, and no control characters (a newline would split a manifest line). */
export const underRoot = (path: string, root: string) =>
  typeof path === 'string' &&
  path.startsWith(`${root}/`) &&
  !/[\u0000-\u001f\u007f]/.test(path) &&
  !path.slice(root.length + 1).split('/').some((s) => s === '' || s === '.' || s === '..');

/** What the command changed under the workspace root, as an `fs` change set. */
export async function syncOut(
  handle: SandboxHandle,
  root: string,
  baseline: Map<string, string>
): Promise<SyncOut> {
  const after = await handle.manifest(root, { skipDirs: SANDBOX_SKIP_DIRS });
  const files: FileChanges['files'] = {};
  const skippedPaths: string[] = [];
  const refused: string[] = [];
  let unlisted = 0;
  const skipped = {
    push(path: string) {
      if (skippedPaths.length < SYNC_LIMITS.maxFiles) skippedPaths.push(path);
      else unlisted++;
    },
  };
  let total = 0;
  let count = 0;
  for (const [path, { hash, size }] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
    if (!underRoot(path, root)) {
      if (refused.length < SYNC_LIMITS.maxFiles) refused.push(path.slice(0, 256));
      continue;
    }
    if (baseline.get(path) === hash) continue;
    if (
      size > SYNC_LIMITS.maxFileBytes ||
      total + size > SYNC_LIMITS.maxTotalBytes ||
      count >= SYNC_LIMITS.maxFiles
    ) {
      skipped.push(path);
      continue;
    }
    const content = await handle.readTextFile(path);
    if (content === null) {
      skipped.push(path);
      continue;
    }
    files[path] = content;
    total += size;
    count++;
  }
  // A deletion is only ever of a path under the root (the baseline may have
  // come back from the VM), and deletions count against the same budget.
  for (const path of [...baseline.keys()].sort()) {
    if (after.has(path) || !underRoot(path, root)) continue;
    if (count >= SYNC_LIMITS.maxFiles) {
      skipped.push(path);
      continue;
    }
    files[path] = null;
    count++;
  }
  if (unlisted > 0) skippedPaths.push(`(and ${unlisted} more)`);
  return { files, skipped: skippedPaths, refused };
}
