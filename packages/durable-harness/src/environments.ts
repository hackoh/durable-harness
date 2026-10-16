/**
 * From a workspace descriptor to what a harness's tools run on
 * (docs/workspaces.md §3.1). The harness packages can't import
 * durable-harness (it bundles them), so each `durable-harness/<harness>`
 * wrapper resolves the `workspace` option here, on a session's first
 * invocation, and passes the result to the raw harness:
 *
 * - `virtual()`: harness-world-hands' workspace runtime
 *   (`harness-world-hands/runtime`): the files and the shell each tool call
 *   gets (`WorkspaceMachine`), where they come from and where they go. On
 *   Node, its shell runs in an isolated worker or not at all
 *   (`defaultIsolation`).
 * - `sandbox()`: how to get the session's VM (`AcquireMachine`,
 *   harness-world-process' environment.ts), armed with the runtime's
 *   fencing token: harness-world-sandbox's session factory, loaded (with
 *   `@vercel/sandbox`) the first time a session acquires one. The VM boots
 *   from the descriptor's `image`, else the project's base snapshot, built
 *   once per region on first use (`prepareBase`).
 *
 * Internal: no entry exports it.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { World } from '@workflow/world';
import { Unavailable } from 'harness-world';
import type { Isolation } from 'harness-world-hands/runtime';
// The runtime alone: harness-world-hands/runtime also has Pi's coding tools,
// whose schemas would load typebox in every harness's entry.
import { workspaceRuntime, type WorkspaceRuntime, type WorkspaceRuntimeOptions } from 'harness-world-hands/workspace-runtime';
import type { AcquireMachine } from 'harness-world-process';
import type { KernelSandbox } from 'harness-world-sandbox/cli';
import { sessionName } from 'harness-world-sandbox/names';
import { publicSandboxUnavailable } from './sandbox-harness.ts';
import { isWorkspace, type SandboxWorkspace, type VirtualWorkspace, type Workspace } from './workspace.ts';

/** A `virtual()` workspace, resolved: the runtime its tools are written on. */
export interface VirtualEnvironment {
  readonly kind: 'virtual';
  readonly workspace: VirtualWorkspace;
  readonly runtime: WorkspaceRuntime;
  /** Where its shell runs (`defaultIsolation`, unless the options chose). */
  readonly isolation: Isolation;
}

/**
 * A `sandbox()` workspace, resolved: how to get the session's VM. The
 * machine `acquire` gives has the CLI side (spawn, cache files) and the
 * session's `/workspace` as a `WorkspaceMachine` (`machine.workspace`), for
 * a Function-tier runtime's tools.
 */
export interface SandboxEnvironment {
  readonly kind: 'sandbox';
  readonly workspace: SandboxWorkspace;
  readonly acquire: AcquireMachine;
}

/** A resolved workspace. */
export type Environment = VirtualEnvironment | SandboxEnvironment;

/** Options for `resolveEnvironment` (tests). */
export interface EnvironmentOptions {
  /** Where a virtual workspace's shell runs. Default `defaultIsolation()`. */
  isolation?: WorkspaceRuntimeOptions['isolation'];
}

/**
 * Where a virtual workspace's shell runs unless told: `worker` wherever Node
 * has worker threads (a Vercel Function, a self-hosted server), so a worker
 * that can't start fails closed with harness-world-hands' error instead of
 * running every co-tenant's shell in the realm that serves requests, with
 * defense-in-depth off (docs/workspaces.md §4.2: on shared Fluid one
 * session's runaway command would stall them all). `auto` (a worker where
 * one can start, else this realm) only where there are no worker threads at
 * all: a browser tab, workerd.
 */
