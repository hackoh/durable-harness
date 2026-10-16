/**
 * The kernel's queue: one namespace of its own on the World's queue,
 * `harness`, so its messages never reach the Workflow SDK's consumer (the
 * Workflow SDK takes `__wkf_workflow_`, or `__<WORKFLOW_QUEUE_NAMESPACE>_wkf_workflow_`).
 * A World delivers a prefix wherever its consumer registered it
 * (`Queue.registerHandler` in process, `Queue.registerRoute` over HTTP); on
 * Vercel a Function subscribes to the topic `__harness_wkf_workflow_*`.
 *
 * Every session's run records the namespace when it is created
 * (`executionContext.queueNamespace`), so a World's restart recovery, in any
 * process, re-enqueues it on this prefix.
 *
 * A leaf module (no imports): the driver, owners, pi-world and
 * durable-harness's next.config helpers all read it.
 */

/** The kernel's queue namespace. */
export const QUEUE_NAMESPACE = 'harness' as const;

/** Every kernel queue name starts with this. */
export const QUEUE_PREFIX = `__${QUEUE_NAMESPACE}_wkf_workflow_` as const;

/** Wakes, companions, continuations, tab-lost and tether deliveries. */
export const QUEUE_NAME = `${QUEUE_PREFIX}session` as const;

/** Owner checks and sandbox-crash firings for parked steps (owners.ts). */
export const OWNER_QUEUE = `${QUEUE_PREFIX}owner` as const;

/** pi-world's wakes (pi-durable sessions). */
export const PI_WAKE_QUEUE = `${QUEUE_PREFIX}pi` as const;

/** A queue trigger's topic for every kernel message (Vercel Queues matches the `*`). */
export const QUEUE_TOPIC = `${QUEUE_PREFIX}*` as const;

/**
 * What a session's `run_created` records, so a World's recovery
 * (`reenqueueActiveRuns`) sends its run back to this namespace.
 */
export const EXECUTION_CONTEXT: { readonly queueNamespace: typeof QUEUE_NAMESPACE } = Object.freeze({ queueNamespace: QUEUE_NAMESPACE });

/**
 * The Workflow SDK's default prefix, which sessions used before they had a
 * namespace of their own (runs created then record none).
 */
export const LEGACY_QUEUE_PREFIX = '__wkf_workflow_' as const;
