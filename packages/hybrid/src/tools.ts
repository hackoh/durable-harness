import {
  EffectInterrupted,
  effectStreamName,
  type HostTool,
  type HostToolIO,
  type Lane,
  readJsonLines,
} from 'harness-world';
import {
  docWorkspaceTools,
  type Isolation,
  isWorkspacePath,
  UNSAFE_TOOL_NAMES,
  unsafeTools,
  WORKSPACE_ROOT,
  type WorkspaceMachine,
  workspaceRuntime,
} from 'harness-world-hands';
import { asContent, WORKSPACE_TOOL } from 'harness-world-hands/runtime';
import { Type } from 'typebox';
import { formatResult } from './sandbox-collect.ts';
import { jobDirFor, jobFiles, reportFromOutput } from './sandbox-job.ts';
import {
  type SandboxHandle,
  type SandboxJob,
  SandboxLostError,
  type SandboxProvider,
  type SandboxReport,
  SANDBOX_SKIP_DIRS,
  syncIn,
  syncOut,
  type SyncIn,
  trackedPaths,
} from './sandbox-sync.ts';

/**
 * What the process building the tools can do. The *list* of tools is the
 * same in every lane (Pi advertises it to the model, and a transcript must
 * replay the same way wherever it continues); only what `execute` can
 * reach differs. The kernel escalates a call to a more capable lane before
 * `execute` runs, so a tool never runs in a process that cannot carry it.
 */
export interface HybridToolsEnv {
  /** The most capable lane this process drives. */
  lane: Lane;
  secrets?: {
    /**
     * Backend-only credential for the (fake) CRM behind `lookup_customer`.
     * Default outside the browser: `process.env.HYBRID_CRM_SECRET`.
     */
    crmSecret?: string;
  };
  /**
   * Hands for `run_on_machine`: the session's own VM (`hybrid-<runId>`),
   * never its `sandbox()` VM. Required in the process that runs it (a
   * function); built with no push callback (`run_on_machine` refuses one).
   */
  sandbox?: SandboxProvider;
  /** Longest command allowed. Default `HYBRID_SANDBOX_MAX_COMMAND_SECONDS`, else 1800. */
  maxCommandSeconds?: number;
  /**
   * Time kept after a command for copying its files back and committing
   * the call, before the drive's deadline (`DriveContext.deadline`).
   * Default 10 s.
   */
  marginMs?: number;
  /** Where the virtual workspace's shell runs (tests). Default: an isolated worker where one can start. */
  isolation?: Isolation;
  /**
   * The session's hands (the demo's Hands axis, `config.hands` on its
   * `run_created`): which of the tools below it has. Default `machine`, the
   * whole set.
   */
  hands?: HybridHands;
}

/**
 * A hybrid session's hands: `none` (no workspace: the side-effect tools and
 * `lookup_customer` only), `virtual` (the virtual workspace, its files in
 * the log), `ephemeral` (the same workspace in memory, cleared every turn;
 * a turn that moves to another lane starts it over), `machine` (the
 * virtual workspace and `run_on_machine`).
 */
export type HybridHands = 'none' | 'virtual' | 'ephemeral' | 'machine';
export const HYBRID_HANDS: readonly HybridHands[] = ['none', 'virtual', 'ephemeral', 'machine'];
export const isHybridHands = (value: unknown): value is HybridHands => typeof value === 'string' && (HYBRID_HANDS as readonly string[]).includes(value);

export const BASH_DESCRIPTION =
  "Run a bash command in the session's lightweight workspace shell. It is an emulated shell (coreutils, grep, sed, awk, jq, find, and more) over the workspace files at /workspace, and it starts instantly wherever the session is running, including the user's browser. It is NOT a real machine: no node, npm, python, git, curl, network access, package installation, or running programs. Use run_on_machine for any of those.";

export const RUN_ON_MACHINE_DESCRIPTION =
  "Run a shell command on a real Linux machine: a Vercel Sandbox VM for this session with node, npm, python, pip, git, curl, and network access. The workspace files are copied to /workspace before the command runs, and text files the command creates, changes or deletes under /workspace are copied back into the workspace when it ends. Installed packages and other machine state outside /workspace usually persist between calls, but the machine is a cache that can be replaced: keep what matters in /workspace. The call waits for the command, within the time the server function running it has left: a timeout that does not fit fails before anything runs, and the error says how many seconds there are. It takes a few seconds to reach the machine, so use it only for work that needs a real system (running programs or tests, installing packages, git, network requests, compiling); use bash, read_file, and write_file for plain text and file work.";

