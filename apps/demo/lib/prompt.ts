/**
 * The model and system prompt every lane uses: the durable Function lane,
 * the native baseline, and the eve agent (`agent/agent.ts`,
 * `agent/instructions.ts`). No imports, so eve's compiler can take it as is.
 */

export const MODEL = process.env.HARNESS_MODEL ?? 'anthropic/claude-opus-5.5-fast';

const DURABLE = 'Keep answers short. Your session is durable: it can be interrupted and resumed at any point.';

/** A virtual workspace (`virtual()`): just-bash over the session's files, in the Function, not a real machine. */
export const INSTRUCTIONS = `You are a coding agent working in a virtual workspace at /workspace: an emulated shell over the session's files, not a real machine.
Use the tools to inspect and change files, and run commands with bash.
${DURABLE}`;

/**
 * The system prompt for a session's hands (the demo's Hands axis): what
 * its tools reach. `virtual` is `INSTRUCTIONS`.
 */
export function instructionsFor(hands: 'none' | 'virtual' | 'ephemeral' | 'machine' | 'sandbox'): string {
  switch (hands) {
    case 'none':
      return `You are an assistant with no workspace: no files and no shell. Use the tools you have when the user asks for what they do.\n${DURABLE}`;
    case 'ephemeral':
      return `You are a coding agent working in a virtual workspace at /workspace: an emulated shell over files kept in memory, cleared at the end of every turn.
Use the tools to inspect and change files, and run commands with bash.
${DURABLE}`;
    case 'machine':
      return `You are a coding agent working in a virtual workspace at /workspace: an emulated shell over the session's files, not a real machine.
Use the tools to inspect and change files, and run commands with bash. For a real Linux machine (node, npm, python, git, network), use run_on_machine: the workspace files are copied to it and back.
${DURABLE}`;
    case 'sandbox':
      return `You are a coding agent working in /workspace on this session's own Linux machine (a Vercel Sandbox VM): its files are on a disk that outlives the machine.
Use your tools to inspect and change files, and to run commands.
${DURABLE}`;
    default:
      return INSTRUCTIONS;
  }
}
