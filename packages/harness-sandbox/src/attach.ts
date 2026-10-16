/**
 * The kernel's side of the session factory (docs/workspaces.md §5.4, §5.7):
 * the `sandbox.attach` fact a drive acquires its machine in, the `hw.sandbox`
 * document that holds the session's `MachineRecord`, and the note
 * acknowledgement. Its own module, apart from `session.ts`, so a CLI harness
 * (Claude Code, Codex) can import it without loading the factory: this file
 * claims no brand and loads neither the relay link nor `@vercel/sandbox`.
 */
import { randomUUID } from 'node:crypto';
import { defineDoc, type DriveContext, type EffectIO, Yield } from 'harness-world';
import type { AcquireDrills, AcquireMachine, GatewayHandler, MachineRecord, MachineRecordStore, SessionMachine } from 'harness-world-process';
import { DriveFiles, type DriveFilesOptions } from './files.ts';

/** The kernel's `hw.sandbox` document (`SandboxRecord`): the `MachineRecord` of the session. */
export const SANDBOX_DOC = defineDoc<MachineRecord>({ kind: 'hw.sandbox', version: 1, initial: () => ({}) });

/**
 * Mark the notes of a record as told (`MachineRecord.filesLost` cleared): what
 * a runtime applies to its record once the turn that showed the model
 * `SessionMachine.notes` committed. For the kernel, inside that effect:
 * `io.docs.update(SANDBOX_DOC, (r) => acknowledgeNotes(r, key))`
 * (`acknowledgeInDrive`). `key` is what the notes described
 * (`SessionMachine.notesKey`): a record whose `filesLost` is another Drive
 * (lost again since) is left as it is, so that loss is told too.
 */
export function acknowledgeNotes(record: MachineRecord, key?: string): MachineRecord {
  if (key !== undefined && record.filesLost !== key) return record;
  const { filesLost: _told, ...rest } = record;
  return rest;
}

/**
 * Acquire the session's machine for a kernel drive: inside the body of a
 * `sandbox.attach` fact (a `never` intent, a barrier durable before its body
 * runs), where `ctx.fence()` is read, with the `hw.sandbox` document as the
 * record and the session's recorded config (`ctx.config`) for the factory's
 * admission checks. The fact's outcome records the attach for diagnosis, and commits
 * the record's edits with it, whatever the attach came to: a yield other
 * than `preempted` (contended: a busy Drive, a racing driver) and any other
 * failure are recorded as the outcome and thrown after the fact, as
 * themselves (an `Unavailable` keeps its code, a transport error its code),
 * so VM time granted before them is counted. A `preempted` yield is thrown
 * from the body: that drive writes nothing more.
 */
export async function attachInDrive(ctx: DriveContext, acquire: AcquireMachine, options: { model?: GatewayHandler; deadline?: number } = {}): Promise<SessionMachine> {
  let machine: SessionMachine | undefined;
  let failure: unknown;
  await ctx.effect(`sandbox.attach:${randomUUID()}`, { name: 'sandbox.attach', replay: 'never', input: null }, async (io) => {
    const docs = io.docs;
    const record: MachineRecordStore | undefined = docs
      ? { read: () => ({ ...docs.read(SANDBOX_DOC).value }) as MachineRecord, write: (r) => void docs.update(SANDBOX_DOC, () => ({ ...r }) as MachineRecord) }
      : undefined;
    const drills = drillsFor(ctx, io);
    try {
      machine = await acquire({ sessionId: ctx.runId, config: ctx.config, fence: () => ctx.fence?.(), signal: ctx.signal, ...(record ? { record } : {}), ...(drills ? { drills } : {}), ...options });
      return { attached: true, fence: machine.fence?.count ?? null, notes: machine.notes.length };
    } catch (err) {
      if (err instanceof Yield && err.reason === 'preempted') throw err;
      failure = err;
      return err instanceof Yield ? { attached: false, yield: err.reason } : { attached: false, error: String((err as Error)?.message ?? err).slice(0, 500) };
    }
  });
  if (failure !== undefined) throw failure;
  return machine!;
}

/** The drives whose mid-step drill target is registered (a re-attach in the same drive registers none again). */
const registered = new WeakSet<DriveContext>();

/**
 * The drills a kernel drive runs on the session's sandbox (docs/workspaces.md
 * §8 "Drills"), for the session factory: the attach drills claimed by this
 * attach fact (`io.drill`), and the drive's target for the mid-step ones
 * (`ctx.drills`), registered once per drive. Undefined when the driver runs
 * without chaos.
 */
function drillsFor(ctx: DriveContext, io: EffectIO): AcquireDrills | undefined {
  const claim = io.drill;
  const drills = ctx.drills;
  if (!claim && !drills) return undefined;
  return {
    claim: async (kinds) => (claim ? claim(kinds) : undefined),
    register: (target) => {
      if (!drills || registered.has(ctx)) return;
      registered.add(ctx);
      drills(target);
    },
  };
}

/**
 * Mark the session's notes as told (`acknowledgeNotes` on the `hw.sandbox`
 * document), in a fact of its own: what a kernel harness calls once the turn
 * that showed the model `SessionMachine.notes` committed, so a later attach
 * shows them no more (and a turn that failed before the model saw them shows
 * them again). `key` is the machine's `notesKey`: only the loss it named is
 * cleared.
 */
export async function acknowledgeInDrive(ctx: DriveContext, key?: string): Promise<void> {
  await ctx.effect(`sandbox.notes:${randomUUID()}`, { name: 'sandbox.notes', replay: 'safe', input: key ?? null }, async (io) => {
    io.docs?.update(SANDBOX_DOC, (record) => acknowledgeNotes(record ?? {}, key));
    return { acknowledged: true };
  });
}

/**
 * What a kernel harness that runs in the session's sandbox (Claude Code,
 * Codex) is given: its attach, through the session factory, the
 * acknowledgement of the notes, and the writer of the Drive's manifest
 * (`hw.sandbox-files`, files.ts) for a drive on an attached machine.
 */
export interface KernelSandbox {
  attach(ctx: DriveContext, request: { model?: GatewayHandler; deadline?: number }): Promise<SessionMachine>;
  acknowledge(ctx: DriveContext, key?: string): Promise<void>;
  files(ctx: DriveContext, machine: SessionMachine, options?: DriveFilesOptions): DriveFiles;
}

/** The kernel's binding of a session factory (`sandboxSession`): `attachInDrive`, `acknowledgeInDrive` and a `DriveFiles` over it. */
export function kernelSandbox(acquire: AcquireMachine): KernelSandbox {
  return {
    attach: (ctx, request) => attachInDrive(ctx, acquire, { ...(request.model ? { model: request.model } : {}), ...(request.deadline !== undefined ? { deadline: request.deadline } : {}) }),
    acknowledge: (ctx, key) => acknowledgeInDrive(ctx, key),
    files: (ctx, machine, options) => new DriveFiles(ctx, machine, { ...options, ...(options?.driveId === undefined && ctx.docs ? driveIdOf(ctx) : {}) }),
  };
}

/** The Drive's id, from the session's `hw.sandbox` record. */
function driveIdOf(ctx: DriveContext): { driveId?: string } {
  const id = ctx.docs?.read(SANDBOX_DOC).value.driveId;
  return typeof id === 'string' ? { driveId: id } : {};
}
