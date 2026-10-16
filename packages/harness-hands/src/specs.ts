import { Type } from 'typebox';

/**
 * The workspace tools as the model sees them: name, label, description and
 * input schema. The durable tools (`workspaceTools`) and the native baseline
 * (`harness-world-hands/native`) both build on these, so the two send the
 * model byte-identical tool definitions and a comparison between them
 * measures the harness, not the prompt.
 */
export const TOOL_SPECS = {
  bash: {
    name: 'bash',
    label: 'Bash',
    description:
      'Run a bash command in the workspace (a bash-compatible shell over this session\'s files at /workspace, with coreutils, grep, sed, awk, jq, and more). Returns the exit code, stdout, and stderr. It runs in a virtual workspace, not real Linux: no network, no package installs, no real processes.',
    inputSchema: Type.Object({ command: Type.String({ description: 'The command to run.' }) }),
  },
  read_file: {
    name: 'read_file',
    label: 'Read file',
    description: 'Read a file from the workspace.',
    inputSchema: Type.Object({ path: Type.String() }),
  },
  write_file: {
    name: 'write_file',
    label: 'Write file',
    description: 'Create or overwrite a file in the workspace.',
    inputSchema: Type.Object({ path: Type.String(), content: Type.String() }),
  },
  edit_file: {
    name: 'edit_file',
    label: 'Edit file',
    description: 'Replace one exact occurrence of oldText with newText in a workspace file.',
    inputSchema: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
  },
  list_files: {
    name: 'list_files',
    label: 'List files',
    description: 'List every file in the workspace.',
    inputSchema: Type.Object({}),
  },
  // Two deliberately NOT idempotent example tools (see unsafe.ts): each call
  // is an external side effect, so a rerun would do it twice.
  unsafe_send_email: {
    name: 'unsafe_send_email',
    label: 'Send email (unsafe)',
    description:
      'Send an email (a demo stand-in for a real, non-idempotent side effect: every call sends one more email). Only call this when the user explicitly asks you to send an email, and call it once per email.',
    inputSchema: Type.Object({
      to: Type.String({ description: 'Recipient email address.' }),
      subject: Type.String(),
      body: Type.String(),
    }),
  },
  unsafe_make_payment: {
    name: 'unsafe_make_payment',
    label: 'Make payment (unsafe)',
    description:
      'Send a payment (a demo stand-in for a real, non-idempotent side effect: every call moves money once more). Only call this when the user explicitly asks you to make a payment, and call it once per payment.',
    inputSchema: Type.Object({
      to: Type.String({ description: 'Who to pay (an email address).' }),
      amount_usd: Type.Number({ description: 'Amount in US dollars.' }),
      memo: Type.String(),
    }),
  },
} as const;

/** The unsafe example tools' names. */
export const UNSAFE_TOOL_NAMES = ['unsafe_send_email', 'unsafe_make_payment'] as const;
export type UnsafeToolName = (typeof UNSAFE_TOOL_NAMES)[number];

/**
 * How long an unsafe tool waits for its (simulated) provider to confirm,
 * after the side effect happened. Long enough that a crash armed at a tool
 * with the default delay (1.5 s) lands after the side effect and before the
 * result: the case a non-idempotent tool must never rerun.
 */
export const UNSAFE_CONFIRM_MS = 3000;

/** What an unsafe tool reports once its side effect is confirmed. */
export function unsafeResultText(tool: UnsafeToolName, input: Record<string, unknown>, ref: string): string {
  return tool === 'unsafe_send_email'
    ? `email sent to ${String(input.to)} (message id ${ref})`
    : `paid $${Number(input.amount_usd).toFixed(2)} to ${String(input.to)} (payment id ${ref})`;
}

export { VIRTUAL_COMMANDS, WORKSPACE_ROOT } from './paths.ts';
import { WORKSPACE_ROOT } from './paths.ts';

export function resolvePath(path: string): string {
  return path.startsWith('/') ? path : `${WORKSPACE_ROOT}/${path}`;
}

/** The bash tool's result text, shared so both forms report a command the same way. */
export function bashResultText(result: { exitCode: number; stdout: string; stderr: string }): string {
  return [`exit code: ${result.exitCode}`, result.stdout && `stdout:\n${result.stdout}`, result.stderr && `stderr:\n${result.stderr}`]
    .filter(Boolean)
    .join('\n');
}
