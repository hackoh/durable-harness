import {
  type EffectRecord,
  effectStreamName,
  type OwnerPolicy,
  type OwnerVerdict,
  readJsonLines,
  type SessionLog,
  type Settlement,
  settleParked,
} from 'harness-world';
import { filesFromState, isWorkspacePath, WORKSPACE_ROOT } from 'harness-world-hands';
import { claimDropCallback, type OwnerContext } from 'harness-world';

type World = OwnerContext['world'];
import { reportFromOutput, streamText } from './sandbox-job.ts';
import {
  type Inspection,
  type SandboxHandle,
  SandboxLostError,
  type SandboxOwner,
  type SandboxProvider,
  type SandboxReport,
  sha256Hex,
  syncOut,
} from './sandbox-sync.ts';

/**
 * Collecting a parked `sandbox_exec`: read what the command left in the VM
 * (its report, and what it changed under /workspace against the baseline it
 * started from) and commit it as one `settle` step, so the result and the
 * workspace diff land together. Every collector (the function's inline grace,
 * a push from the VM, an owner check) reads the same finished
 * command, so they compute the same settlement, and the fold keeps the first.
 */

export type Computed =
  | { state: 'settled'; settlement: Settlement }
  | { state: 'running' }
  | { state: 'lost'; why: string }
  | { state: 'unknown'; error: string };

function clip(text: string, max = 16_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - max} characters elided] …\n${text.slice(-half)}`;
}

/** The tool's text for a finished command: the same shape `sandbox_exec` always returned. */
export function formatResult(
  sandbox: string,
  providerKind: string,
  report: SandboxReport,
  back: { files: Record<string, string | null>; skipped: string[]; refused?: string[] },
  timeoutSeconds?: number,
  note?: string
): string {
  const changed = Object.keys(back.files);
  const stdout = streamText(report.stdout);
  const stderr = streamText(report.stderr);
  const code =
    report.exitCode === 137
      ? `${report.exitCode} (killed, signal 9)`
      : report.timedOut
        ? `${report.exitCode} (timed out after ${timeoutSeconds ?? '?'}s)`
        : String(report.exitCode);
  return [
    `sandbox: ${sandbox} (${providerKind})`,
    `exit code: ${code}`,
    note,
    stdout && `stdout:\n${clip(stdout)}`,
    stderr && `stderr:\n${clip(stderr)}`,
    changed.length > 0 && `workspace files updated from the sandbox: ${changed.join(', ')}`,
    back.skipped.length > 0 && `changed in the sandbox only (binary, too large, or over budget): ${back.skipped.join(', ')}`,
    back.refused?.length && `not copied back (not a path under /workspace): ${back.refused.map((p) => JSON.stringify(p)).join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export interface ComputeOptions {
  /** The report, if it came with the request (a push). Otherwise read from the VM. */
  report?: SandboxReport;
  /** The baseline, if the caller has it in memory (the inline grace). */
  baseline?: Map<string, string>;
  /** A handle on the owner's session, if the caller has one. */
  handle?: SandboxHandle;
  /**
   * The session's files before this command (the fold), for when the
   * baseline read back from the VM cannot be trusted (it does not match the
   * park's `baselineSha256`: the command rewrote it, or it is too big).
   */
  fold?: () => Map<string, string> | Promise<Map<string, string>>;
}

/**
 * The baseline a collector may trust: the job dir's `baseline.json` only if
 * it is exactly what the function wrote (its sha256 is in the park), keys
 * only under the workspace root. Otherwise the fold's own hashes.
 */
async function trustedBaseline(
  owner: SandboxOwner,
  text: string | undefined,
  fold: ComputeOptions['fold']
): Promise<{ baseline: Map<string, string>; trusted: boolean }> {
  if (text !== undefined && owner.baselineSha256 && (await sha256Hex(text)) === owner.baselineSha256) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const baseline = new Map<string, string>();
      for (const [path, hash] of Object.entries(parsed)) {
        if (typeof hash === 'string' && isWorkspacePath(path)) baseline.set(path, hash);
      }
      return { baseline, trusted: true };
    } catch {}
  }
  const files = (await fold?.()) ?? new Map<string, string>();
  const baseline = new Map<string, string>();
  for (const [path, content] of files) if (isWorkspacePath(path)) baseline.set(path, await sha256Hex(content));
  return { baseline, trusted: false };
}

/**
 * What a parked command's settlement is right now, read from the VM. Never
 * resumes a stopped VM: a VM that is gone is `lost`, and the caller recovers.
 *
 * Reads only what it needs, and never more than `JOB_READ_LIMITS` of any job
 * file: a push already carries the report (so only the baseline is read);
 * the command's raw output is read only when the wrapper was killed before
 * it could write `result.json`.
 */
