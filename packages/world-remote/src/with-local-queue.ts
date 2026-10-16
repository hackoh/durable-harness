import type { World } from '@workflow/world';
import type { QueueLike } from './local-queue.ts';

/**
 * A World whose storage and streams are `world`'s and whose queue is `queue`
 *: the in-VM daemon writes the session log straight to
 * world-vercel and wakes its own drives from an in-memory
 * queue, like a tab does; what stands behind its drives is the app's tether
 * on the server queue (harness-world's tether.ts). Everything else (`getDeploymentId`,
 * `specVersion`, `close`) is `world`'s.
 */
export function withLocalQueue<W extends World>(world: W, queue: QueueLike): W {
  const own = {
    queue: queue.queue.bind(queue),
    createQueueHandler: queue.createQueueHandler.bind(queue),
    ...(queue.queueBatch ? { queueBatch: queue.queueBatch.bind(queue) } : {}),
    async start() {
      await queue.start?.();
      await world.start?.();
    },
    async close() {
      await queue.stop?.();
      await world.close?.();
    },
  } as Partial<World>;
  return new Proxy(world, {
    get(target, key, receiver) {
      if (key in own) return (own as Record<string | symbol, unknown>)[key];
      if (key === 'queueBatch') return undefined;
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