export const LOOKUP_CUSTOMER_DESCRIPTION =
  "Look up a customer in the company CRM by customer id, email, or company name. Returns the customer's plan, billing, and support status. It runs on the backend because it needs a server-only CRM credential.";

/** The default command timeout, when the model gives none and there is time for it. */
export const DEFAULT_COMMAND_SECONDS = 120;
/** A command needs at least this long: less is "no time left", not a command. */
const MIN_COMMAND_SECONDS = 5;
/** How long past its own timeout a command's wrapper gets to report (its `timeout --kill-after=5s`, then `result.json`). */
const REPORT_GRACE_MS = 8_000;
/** After a kill, how long the wrapper gets to report. */
const KILL_GRACE_MS = 5_000;
/**
 * How far past the drive's deadline a wait may run: the kernel lets an
 * effect in flight finish into its own margin (15 s by default), and the
 * copy back needs some of it.
 */
const PAST_DEADLINE_MS = 3_000;
/**
 * Where the VM keeps the paths it has had from the log, so a file the log
 * deleted since is removed from the VM before the next command (a file the
 * log never had, such as build output, is left alone). In the VM, which
 * the command controls: it only ever decides what is removed from the
 * VM's own /workspace, never what the log records. Read with `readJob`
 * (bounded, regular files only), so it is a job dir's `baseline.json`.
 */
const TRACKED_DIR = '/tmp/hybrid-machine';
const TRACKED_FILE = `${TRACKED_DIR}/baseline.json`;
/** The most paths the VM's list keeps. */
const MAX_TRACKED = 5000;

/**
 * The hybrid session's tools, identical in every lane (for its hands, `env.hands`):
 *
 * | tool | needs | where it runs | hands |
 * | --- | --- | --- | --- |
 * | `bash`, `read_file`, `write_file`, `edit_file`, `list_files` | nothing | the session's virtual workspace (`virtual()`): just-bash over the `hw.workspace` manifest, or in memory (`ephemeral`) | all but `none` |
 * | `unsafe_send_email`, `unsafe_make_payment` | `secrets` | an external side effect (`replay: 'never'`) | all |
 * | `lookup_customer` | `secrets` | a server-only secret | all |
 * | `run_on_machine` | `machine` (`requires: 'sandbox'`) | the session's own Vercel Sandbox VM, the workspace synced in and back within the call | `machine` |
 */
export function hybridTools(env: HybridToolsEnv): HostTool[] {
  const hands = env.hands ?? 'machine';
  const options = env.isolation ? { isolation: env.isolation } : {};
  const workspace = hands === 'none' ? [] : docWorkspaceTools({ kind: 'virtual', durable: hands !== 'ephemeral' }, options);
  const tools = [...workspace, ...unsafeTools()].map((tool) => {
    // Only with a machine next to it does the shell say what to use instead.
    if (tool.name === 'bash' && hands === 'machine') return { ...tool, description: BASH_DESCRIPTION };
    // The unsafe example tools stand for calls to a real email or payment
    // provider, which need a backend credential: routed like lookup_customer,
    // so their side effect never happens in a tab.
    if ((UNSAFE_TOOL_NAMES as readonly string[]).includes(tool.name)) return backendOnly(tool);
    return tool;
  });
  return [...tools, lookupCustomer(env), ...(hands === 'machine' ? [runOnMachine(env)] : [])];
}

/**
 * `run_on_machine` alone, for a session whose brain stays in a Function
 * (the demo's Server brain with Virtual + machine hands): next to the
 * harness's own tools on its virtual workspace (`virtual()`, the same
 * `hw.workspace` document), whose files it syncs into the session's VM and
 * back with the call. Its `requires: 'sandbox'` routes nothing in a harness
 * with no lanes: it runs in the Function that drives the session.
 */
export function runOnMachineTool(env: HybridToolsEnv): HostTool {
  return runOnMachine(env);
}

function backendOnly(tool: HostTool): HostTool {
  return {
    ...tool,
    requires: 'function',
    needs: ['secrets'],
    async execute(input, io) {
      if ((io.ctx.lane ?? 'function') === 'browser') {
        throw new Error(`${tool.name} reached the browser lane: it needs the function lane and must never run client-side`);
      }
      return tool.execute(input, io);
    },
  };
}