export async function computeSettlement(
  provider: SandboxProvider,
  owner: SandboxOwner,
  by: Settlement['by'],
  options: ComputeOptions = {}
): Promise<Computed> {
  try {
    const handle = options.handle ?? (await provider.attach(owner));
    if (handle === 'lost') return { state: 'lost', why: 'the VM is no longer running' };
    let report = options.report;
    const job = await handle.readJob(owner.jobDir, { result: !report, baseline: !options.baseline });
    let note: string | undefined;
    report ??= job.result;
    if (!report) {
      // No result.json: the wrapper itself was killed (or has not finished).
      const seen = await provider.inspect(owner);
      if (seen.state === 'running') return { state: 'running' };
      if (seen.state === 'lost') return { state: 'lost', why: describeLoss(seen) };
      if (seen.state === 'unknown') return { state: 'unknown', error: seen.error };
      const output = await handle.readJob(owner.jobDir, { output: true });
      report = reportFromOutput(seen.exitCode, output.stdout ?? '', output.stderr ?? '');
      note = 'the command was killed before it could report; its output was read from the sandbox';
    }
    let baseline = options.baseline;
    if (!baseline) {
      const got = await trustedBaseline(owner, job.baselineText, options.fold);
      baseline = got.baseline;
      if (!got.trusted) {
        note = [note, "the job's baseline was changed in the sandbox, so changes were measured against the session's files"]
          .filter(Boolean)
          .join('; ');
      }
    }
    const back = await syncOut(handle, WORKSPACE_ROOT, baseline);
    return {
      state: 'settled',
      settlement: {
        ok: true,
        by,
        at: Date.now(),
        cmdId: owner.cmdId,
        exitCode: report.exitCode,
        files: back.files,
        skipped: back.skipped,
        value: formatResult(owner.sandbox, provider.kind, report, back, owner.timeoutSeconds, note),
      },
    };
  } catch (err) {
    if (err instanceof SandboxLostError) return { state: 'lost', why: err.code ?? err.message };
    return { state: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
}

function describeLoss(seen: Extract<Inspection, { state: 'lost' }>): string {
  switch (seen.why) {
    case 'deleted':
      return 'the sandbox was deleted';
    case 'stopped':
      return 'the VM stopped';
    case 'replaced':
      return 'the VM stopped and was replaced by a new session';
    case 'command-missing':
      return 'the VM no longer knows the command';
  }
}

/**
 * The settlement for a command whose VM went away under it: interrupted (it
 * may or may not have taken effect), with whatever it streamed.
 */
export async function lostSettlement(
  world: World,
  log: SessionLog,
  record: EffectRecord,
  owner: SandboxOwner,
  why: string,
  by: Settlement['by']
): Promise<Settlement> {
  const partial = await readJsonLines(world, log.runId, effectStreamName(log.runId, record.stepId)).catch(() => []);
  return {
    ok: false,
    by,
    at: Date.now(),
    cmdId: owner.cmdId,
    error: {
      interrupted: true,
      message: [
        `interrupted: the sandbox VM stopped while the command was running (${why}).`,
        "The next sandbox_exec restores /workspace from the session's files on a resumed or new VM; changes this command made were not recorded.",
        'It may or may not have taken effect.',
      ].join(' '),
      partial,
    },
  };
}

export type CollectOutcome = 'settled' | 'already' | 'running' | 'unknown' | 'lost-settled';

/**
 * Collect a parked record through `log`: compute its settlement (or its
 * loss) and commit it. `settled` / `lost-settled` mean this call's settlement
 * won; `already` that someone else's did (or the record is not parked and
 * running any more).
 */
export async function collectParked(
  world: World,
  provider: SandboxProvider,
  log: SessionLog,
  record: EffectRecord,
  by: Settlement['by'],
  options: ComputeOptions = {}
): Promise<CollectOutcome> {
  const owner = record.park as SandboxOwner | undefined;
  if (!owner || record.status !== 'running' || record.settlement) return 'already';
  const computed = await computeSettlement(provider, owner, by, {
    fold: () => new Map(Object.entries(filesFromState(log.state))),
    ...options,
  });
  if (computed.state === 'running') return 'running';
  if (computed.state === 'unknown') return 'unknown';
  const settlement = computed.state === 'settled' ? computed.settlement : await lostSettlement(world, log, record, owner, computed.why, by);
  await log.refresh();
  const outcome = await settleParked(log, record, settlement);
  if (outcome !== 'won') return 'already';
  return computed.state === 'settled' ? 'settled' : 'lost-settled';
}

export interface SandboxOwnerPolicyOptions {
  provider: SandboxProvider;
  /** Pull mode: how long one owner check waits on the command before looking again. Default 3000. */
  pollWaitMs?: number;
  /** Honor an armed Drop Callback crash. Default true (the chaos route is what arms one). */
  chaos?: boolean;
}

/**
 * Polices parked `sandbox_exec` commands through the Sandbox API (the
 * work's own state, never a drive's liveness): still running (look again; extend the VM; kill it past
 * its deadline), finished but not reported (collect), VM gone (interrupted,
 * the next command restores `/workspace`), or unreachable (look again, then give up as lost).
 */
export function sandboxOwnerPolicy(options: SandboxOwnerPolicyOptions): OwnerPolicy {
  const { provider } = options;
  return {
    kind: 'sandbox',
    async check({ world, log, record, owner: raw, mode, say }): Promise<OwnerVerdict> {
      const owner = raw as SandboxOwner;
      const by: Settlement['by'] = mode === 'backstop' ? 'backstop' : 'check';
      let seen = await provider.inspect(owner);
      const now = Date.now();
      if (seen.state === 'running') {
        if (now > owner.deadlineAt + 30_000) {
          say('sandbox: past its deadline, killing the command', { runId: log.runId, cmdId: owner.cmdId });
          const handle = await provider.attach(owner);
          if (handle !== 'lost') await handle.killCommand({ cmdId: owner.cmdId, jobDir: owner.jobDir }).catch(() => {});
          return { state: 'running', recheckSeconds: 2 };
        }
        const handle = await provider.attach(owner);
        if (handle === 'lost') {
          seen = { state: 'lost', why: 'stopped' };
        } else {
          if (seen.expiresAt !== undefined && seen.expiresAt - now < 3 * 60_000) {
            await handle.ensureTimeout?.(Math.min(10 * 60_000, owner.deadlineAt - now + 5 * 60_000)).catch(() => {});
          }
          if (mode === 'check' && !owner.push) {
            // Pull: wait a little on the command itself, so a finished
            // command is noticed within tens of milliseconds, not a cadence.
            const wait = Math.max(0, Math.min(options.pollWaitMs ?? 3000, owner.deadlineAt + 30_000 - now));
            const done = await handle.waitFor(owner.cmdId, wait).catch(() => undefined);
            if (!done) return { state: 'running', recheckSeconds: 1 };
            seen = { state: 'exited', exitCode: done.exitCode };
          } else {
            // A `backstop` caller (policies written for the retired backstop) looks slowly; owner checks carry the fast path.
            return { state: 'running', recheckSeconds: mode === 'backstop' ? 30 : owner.push ? 5 : 1 };
          }
        }
      }
      if (seen.state === 'exited') {
        // Pull mode's first announcer of completion is this check: a Drop
        // Callback crash discards what it was about to collect.
        if (mode === 'check' && !owner.push && options.chaos !== false && (await claimDropCallback(log, record))) {
          say('chaos: dropped the result report', { runId: log.runId, stepId: record.stepId });
          return { state: 'dropped' };
        }
        const outcome = await collectParked(world, provider, log, record, by);
        if (outcome === 'running' || outcome === 'unknown') return { state: 'unknown', recheckSeconds: 2 };
        say('sandbox: collected', { runId: log.runId, stepId: record.stepId, by, outcome });
        return { state: 'settled' };
      }
      if (seen.state === 'lost') {
        const settlement = await lostSettlement(world, log, record, owner, describeLoss(seen), by);
        await log.refresh();
        const outcome = await settleParked(log, record, settlement);
        say('sandbox: the VM was lost; interrupted', { runId: log.runId, stepId: record.stepId, why: seen.why, outcome });
        // No out-of-band restore here: the drive this settlement wakes may
        // already be editing files and starting its next command, and a
        // restore racing it could put stale content back under that command.
        // The next `sandbox_exec` resumes the VM and syncs /workspace from the
        // log itself, serialized with everything else the drive does.
        return { state: 'settled' };
      }
      // Unreachable. Past the deadline by a minute, stop waiting for it.
      if (now > owner.deadlineAt + 60_000) {
        const settlement = await lostSettlement(world, log, record, owner, `unreachable: ${seen.error}`, by);
        await log.refresh();
        await settleParked(log, record, settlement);
        return { state: 'settled' };
      }
      return { state: 'unknown', recheckSeconds: 5 };
    },
    async fireChaos({ record, kind, say }) {
      const owner = record.park as SandboxOwner;
      if (kind === 'sandbox-vm') {
        await provider.stopVm?.(owner);
        say('chaos: stopped the sandbox VM', { sandbox: owner.sandbox });
      } else if (kind === 'sandbox-command') {
        const handle = await provider.attach(owner);
        if (handle !== 'lost') await handle.killCommand({ cmdId: owner.cmdId, jobDir: owner.jobDir });
        say('chaos: killed the command', { cmdId: owner.cmdId });
      }
    },
  };
}
