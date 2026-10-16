import type { HostTool } from 'harness-world';
import type { WorkspaceDescriptor } from './runtime.ts';
import { type UnsafeToolsOptions, unsafeTools } from './unsafe.ts';
import { docWorkspaceTools } from './virtual-tools.ts';

/**
 * The tools and their readers, with no just-bash at import: the workspace
 * loads it when its first tool call runs. `harness-world-hands` re-exports
 * all of this plus the legacy workspace (legacy.ts).
 */

export { DocWorkspace } from './doc-workspace.ts';
export { docWorkspaceTools } from './virtual-tools.ts';
export {
  type CallMode,
  describeTool,
  EPHEMERAL_NOTE,
  RESET_NOTE,
  type TurnPosition,
  turnOf,
  TurnWorkspaces,
  VIRTUAL_NOTE,
  type WorkspaceDescriptor,
  workspaceInstructions,
  type WorkspaceRuntime,
  type WorkspaceRuntimeOptions,
  workspaceRuntime,
  type WorkspaceToolDef,
} from './runtime.ts';
export { createMachine, type Isolation, MACHINE_DEFAULTS, type MachineLimits, machineIsolation, type MachineOptions, VirtualMachine } from './isolation.ts';
export type { DirEntry, ExecOptions, ExecResult, PathStat, PathType, WalkEntry, WorkspaceMachine } from './machine.ts';
export { docTools } from './doc-tools.ts';
export {
  type BlobEntry,
  DEFAULT_FILE_MODE,
  type FileChanges,
  type FileEntry,
  type FsInput,
  fileChangesOf,
  filesFromState,
  hasWorkspaceDoc,
  INLINE_FILE_MAX_BYTES,
  type InlineEntry,
  isBlobEntry,
  isWorkspacePath,
  legacyFiles,
  MANIFEST_INLINE_BUDGET_BYTES,
  manifestEntries,
  readWorkspace,
  WorkspaceDoc,
  type WorkspaceFile,
  type WorkspaceManifest,
  workspaceManifest,
} from './files.ts';
export { TOOL_SPECS, UNSAFE_CONFIRM_MS, UNSAFE_TOOL_NAMES, type UnsafeToolName, WORKSPACE_ROOT } from './specs.ts';
export { type LedgerRecord, ledgerStreamName, readLedger, type UnsafeToolsOptions, unsafeTools } from './unsafe.ts';

export interface WorkspaceToolsOptions extends UnsafeToolsOptions {
  /** Where the files live: the session's log (default, `{ kind: 'virtual', durable: true }`), or memory for one turn (`durable: false`). */
  workspace?: WorkspaceDescriptor;
}

/**
 * bash, read_file, write_file, edit_file and list_files on a virtual
 * workspace (all `replay: 'safe'`; by default the document-backed one), plus
 * the two non-idempotent example tools, unsafe_send_email and
 * unsafe_make_payment (`replay: 'never'`, unsafe.ts).
 */
export function workspaceTools(options: WorkspaceToolsOptions = {}): HostTool[] {
  const { workspace, ...unsafe } = options;
  return [...docWorkspaceTools(workspace), ...unsafeTools(unsafe)];
}