function lookupCustomer(env: HybridToolsEnv): HostTool<{ query: string }> {
  return {
    name: 'lookup_customer',
    label: 'Look up customer',
    description: LOOKUP_CUSTOMER_DESCRIPTION,
    inputSchema: Type.Object({
      query: Type.String({ description: 'Customer id (e.g. cus_123), email, or company name.' }),
    }),
    replay: 'safe',
    requires: 'function',
    needs: ['secrets'],
    async execute({ query }, io) {
      if (env.lane === 'browser') {
        throw new Error('lookup_customer reached the browser lane: it needs the function lane and must never run client-side');
      }
      const secret = env.secrets?.crmSecret ?? serverEnv('HYBRID_CRM_SECRET');
      if (!secret) throw new Error('lookup_customer: HYBRID_CRM_SECRET is not set on the server');
      const record = await customerRecord(secret, query);
      const lane = io.ctx.lane ?? env.lane;
      return [
        `CRM record for ${JSON.stringify(query)}. Looked up server-side (${lane} lane) with the backend-only HYBRID_CRM_SECRET credential, which never reaches the browser.`,
        JSON.stringify(record, null, 2),
      ].join('\n');
    },
  };
}

interface RunInput {
  command: string;
  timeoutSeconds?: number;
}

/**
 * `run_on_machine`: the one tool that reaches a real machine. Attached:
 * the call syncs the workspace into the session's VM, runs the command,
 * waits for it, and syncs what it changed back, all inside the call, on the
 * virtual workspace as the call sees it (`DocWorkspace.run`). So the files
 * it brings back ride on its own outcome (`io.docs`): a call that throws or
 * never reports (a crash) brought nothing back, and its retry starts from
 * the workspace the first attempt saw.
 *
 * Its timeout is capped at the time the drive has left (`ctx.deadline`)
 * minus `marginMs`: a requested timeout that does not fit is an error
 * before anything runs, never an interruption a `safe` rerun would repeat.
 */
function runOnMachine(env: HybridToolsEnv): HostTool<RunInput> {
  const maxSeconds = env.maxCommandSeconds ?? (Number(serverEnv('HYBRID_SANDBOX_MAX_COMMAND_SECONDS')) || 1800);
  const marginMs = env.marginMs ?? 10_000;
  const runtime = workspaceRuntime({ kind: 'virtual', durable: true }, env.isolation ? { isolation: env.isolation } : {});
  return {
    name: 'run_on_machine',
    label: 'Machine',
    description: RUN_ON_MACHINE_DESCRIPTION,
    inputSchema: Type.Object({
      command: Type.String({ description: 'The command, run with bash -l in /workspace.' }),
      timeoutSeconds: Type.Optional(
        Type.Number({
          description: `Kill the command after this many seconds. Default ${DEFAULT_COMMAND_SECONDS} (less when the call has less time left), at most ${maxSeconds}, and it must fit in the time the call has left: the error says how much that is when it does not.`,
        })
      ),
    }),
    // Safe to rerun: what a command changes that the session keeps is the
    // workspace, and it comes back only with the call's outcome. A retry
    // starts from the log's workspace, with the interrupted attempt's
    // command killed first. Machine state outside the workspace (installed
    // packages, build output) is a cache, not session state.
    replay: 'safe',
    // A machine: the sandbox lane where one is live (its in-VM host), else
    // the function lane, which reaches the VM through the Sandbox API. The
    // harness adapters pass `requires` on (the kernel reads it as `needs`).
    requires: 'sandbox',
    needs: ['machine'],
    async execute(input, io) {
      // Everything that can refuse the call does so before anything runs.
      if (env.lane === 'browser' || (io.ctx.lane ?? env.lane) === 'browser') {
        throw new Error('run_on_machine reached the browser lane, which has no machine: it needs the function lane');
      }
      const provider = env.sandbox;
      if (!provider) throw new Error(`run_on_machine reached the ${io.ctx.lane ?? env.lane} lane, which has no sandbox provider`);
      if (provider.callback !== undefined) {
        throw new Error(
          "run_on_machine: its sandbox provider has a push callback configured, which would let the VM's egress proxy carry the deployment's protection bypass. Build it with callback: undefined. Nothing ran."
        );
      }
      if (typeof input?.command !== 'string' || !input.command.trim()) throw new Error('run_on_machine: command must be a non-empty string');
      const seconds = commandSeconds(input.timeoutSeconds, maxSeconds, secondsLeft(io, marginMs), marginMs);
      return runtime.run(io, 'write', (machine) => onMachine({ provider, io, machine, command: input.command, seconds, marginMs }));
    },
    [WORKSPACE_TOOL]: true,
  } as HostTool<RunInput>;
}

