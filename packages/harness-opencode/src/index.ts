/**
 * harness-world-opencode: OpenCode v2 as a durable kernel harness on
 * harness-world. See README.md.
 */
export { DEFAULT_INSTRUCTIONS, DEFAULT_MODEL, opencodeBuiltinReplay, opencodeHarness } from './harness.ts';
export type { BuiltinOutcome, HostConnection, OpenCodeHarnessOptions, OpenCodeWorkspace } from './harness.ts';
export { COMMAND_ENV_KEYS, OPENCODE_READ_TOOLS, OPENCODE_TOOLS, WORKSPACE_ROOT } from './environment.ts';
export type { OpenCodeTool } from './environment.ts';
export {
  applyStatus,
  BLOBS,
  blobHashes,
  blobRecordId,
  blobsOf,
  EVENTS,
  eventName,
  eventRecordId,
  eventsOf,
  isTerminal,
  opencodeMessageId,
  opencodeSessionId,
  statusOf,
  TranscriptBuilder,
} from './records.ts';
export type { InstructionBlob, OpenCodeEvent, OpenCodeStatus } from './records.ts';
export type { Channel, FromHost, HostInit, HostToolSpec, ToHost } from './protocol.ts';
export { pipePair } from './protocol.ts';
