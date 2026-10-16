/**
 * What the demo gives its process harnesses besides their hands: the
 * example side-effect tools (`unsafe_send_email`, `unsafe_make_payment`,
 * so the Crash Payment drill has a payment to crash in) and the todo
 * document's tools (`read_todos`, `update_todos`). App HostTools, run in the
 * Function: a process harness's own tools never see documents, and Claude
 * Code and Codex use their own tools on `/workspace` in the VM, never the
 * workspace tool sets.
 */
export async function demoTools() {
  const [tools, { Todos }] = await Promise.all([import('durable-harness/tools'), import('../docs')]);
  return [...tools.unsafeTools(), ...tools.docTools([Todos])];
}

/** The unsafe tools need no confirmation: the drills call them. */
export const UNSAFE_NOTE = "The unsafe_* tools are this demo's simulated side effects: when the user asks for an email or a payment, make the call; no confirmation is needed.";

/** The system prompt for a harness with its own built-in tools on (Claude Code and Codex in the VM, OpenCode). */
export const BUILTIN_INSTRUCTIONS = `You are a coding agent. Use your tools to inspect and change files, and to run commands.
Keep answers short. Your session is durable: it can be interrupted and resumed at any point.
${UNSAFE_NOTE}`;