/** Seconds the call has for a command: its drive's deadline less the margin (Infinity with no deadline). */
function secondsLeft(io: HostToolIO, marginMs: number): number {
  const deadline = io.ctx.deadline;
  return deadline === undefined ? Infinity : Math.floor((deadline - Date.now() - marginMs) / 1000);
}

/**
 * The command's timeout: what the model asked for if it fits, the default
 * (or what is left, if less) if it asked for none. Throws, before anything
 * runs, when it asked for more than is left, or when there is no time left.
 */
export function commandSeconds(requested: number | undefined, maxSeconds: number, left: number, marginMs: number): number {
  const kept = `${Math.round(marginMs / 1000)} s kept for copying files back`;
  if (requested !== undefined) {
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 1) {
      throw new Error('run_on_machine: timeoutSeconds must be a number of seconds, at least 1. Nothing ran.');
    }
    const asked = Math.ceil(requested);
    if (asked > maxSeconds) throw new Error(`run_on_machine: timeoutSeconds is at most ${maxSeconds}. Nothing ran.`);
    if (asked > left) {
      throw new Error(
        `run_on_machine: a ${asked} s timeout does not fit in this call: the server function running it has about ${Math.max(0, left)} s left (${kept}). Nothing ran. Ask for at most ${Math.max(0, left)} s, or split the work into shorter commands.`
      );
    }
    return asked;
  }
  if (left < MIN_COMMAND_SECONDS) {
    throw new Error(`run_on_machine: this call has no time left for a command (about ${Math.max(0, left)} s, ${kept}). Nothing ran: call it again.`);
  }
  return Math.min(DEFAULT_COMMAND_SECONDS, maxSeconds, left);
}

interface OnMachine {
  provider: SandboxProvider;
  io: HostToolIO;
  /** The virtual workspace as this call sees it: what changes here commits with the call. */
  machine: WorkspaceMachine;
  command: string;
  seconds: number;
  marginMs: number;
}