export function defaultIsolation(): Isolation {
  const p = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown; versions?: { node?: unknown } } }).process;
  if (typeof p?.getBuiltinModule !== 'function' || typeof p.versions?.node !== 'string') return 'auto';
  if ((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === 'Cloudflare-Workers') return 'auto';
  try {
    const threads = p.getBuiltinModule('node:worker_threads') as { Worker?: unknown } | undefined;
    return typeof threads?.Worker === 'function' ? 'worker' : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Resolve `workspace` (a descriptor `virtual()` or `sandbox()` returned) for
 * a session. A copy of a descriptor, or anything else, is a `TypeError`: a
 * spread drops its brand (and a sandbox's credentials).
 */
export function resolveEnvironment(workspace: VirtualWorkspace, options?: EnvironmentOptions): VirtualEnvironment;
export function resolveEnvironment(workspace: SandboxWorkspace, options?: EnvironmentOptions): SandboxEnvironment;
export function resolveEnvironment(workspace: Workspace, options?: EnvironmentOptions): Environment;
export function resolveEnvironment(workspace: Workspace, options: EnvironmentOptions = {}): Environment {
  if (!isWorkspace(workspace)) {
    const copy = typeof workspace === 'object' && workspace !== null && 'kind' in workspace;
    throw new TypeError(
      copy
        ? 'durable-harness: workspace is a copy of a descriptor: pass virtual() or sandbox() itself, or derive one with virtual(base, overrides) / sandbox(base, overrides) (a spread drops its brand and credentials)'
        : 'durable-harness: workspace takes virtual() or sandbox()'
    );
  }
  if (workspace.kind === 'virtual') {
    const isolation = options.isolation ?? defaultIsolation();
    return Object.freeze({ kind: 'virtual', workspace, isolation, runtime: workspaceRuntime(workspace, { isolation }) });
  }
  return Object.freeze({ kind: 'sandbox', workspace, acquire: sandboxAcquire(workspace) });
}

/**
 * The sandbox tier's `AcquireMachine` for one descriptor: harness-world-sandbox's
 * session factory, imported on the first acquire, so an app that never uses a
 * sandbox never loads `@vercel/sandbox` (an optional peer). One factory per
 * descriptor: it keeps each invocation's attach, so a re-acquire after a lost
 * link re-attaches with the token it read the first time.
 *
 * Every acquire is admitted first, on every runtime, before the factory
 * loads (sandbox-harness.ts): the request must carry the session's recorded
 * config (`config`, `undefined` for a session that recorded none; a request
 * without the key is a runtime's bug, refused with a `TypeError`), and a
 * session a public chat route started without `allowPublicSandbox: true`,
 * or with no finite `budget.sessionUsd`, is refused with `Unavailable`: its
 * turn fails, and no VM boots.
 */
function sandboxAcquire(workspace: SandboxWorkspace): AcquireMachine {
  let factory: Promise<AcquireMachine> | undefined;
  return async (request) => {
    if (!('config' in request)) {
      throw new TypeError(
        "durable-harness: sandbox()'s acquire was called without config: pass AcquireMachineRequest.config, the session's recorded config (undefined when it recorded none), so a public chat route's session can be refused before a VM boots"
      );
    }
    const refused = publicSandboxUnavailable(request.config, workspace.budget);
    if (refused) throw refused;
    factory ??= import('harness-world-sandbox').then(({ prepareBase, sandboxSession }) => {
      const credentials = workspace.credentials;
      return sandboxSession({
        spec: workspace,
        base: (region, options) => {
          const key = `${credentials?.projectId ?? ''}:${region}`;
          let base = bases.get(key);
          // Kept until a day before the snapshot expires, and dropped when a create found it gone (rebuilt or deleted elsewhere).
          if (!base || options?.refresh || base.until < Date.now()) {
            const entry: { snapshot: Promise<{ snapshot: string }>; until: number } = {
              snapshot: relayArtifact()
                .then((relay) => prepareBase({ region, relay, ...(credentials ? { credentials } : {}) }))
                .then(({ snapshotId, expiresAt }) => {
                  entry.until = (expiresAt ?? Date.now() + BASE_TTL_MS) - BASE_TTL_MARGIN_MS;
                  return { snapshot: snapshotId };
                }),
              until: Infinity,
            };
            base = entry;
            bases.set(key, entry);
            entry.snapshot.catch(() => bases.delete(key));
          }
          return base.snapshot;
        },
      });
    });
    factory.catch(() => (factory = undefined));
    return (await factory)(request);
  };
}

/** A Drive manifest writer that writes nothing. */
const NO_DRIVE_FILES: Pick<ReturnType<KernelSandbox['files']>, 'changed' | 'catchUp' | 'snapshot'> = Object.freeze({ changed() {}, catchUp: async () => {}, snapshot: async () => {} });

/**
 * A `sandbox()` workspace bound for a kernel harness that runs in the
 * session's VM (Claude Code, Codex): the session factory's attach, as the
 * drive's `sandbox.attach` fact, the acknowledgement of the notes it
 * carried, and the writer of the Drive's manifest (harness-world-sandbox's
 * `kernelSandbox`, from its `/cli` entry, which loads neither the factory
 * nor the relay link: the factory loads on the first attach, through
 * `resolveEnvironment`'s acquire).
 */
export function kernelSandboxOf(env: SandboxEnvironment): KernelSandbox {
  let bound: Promise<KernelSandbox> | undefined;
  /** The binding once loaded: `files` is asked for after an attach, which loaded it. */
  let loaded: KernelSandbox | undefined;
  const load = () => {
    bound ??= import('harness-world-sandbox/cli').then(({ kernelSandbox }) => (loaded = kernelSandbox(env.acquire)));
    bound.catch(() => (bound = undefined));
    return bound;
  };
  return {
    attach: async (ctx, request) => {
      // A public route's session, for a harness that lost its mark on the way (sandbox-harness.ts): refused before the
      // tier loads, as the acquire would refuse it (`sandboxAcquire`).
      const refused = publicSandboxUnavailable(ctx.config, env.workspace.budget);
      if (refused) throw refused;
      return (await load()).attach(ctx, request);
    },
    acknowledge: async (ctx, key) => (await load()).acknowledge(ctx, key),
    // The Drive's manifest (`hw.sandbox-files`) for a drive on an attached machine (best effort: before an attach loaded the binding, a writer that writes nothing).
    files: (ctx, machine, options) => loaded?.files(ctx, machine, options) ?? (NO_DRIVE_FILES as ReturnType<KernelSandbox['files']>),
  };
}

/** The base snapshot per project and region, kept until shortly before it expires. */
const bases = new Map<string, { snapshot: Promise<{ snapshot: string }>; until: number }>();
/** How long a base id is kept when its expiry is unknown. */
const BASE_TTL_MS = 24 * 60 * 60_000;
/** How long before its expiry a base id is dropped (the base rebuilds a day before; a little more here). */
const BASE_TTL_MARGIN_MS = 25 * 60 * 60_000;

/**
 * The relay bundle the base installs. A published build ships it
 * (`relay-bundle.ts`, filled in by the build, checked against its hash
 * here), so a deployed Function never builds it. In this repo's source it
 * is built from the relay's source with esbuild, except in a deployed
 * Function (`VERCEL_ENV` production or preview): there a build without the
 * bundle fails fast, saying so, instead of running esbuild in a request.
 */
export async function relayArtifact(): Promise<import('harness-world-sandbox').RelayArtifact> {
  const { SHIPPED_RELAY } = await import('./relay-bundle.ts');
  if (SHIPPED_RELAY) return shippedArtifact(SHIPPED_RELAY);
  const env = process.env.VERCEL_ENV;
  if (env === 'production' || env === 'preview') {
    throw new Unavailable("durable-harness: sandbox() has no relay bundle in this deployment (durable-harness from source ships none), and a deployed Function doesn't build it", {
      hint: 'Install durable-harness from npm (its build ships the bundle), or pass sandbox({ image: { snapshot } }) with a base prepared from a laptop (prepareSandboxBase).',
    });
  }
  const { devRelayArtifact } = await import('harness-world-sandbox');
  return devRelayArtifact();
}

/** The shipped bundle's bytes, checked against the hash it was shipped with. */
export function shippedArtifact(shipped: import('./relay-bundle.ts').ShippedRelay): import('harness-world-sandbox').RelayArtifact {
  const bytes = new Uint8Array(gunzipSync(Buffer.from(shipped.gzip, 'base64')));
  if (createHash('sha256').update(bytes).digest('hex') !== shipped.version) throw new Error('durable-harness: the shipped relay bundle does not match its hash');
  return { bytes, version: shipped.version };
}

/**
 * When each session of the World last wrote its log, by its sandbox's name:
 * every run the World lists, named as the sandbox tier names its sandbox,
 * and for one that matches, its newest event (else the run's own times).
 */
export async function sessionActivity(world: World, projectId: string): Promise<(name: string) => Promise<number | undefined>> {
  const runs = new Map<string, { runId: string; createdAt?: Date; updatedAt?: Date }>();
  let cursor: string | undefined;
  for (;;) {
    const page = await world.runs.list({ resolveData: 'none', pagination: { limit: 1000, ...(cursor ? { cursor } : {}) } } as Parameters<World['runs']['list']>[0]);
    for (const run of page.data) runs.set(sessionName(projectId, run.runId), run);
    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  const time = (d: Date | string | undefined) => (d === undefined ? 0 : new Date(d).getTime() || 0);
  return async (name) => {
    const run = runs.get(name);
    if (!run) return undefined;
    const events = await world.events.list({ runId: run.runId, pagination: { limit: 1, sortOrder: 'desc' }, resolveData: 'none' });
    return Math.max(time(events.data[0]?.createdAt), time(run.updatedAt), time(run.createdAt));
  };
}
