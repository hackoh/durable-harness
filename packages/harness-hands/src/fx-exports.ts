/**
 * libfx's kernel tools on a workspace (fx-tools.ts): for the kernel's fx
 * harness (`fxHostTools`) and for libfx's own durable agent
 * (`fxAgentTools`; on a sandbox, fx-sandbox.ts), with the vendored names,
 * schemas and descriptions (fx-specs.ts). No just-bash at import.
 */
export {
  FX_MEMORY_NOTE,
  FX_TOOL_DEFS,
  type FxAgentTool,
  type FxAgentToolsOptions,
  fxAgentTools,
  type FxCallContext,
  fxHostTools,
  type FxResult,
  type FxRichResult,
  type FxToolDef,
  type FxWorkspaceRecord,
  foldFxRecords,
  fxWorkspaceStreamName,
  globMatches,
  LIBFX_WORKFLOW,
  readFxRecords,
  readFxWorkspace,
} from './fx-tools.ts';
export { applyEdits, FX_DESCRIPTIONS, FX_EDITS, FX_SCHEMAS, FX_SOURCE, FX_TOOL_NAMES, type FxEdit, fxDescription, type FxToolName } from './fx-specs.ts';
export {
  type FxAcquire,
  type FxAcquireRequest,
  type FxMachineRecord,
  type FxRecordStore,
  FX_NO_INTENT,
  FX_SUPERSEDED,
  fxSandboxStreamName,
} from './fx-sandbox.ts';