/** The call's work, inside `DocWorkspace.run`: to the VM and back. */
async function onMachine({ provider, io, machine, command, seconds, marginMs }: OnMachine): Promise<string> {
  const runId = io.ctx.runId;
  const stepId = io.stepId ?? `call_${Date.now().toString(36)}`;
  const signal = io.signal;
  // The workspace as the log has it: text files, and binary ones (written as bytes, never brought back).
  const fold = new Map<string, string>();
  const binary = new Map<string, Uint8Array>();
  for (const entry of await machine.walk(WORKSPACE_ROOT)) {
    if (entry.type !== 'file' || entry.link || !isWorkspacePath(entry.path)) continue;
    const bytes = await machine.readFile(entry.path);
    const content = asContent(bytes);
    if (typeof content === 'string') fold.set(entry.path, content);
    else binary.set(entry.path, bytes);
  }

  // A retry of an attempt that was cut off (its function died): kill that
  // attempt's command first, so it no longer changes /workspace, and
  // reconnect (a cached connection may name a VM that stopped).
  const prior = io.ctx.state().effectOrder.find((e) => e.stepId === stepId)?.retryOf;
  if (prior) provider.invalidate?.(runId);
  let handle = await provider.open(runId);
  if (prior) {
    await handle.killCommand({ cmdId: (await priorCommand(io, prior)) ?? '', jobDir: jobDirFor(prior) }).catch(() => {});
    // What it created that the log never had would otherwise sit in this run's baseline, and never come back.
    const removed = await cleanUpPriorAttempt(handle, prior, new Set([...trackedPaths(io.ctx.state()), ...fold.keys()])).catch(() => []);
    io.progress({ machine: handle.name, phase: 'retry', after: prior, removed });
  }

  let reran: string | undefined;
  for (let attempt = 0; ; attempt++) {
    let timeout = seconds;
    if (attempt > 0) {
      // A second run must still fit.
      const left = secondsLeft(io, marginMs);
      if (left < Math.min(seconds, MIN_COMMAND_SECONDS * 2)) {
        throw new EffectInterrupted(
          `interrupted: the machine stopped while the command was running (${reran}), and this call has no time left to run it again on a new one. It may or may not have taken effect; the workspace is as it was before the call.`
        );
      }
      timeout = Math.min(seconds, left);
    }
    try {
      const tracked = new Set([...trackedPaths(io.ctx.state()), ...(await trackedOn(handle))]);
      const job: SandboxJob = { runId, stepId, key: `tool:${stepId}`, command, timeoutSeconds: timeout, startedAt: Date.now() };
      io.progress({ machine: handle.name, phase: 'sync' });
      const synced: SyncIn = await syncIn(handle, WORKSPACE_ROOT, fold, tracked, (baseline) => [
        ...jobFiles(job, baseline),
        ...[...binary].map(([path, content]) => ({ path, content })),
        trackedFile(tracked, fold.keys(), binary.keys()),
      ]);
      // The VM must outlive the command (and its report).
      await handle.ensureTimeout?.((timeout + 300) * 1000).catch(() => {});
      const started = await handle.start(job);
      io.progress({ machine: handle.name, phase: 'run', cmdId: started.cmdId, command });
      const jobDir = jobDirFor(stepId);
      // Never waited on past the drive's deadline (plus a little): what is left is for the copy back.
      const until = io.ctx.deadline === undefined ? Infinity : io.ctx.deadline + PAST_DEADLINE_MS;
      const upTo = (ms: number) => Math.max(0, Math.min(ms, until - Date.now()));
      let done = await waitFor(handle, started.cmdId, upTo(timeout * 1000 + REPORT_GRACE_MS), signal);
      if (!done) {
        // Past its own timeout and the wrapper's grace: kill its process group, and let the wrapper report.
        await handle.killCommand({ cmdId: started.cmdId, jobDir }).catch(() => {});
        done = await waitFor(handle, started.cmdId, Math.max(1000, upTo(KILL_GRACE_MS)), signal);
      }
      if (signal.aborted) {
        // Cancelled (the drive lost the session): stop the command, bring nothing back.
        await handle.killCommand({ cmdId: started.cmdId, jobDir }).catch(() => {});
        throw signal.reason ?? new Error('run_on_machine: the call was cancelled');
      }
      let report: SandboxReport | undefined = (await handle.readJob(jobDir, { result: true })).result;
      let note = reran ? `the machine was replaced while the command first ran (${reran}); this is the result of running it again on a new one, from the workspace` : undefined;
      if (!report) {
        const output = await handle.readJob(jobDir, { output: true });
        report = reportFromOutput(done?.exitCode ?? 137, output.stdout ?? '', output.stderr ?? '');
        note = [note, 'the command was killed before it could report; its output was read from the machine'].filter(Boolean).join('; ');
      }
      const back = await syncOut(handle, WORKSPACE_ROOT, synced.baseline);
      // Into the virtual workspace: it commits with this call's outcome.
      const kept: Record<string, string | null> = {};
      const skipped = [...back.skipped];
      const refused = [...back.refused];
      for (const [path, content] of Object.entries(back.files)) {
        if (!isWorkspacePath(path)) {
          refused.push(path.slice(0, 256));
          continue;
        }
        try {
          if (content === null) await machine.remove(path, { force: true });
          else await machine.writeFile(path, content);
          kept[path] = content;
        } catch (err) {
          skipped.push(`${path} (${err instanceof Error ? err.message.slice(0, 120) : 'not written'})`);
        }
      }
      // The VM's list of what it has had from the log: what it had, plus what it has now.
      const now = new Set([...tracked, ...fold.keys(), ...binary.keys(), ...Object.keys(kept)]);
      await handle.writeFiles([trackedFile(now, [], [])]).catch(() => {});
      return formatResult(handle.name, provider.kind, report, { files: kept, skipped, refused }, timeout, note);
    } catch (err) {
      if (!(err instanceof SandboxLostError) || signal.aborted) throw err;
      if (attempt > 0) {
        throw new EffectInterrupted(
          `interrupted: the machine stopped again while the command ran (${err.code ?? err.phase}). It may or may not have taken effect; the workspace is as it was before the call.`
        );
      }
      // The VM went away (before the command, or under it): the workspace
      // is still the log's, so run it once more on a resumed or new VM,
      // exactly as one clean run would (the call is `safe`).
      reran = err.code ?? err.phase;
      provider.invalidate?.(runId);
      handle = await provider.open(runId);
      io.progress({ machine: handle.name, phase: 'reconnect', after: err.message });
    }
  }
}

/**
 * Before a retry of a cut-off `run_on_machine`: remove the files the first
 * attempt's command created under /workspace that the log does not track
 * (anything new since its baseline). The sync that follows restores every
 * tracked file from the log, so the retry runs against the workspace the
 * first attempt saw, and what it creates is new against its own baseline
 * (so it comes back). Untracked files the first attempt modified in place
 * cannot be restored (the log never had them); those are machine state, not
 * the session's. Returns the removed paths. Kill the attempt's command
 * first.
 */
