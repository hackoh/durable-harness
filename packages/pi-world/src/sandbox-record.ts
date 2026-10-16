import type { StorageWrite } from '@earendil-works/pi-durable';

/**
 * A pi-durable session's sandbox record, as its log has it: what the sandbox
 * tier keeps about the session's Vercel Sandbox (harness-world-process'
 * `MachineRecord`: the Drive's id, the VM time granted so far, whether the
 * model still has to be told its files were lost; docs/workspaces.md §5.7).
 * The kernel keeps it in its `hw.sandbox` document; a pi-durable session
 * keeps it in its journal (storage.ts `SandboxEntry`), written in-band like a
 * commit, so a writer that lost the session can't write it.
 *
 * The model is told the files were lost in a tool result, and the record
 * says so once that result commits: the result's `details` name the Drive
 * the model was told about (`SANDBOX_DETAILS_KEY`, `told`), and folding the
 * result clears `filesLost` when it is that Drive. A turn that failed before
 * the model saw the note leaves it set, so the next one tells it again. No
 * Node APIs here.
 */

/** Where a tool result's `details` names the Drive whose loss the model was told about. */
export const SANDBOX_DETAILS_KEY = 'hw.sandbox';

/** A record, as the sandbox tier writes it (plain JSON). */
export type SandboxRecordValue = Readonly<Record<string, unknown>>;

/** The sandbox details of a tool result's `details`, if any. */
export function toldOf(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return undefined;
  const value = (details as Record<string, unknown>)[SANDBOX_DETAILS_KEY];
  const told = typeof value === 'object' && value !== null ? (value as { told?: unknown }).told : undefined;
  return typeof told === 'string' ? told : undefined;
}

/** The session's sandbox record: the newest one written, with the notes the model was told acknowledged. */
export class SessionSandbox {
  #record: SandboxRecordValue | undefined;

  /** The record (a frozen copy), or undefined when none was written. */
  get record(): SandboxRecordValue | undefined {
    return this.#record;
  }

  /** The record a sandbox entry wrote. */
  set(record: unknown): void {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return;
    this.#record = Object.freeze(JSON.parse(JSON.stringify(record)) as Record<string, unknown>);
  }

  /** Fold in a commit's tool results: one that told the model about the Drive the record says was lost acknowledges it. */
  fold(writes: readonly StorageWrite[]): void {
    for (const w of writes) {
      if (w.type !== 'entry' || w.value.kind !== 'pi.tool-result') continue;
      const told = toldOf((w.value.model?.[0] as { details?: unknown } | undefined)?.details);
      if (told === undefined || this.#record?.filesLost !== told) continue;
      const { filesLost: _told, ...rest } = this.#record;
      this.#record = Object.freeze(rest);
    }
  }
}
