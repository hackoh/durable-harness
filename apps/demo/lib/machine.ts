import type { HostTool } from 'harness-world';
import { getSandboxProvider } from './sandbox-provider';

/**
 * The Virtual + machine hands' extra tool, for a harness whose brain stays
 * in a Function (Pi, fx and OpenCode on the Server brain): hybrid's
 * `run_on_machine`, next to the harness's own tools on its `virtual()`
 * workspace (the same `hw.workspace` document). It syncs the log's files
 * into a Vercel Sandbox VM of the session's own (`hybrid-<runId>`, never a
 * `sandbox()` session's), runs the command and waits for it inside the
 * call, and brings the text files it changed back with the call's outcome.
 */
export async function machineTools(): Promise<HostTool[]> {
  const [{ runOnMachineTool }, sandbox] = await Promise.all([import('harness-world-hybrid'), getSandboxProvider()]);
  return [runOnMachineTool({ lane: 'function', sandbox })];
}
