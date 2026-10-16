import { getRunQueueNamespace, type World } from '@workflow/world';
import { harnessOf } from './names.ts';
import { QUEUE_PREFIX } from './queue.ts';

export interface RecoverSessionsOptions {
  /**
   * Only runs that recorded no queue namespace (sessions created before the
   * kernel had one). For a World whose own `start()` already re-enqueued the
   * runs that recorded theirs (world-postgres). Default false: every session.
   */
  unrecorded?: boolean;
  /** Where a run that could not be re-enqueued is reported. Default `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Re-enqueue every session left pending or running (a process that died
 * mid-turn), on the kernel's prefix, so a restarted server resumes each from
 * its log. Only harness sessions (`harnessOf(run.workflowName)`): the
 * Workflow SDK's runs and libfx's, in the same data directory or database,
 * are their own consumers' to recover. Each goes on
 * `__harness_wkf_workflow_<workflowName>` with `{ runId }`, the shape a
 * World's own recovery sends (`reenqueueActiveRuns`), so a consumer handles
 * both alike. A duplicate (the World's recovery sent one too) is harmless: a
 * delivery takes over only what is its own or proven gone.
 *
 * The World's own recovery cannot do this for a kernel that shares a data
 * directory with other consumers: world-local's re-enqueues every active run
 * through the instance that starts, and a run that recorded no namespace on
 * that instance's default prefix.
 *
 * Returns how many runs it re-enqueued. A run that fails is reported and
 * skipped, as the World's recovery does.
 */
export async function recoverSessions(world: World, options: RecoverSessionsOptions = {}): Promise<number> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await world.runs.list({
      status: ['pending', 'running'],
      resolveData: 'none',
      ...(cursor ? { pagination: { cursor } } : {}),
    } as Parameters<World['runs']['list']>[0]);
    for (const run of page.data) {
      if (!harnessOf(run.workflowName)) continue;
      if (options.unrecorded && getRunQueueNamespace((run as { executionContext?: unknown }).executionContext) !== undefined) continue;
      try {
        await world.queue(`${QUEUE_PREFIX}${run.workflowName}`, { runId: run.runId } as never);
        count++;
      } catch (error) {
        warn(`[harness-world] could not re-enqueue session ${run.runId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  return count;
}
