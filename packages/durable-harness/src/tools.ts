/**
 * Example tools that ride the same log as the session.
 *
 * `workspaceTools(workspace = virtual())`: `bash` (just-bash: coreutils,
 * grep, sed, awk, jq), `read_file`, `write_file`, `edit_file` and
 * `list_files` on a virtual workspace at `/workspace`: not real Linux (no
 * network, no package installs, no real processes) and nothing of the
 * machine that drives the session. just-bash runs with byte caps and a time
 * limit per command, in a worker thread leased to the session alone, with an
 * empty environment, where one can start (a command past its limit, or still
 * running when its call is cancelled, is stopped with its worker, and its
 * call fails and changes nothing). With `virtual()` (durable) the files are a
 * document of the session (`hw.workspace`: small files inline, files over 4
 * KB in the session's blob stream), and each call that changes files commits
 * the change with its own
 * outcome, so every tool is `replay: 'safe'`, a crash mid-call leaves
 * nothing behind, and a session moves between machines with its files. Good
 * for demos and small workspaces (about 500 files); not for real work (give
 * the agent a Sandbox for that). With `virtual({ durable: false })` the same
 * tools keep their files in memory, cleared at the end of every turn, and
 * write nothing to the log. Install `just-bash`. `workspaceInstructions()`
 * says the same for a system prompt.
 *
 * These are the generic set, for an app's own loop: each harness has its
 * own line for the tools it is tuned for (Pi's is `createCodingTools` from
 * `durable-harness/pi`). Claude Code and Codex take neither: in their
 * sandbox they use their own tools.
 *
 * `docTools([Todos])`: `read_todos` and `update_todos`, for an app's own
 * documents (`defineDoc`). Documents are not shown to a model unless an app
 * gives it tools like these; a process harness (Claude Code, Codex,
 * OpenCode) reads and writes one only through them.
 *
 * ```ts
 * import { docTools, workspaceTools } from 'durable-harness/tools'
 * import { pi } from 'durable-harness/pi'
 * export const agent = pi({ model: 'anthropic/claude-sonnet-4.5', tools: [...workspaceTools(), ...docTools([Todos])] })
 * ```
 */
import type { HostTool } from 'harness-world';
import { docTools, docWorkspaceTools, unsafeTools, type UnsafeToolsOptions, workspaceInstructions as instructionsFor } from 'harness-world-hands/tools';
import { virtual, type Workspace } from './workspace.ts';

export function workspaceTools(workspace: Workspace = virtual()): HostTool[] {
  return docWorkspaceTools(workspace);
}

/** A system-prompt snippet for `workspaceTools(workspace)`: what the workspace is, and how long its files last. */
export function workspaceInstructions(workspace: Workspace = virtual()): string {
  if (workspace.kind !== 'virtual') throw new Error(`durable-harness: workspaceTools() runs on a virtual workspace, not a ${workspace.kind} one`);
  return instructionsFor(workspace.durable);
}

export { docTools };

/**
 * Two deliberately non-idempotent tools for crash drills, `unsafe_send_email`
 * and `unsafe_make_payment` (`replay: 'never'`): each call appends a record
 * to a ledger outside the log (a World stream, `readLedger`), then waits 3 s
 * for a simulated confirmation. Crash a session inside one and the model gets
 * an interrupted result instead of a second record.
 */
export { unsafeTools, type UnsafeToolsOptions };
export {
  filesFromState,
  type LedgerRecord,
  ledgerStreamName,
  readLedger,
  readWorkspace,
  WORKSPACE_ROOT,
  WorkspaceDoc,
  type WorkspaceFile,
  type WorkspaceManifest,
  workspaceManifest,
} from 'harness-world-hands/tools';
/**
 * `readDriveManifest(state)`: a `sandbox()` session's Drive as of its last
 * snapshot (the `hw.sandbox-files` document the sandbox tier writes after
 * each turn that changed it: paths, sizes, mtimes, the text of small files),
 * from the log alone, so it works after the VM stopped. A snapshot: the
 * Drive is the source of truth. Undefined before the first. `readWorkspace`
 * is its counterpart for a `virtual()` session, whose files are the log's.
 */
export { type DriveFile, type DriveSnapshot, readDriveManifest } from 'harness-world-sandbox/files';
export { type SandboxWorkspace, virtual, type VirtualOptions, type VirtualWorkspace, type Workspace, type WorkspaceKind } from './workspace.ts';
export type { HostTool, HostToolIO, ReplayPolicy } from 'harness-world';
