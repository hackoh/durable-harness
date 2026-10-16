/**
 * harness-world-sandbox/cli: what a CLI harness (Claude Code, Codex) takes
 * from the sandbox tier to run on a session's VM (docs/workspaces.md §5.6):
 * the kernel's attach fact (`attachInDrive`, the `hw.sandbox` record, the
 * note acknowledgement), the Drive's manifest (`DriveFiles`,
 * `hw.sandbox-files`) and where the pinned CLIs are in the base image. It
 * loads neither the session factory (which claims the machine brand) nor the
 * relay link nor `@vercel/sandbox`: the harness gets its acquire from
 * whoever resolved the session's `sandbox()` descriptor.
 */
export { acknowledgeInDrive, acknowledgeNotes, attachInDrive, kernelSandbox, SANDBOX_DOC } from './attach.ts';
export { DRIVE_FILES_DOC, DRIVE_FILES_EVENT, DriveFiles, readDriveManifest } from './files.ts';
export type { DriveFile, DriveFilesEvent, DriveFilesOptions, DriveSnapshot } from './files.ts';
export type { KernelSandbox } from './attach.ts';
export { CLAUDE_CLI, CODEX_CLI, cliPath, type PinnedCli } from './clis.ts';
export { CACHE_ROOT, MODEL_PORT, WORKSPACE } from './vm.ts';