export async function cleanUpPriorAttempt(handle: SandboxHandle, priorStepId: string, tracked: Set<string>): Promise<string[]> {
  const job = await handle.readJob(jobDirFor(priorStepId), { baseline: true });
  if (!job.baselineText) return [];
  let before: Record<string, string>;
  try {
    before = JSON.parse(job.baselineText) as Record<string, string>;
  } catch {
    return [];
  }
  const now = await handle.manifest(WORKSPACE_ROOT, { skipDirs: SANDBOX_SKIP_DIRS });
  const created = [...now.keys()].filter((p) => !(p in before) && !tracked.has(p) && isWorkspacePath(p));
  if (created.length) await handle.remove(created);
  return created;
}

/** Wait for a command until `ms` passes or the call is cancelled (`undefined`: still running). */
async function waitFor(handle: SandboxHandle, cmdId: string, ms: number, signal: AbortSignal): Promise<{ exitCode: number } | undefined> {
  if (signal.aborted) return undefined;
  let onAbort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([handle.waitFor(cmdId, ms), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** The paths the VM's list names (bounded; only paths under /workspace). */
async function trackedOn(handle: SandboxHandle): Promise<string[]> {
  const text = (await handle.readJob(TRACKED_DIR, { baseline: true }).catch(() => ({ baselineText: undefined }))).baselineText;
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && isWorkspacePath(p)).slice(0, MAX_TRACKED) : [];
  } catch {
    return [];
  }
}

function trackedFile(...groups: Iterable<string>[]): { path: string; content: string } {
  const all = new Set<string>();
  for (const group of groups) for (const path of group) if (all.size < MAX_TRACKED) all.add(path);
  return { path: TRACKED_FILE, content: JSON.stringify([...all]) };
}

/** The command id an interrupted attempt reported (`io.progress`), from its progress stream. */
async function priorCommand(io: HostToolIO, priorStepId: string): Promise<string | undefined> {
  const chunks = await readJsonLines(io.ctx.world, io.ctx.runId, effectStreamName(io.ctx.runId, priorStepId)).catch(() => [] as unknown[]);
  // A harness may wrap progress chunks (Pi records `{ content, details: chunk }`).
  const cmdIdOf = (c: unknown): string | undefined => {
    if (typeof c !== 'object' || c === null) return undefined;
    const { cmdId, details } = c as { cmdId?: unknown; details?: unknown };
    return typeof cmdId === 'string' ? cmdId : cmdIdOf(details);
  };
  return chunks.map(cmdIdOf).findLast((id) => id !== undefined);
}

function serverEnv(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

const FIRST = ['Ada', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Guido', 'Frances'];
const LAST = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'van Rossum', 'Allen'];
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Industries', 'Wayne Enterprises', 'Soylent', 'Tyrell', 'Cyberdyne'];
const PLANS = ['hobby', 'pro', 'pro', 'enterprise'] as const;
const STATUSES = ['active', 'active', 'active', 'past_due', 'trialing'] as const;

/**
 * A deterministic fake CRM: every field is derived from
 * HMAC-SHA256(secret, query), so the same backend secret always returns the
 * same customer, and without the secret there is nothing to compute.
 */
export async function customerRecord(secret: string, query: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(query.trim().toLowerCase())));
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const pick = <T>(list: readonly T[], i: number) => list[b[i]! % list.length]!;
  const first = pick(FIRST, 0);
  const last = pick(LAST, 1);
  const company = pick(COMPANIES, 2);
  const plan = pick(PLANS, 3);
  const mrr = plan === 'hobby' ? 0 : plan === 'pro' ? 20 * (1 + (b[4]! % 25)) : 1000 + 250 * (b[4]! % 40);
  const since = new Date(Date.UTC(2019 + (b[5]! % 7), b[6]! % 12, 1 + (b[7]! % 28)));
  return {
    id: /^cus_/i.test(query.trim()) ? query.trim() : `cus_${hex.slice(0, 12)}`,
    name: `${first} ${last}`,
    email: `${first}.${last.replace(/\s+/g, '')}@${company.toLowerCase().replace(/\s+/g, '')}.example`.toLowerCase(),
    company,
    plan,
    status: pick(STATUSES, 8),
    mrrUsd: mrr,
    customerSince: since.toISOString().slice(0, 10),
    accountManager: `${pick(FIRST, 9)} ${pick(LAST, 10)}`,
    openSupportTickets: b[11]! % 5,
  };
}
