// The kernel ships inside durable-harness (bundled), so its runs carry
// durable-harness's version: read here from its package.json when
// durable-harness is built (its tsup config bundles the `version` field
// alone), and from the workspace's package.json when run from source.
import durableHarness from '../../durable-harness/package.json' with { type: 'json' };

/**
 * Names in the Workflow SDK's `{kind}//{module}//{function}` shape, so the
 * stock CLI, `workflow web`, and the Vercel dashboard render sessions as
 * "pi" runs from durable-harness with "model" / "tool.bash" steps.
 *
 * A session's run is `workflow//durable-harness@<version>//<harness>`: the
 * form the Workflow SDK gives a workflow that comes from a package (the
 * module specifier is the package name at its version, as in
 * `step//@myorg/tasks@2.0.0//processOrder` or eve's
 * `workflow//eve@0.76.0//runAgentRouterTask`), so `parseWorkflowName` gives
 * the harness as the short name and `durable-harness@<version>` as the
 * module. Runs started before this were
 * `workflow//harness-world//harness:<harness>`, and earlier prototypes'
 * a bare `harness:<harness>`: every read (`harnessOf`) takes all three.
 *
 * Step names keep the kernel's module (`step//harness-world//<effect>`): a
 * step's events are written by whichever version drives it, and a version in
 * its name would split one step across two names at an upgrade.
 */
export const PACKAGE = 'durable-harness';
/** durable-harness's version, as its package.json says. */
export const VERSION: string = durableHarness.version;
/** The module specifier of sessions' runs: `durable-harness@<version>`. */
export const MODULE = `${PACKAGE}@${VERSION}`;

/** The module and function prefix of runs started before the package-style name. */
const LEGACY_MODULE = 'harness-world';
const LEGACY_FUNCTION = 'harness:';
const STEP_MODULE = LEGACY_MODULE;

/** A harness's sessions' run name: `workflow//durable-harness@<version>//<harness>`. */
export const workflowNameFor = (harness: string) => `workflow//${MODULE}//${harness}`;
/** The name a session's run had before the package-style name (still read: `harnessOf`). */
export const legacyWorkflowNameFor = (harness: string) => `workflow//${LEGACY_MODULE}//${LEGACY_FUNCTION}${harness}`;
export const stepNameFor = (effect: string) => `step//${STEP_MODULE}//${effect}`;

/**
 * The harness a run belongs to, or undefined if it is not a harness session:
 * `workflow//durable-harness@<any version>//<harness>`, the older
 * `workflow//harness-world//harness:<harness>`, or a bare `harness:<harness>`.
 * The version is not compared: a session started under one version of
 * durable-harness is driven by the next.
 */
export function harnessOf(workflowName: string | undefined): string | undefined {
  if (typeof workflowName !== 'string' || !workflowName) return undefined;
  const [kind, module, ...fn] = workflowName.split('//');
  const name = fn.join('//');
  if (kind === 'workflow' && (module === PACKAGE || module?.startsWith(`${PACKAGE}@`))) return name || undefined;
  // The older form, with any module (and the bare form of early prototype runs).
  const last = workflowName.split('//').at(-1)!;
  return last.startsWith(LEGACY_FUNCTION) ? last.slice(LEGACY_FUNCTION.length) || undefined : undefined;
}

/** Whether two run names name one harness's sessions (whatever version or form each has). */
export function sameHarness(a: string | undefined, b: string | undefined): boolean {
  const harness = harnessOf(a);
  return harness !== undefined && harness === harnessOf(b);
}

/**
 * The harness of a recovery delivery, or undefined for any other queue: a
 * restart re-enqueues each active session on its workflow's queue, the
 * kernel's `__harness_wkf_workflow_<workflowName>` (`recoverSessions`, and a
 * World's own recovery for a run that recorded the namespace), or a
 * session from before it had one on `__wkf_workflow_<workflowName>` (any
 * namespace's `__<ns>_wkf_workflow_<workflowName>` reads the same).
 */
export function harnessOfQueue(queueName: string): string | undefined {
  const workflowName = /^__(?:[a-z][a-z0-9]*_)?wkf_workflow_(.+)$/.exec(queueName)?.[1];
  return workflowName?.includes('//') ? harnessOf(workflowName) : undefined;
}

export const effectNameOf = (stepName: string) => stepName.split('//').at(-1) ?? stepName;
