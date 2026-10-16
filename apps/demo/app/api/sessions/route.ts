import { harnessOf } from 'harness-world';
import { LIBFX_WORKFLOW } from 'harness-world-demo-ui/fx-view';
import { agentRunsLink } from '@/lib/agent-runs-link';
import { fxDurableOption } from '@/lib/fx-durable-world';
import { driveAfterResponse, driveMode } from '@/lib/drive';
import { builtinOption, sandboxOffReason, startHands } from '@/lib/hands';
import { processHarnessOptions, processHarnesses } from '@/lib/harnesses';
import { drillRoute, getSessions } from '@/lib/sessions';
import { getWorld, worldName } from '@/lib/world';

/** A session's harness: a durable-harness run's (any version, or the older `harness:<name>` form), or libfx's own durable sessions (fx-durable). */
const harnessOfRun = (workflowName: string | undefined) => harnessOf(workflowName) ?? (workflowName === LIBFX_WORKFLOW ? 'fx-durable' : undefined);

// With the drive route on, a first prompt's turn runs in this invocation after the response.
export const maxDuration = 800;

/**
 * Create a session. Without a prompt this is a pre-created session: the
 * page makes one ahead of the first prompt, so creating the run
 * is off the time-to-first-token path. Its hands (the Hands axis) are
 * checked against the harness's and recorded on its `run_created`
 * (`config.hands`): every drive builds the harness for them.
 */
export async function POST(request: Request) {
  const { harness, prompt, drive, durability, hands: wanted } = (await request.json()) as {
    /** `pi`, `fx`, `hybrid`, `hybrid-fx` (the tab starts its own on /api/world), or a process harness from lib/harnesses. */
    harness: string;
    prompt?: string;
    drive?: string;
    /** `run-ahead`: the session's drives run ahead of durability (recorded on `run_created`). */
    durability?: 'on' | 'run-ahead';
    /** Where its model commands and files go (`none`, `virtual`, `ephemeral`, `machine`, `sandbox`). Default: the harness's. */
    hands?: unknown;
  };
  const hybrid = harness === 'hybrid' || harness === 'hybrid-fx';
  // A hybrid session's brain moves; its hands are Pi's and fx's, in a Hybrid brain.
  const option = builtinOption(hybrid ? (harness === 'hybrid' ? 'pi' : 'fx') : harness) ?? processHarnesses().find((h) => h.value === harness);
  if (!option) return Response.json({ error: `unknown harness ${harness}` }, { status: 400 });
  // A process harness that can't run here (no Vercel Sandbox for Claude Code and Codex): say why, before a run exists.
  const disabled = 'disabledReason' in option && typeof option.disabledReason === 'function' ? option.disabledReason() : undefined;
  if (disabled) return Response.json({ error: disabled }, { status: 400 });
  const picked = startHands(option, wanted, hybrid ? 'hybrid' : 'server');
  if ('error' in picked) return Response.json({ error: picked.error }, { status: 400 });
  const sessions = await getSessions();
  const mode = driveMode(drive);
  const { sessionId } = await sessions.start({
    harness,
    prompt,
    config: { hands: picked.hands, ...(durability === 'run-ahead' ? { durability } : {}) },
    ...(prompt && mode === 'http' ? { wake: 'backstop' as const } : {}),
  });
  if (prompt && mode === 'http') driveAfterResponse(sessionId, 'start');
  return Response.json({ sessionId });
}

/**
 * The session list for one kind of session (`?harness=pi,fx` for the server
 * page, `?harness=hybrid,hybrid-fx` for hybrid sessions; `include=process`
 * adds the process harnesses and their picker options), plus what the page
 * needs to describe this server: which World it runs, whether crashes
 * are armed, and (on Vercel) where its sessions show in Agent Runs.
 * `list=0` answers that description alone.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const withProcess = params.get('include') === 'process';
  const wanted = params.get('harness')?.split(',').filter(Boolean);
  if (wanted && withProcess) wanted.push(...processHarnesses().map((h) => h.value));
  // `list=0`: only what describes this server (fast); the runs list can take the World a while.
  const [runs, agentRuns] = await Promise.all([
    params.get('list') === '0'
      ? { data: [] }
      : getWorld().then((world) => world.runs.list({ pagination: { limit: 100, sortOrder: 'desc' }, resolveData: 'none' })),
    agentRunsLink(),
  ]);
  return Response.json({
    world: worldName(),
    // The port this server answered on (behind a dev proxy, the page's own port is the proxy's): what the page tells you to start again.
    port: new URL(request.url).port,
    chaos: process.env.HARNESS_CHAOS !== '0',
    // Messages to a session with an armed crash go to /api/drill (lib/sessions.ts `drillRoute`).
    drill: drillRoute(),
    // Why this deployment can't make Vercel Sandbox VMs (the machine and sandbox hands), when it can't.
    ...(sandboxOffReason() ? { sandboxReason: sandboxOffReason() } : {}),
    // On Vercel: where a session's trace is (the Event Log drawer links each session there).
    ...(agentRuns ? { agentRuns } : {}),
    sessions: runs.data
      .filter((r) => {
        const h = harnessOfRun(r.workflowName);
        return h && (!wanted || wanted.includes(h));
      })
      .map((r) => ({ id: r.runId, harness: harnessOfRun(r.workflowName)!, status: r.status, createdAt: r.createdAt })),
    // fx (libfx durable) is listed only when it cannot run here, with the reason (the page has its own entry for it).
    ...(withProcess ? { harnesses: [...processHarnessOptions(), ...[fxDurableOption()].filter((o) => !!o)] } : {}),
  });
}
