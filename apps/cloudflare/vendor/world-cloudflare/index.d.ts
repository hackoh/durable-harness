// Hand-written declarations for the vendored build (the PR ships TypeScript
// sources only). They cover what this app uses; see the PR's src/index.ts.
import type { World } from '@workflow/world';

type ObjectClass = new (ctx: any, env: any) => any;

/** One workflow run: its event log, its queue signals and alarms. Bind as WORKFLOW_RUNS. */
export declare const RunObject: ObjectClass;
/** Hook token ownership. Bind as WORKFLOW_TOKENS. */
export declare const TokenObject: ObjectClass;
/** One World stream. Bind as WORKFLOW_STREAMS. */
export declare const StreamObject: ObjectClass;
/** A WorkerEntrypoint that runs overflow steps outside the run object (core only). */
export declare const StepRunner: ObjectClass;

/** A precompiled WebAssembly module; typed `{}` as in the PR's src/quickjs.ts, so a value type-checks here exactly as it does there. */
type QuickJSModule = {};

export interface QuickJSModules {
  quickjs: QuickJSModule;
  encoding: QuickJSModule;
  headers: QuickJSModule;
  url: QuickJSModule;
  structuredClone: QuickJSModule;
}

export interface SetupOptions {
  /** The build this isolate runs. Runs are pinned to the build that created them. */
  deploymentId: string;
  /**
   * The route the run object hands every queue message to, in its own
   * isolate: it must serve the request with the handler the World returned
   * from `createQueueHandler`. For core, the generated workflow route; for
   * harness-world, `sessions.handler`.
   */
  createFlowRoute: () => (request: Request) => Promise<Response>;
  /** Precompiled QuickJS modules for core's VM (unused without core). */
  quickjs: QuickJSModules;
  setWorld: (world: World) => void;
}

export declare function setupCloudflareWorld(options: SetupOptions): World;
export declare function createCloudflareWorld(): World;
