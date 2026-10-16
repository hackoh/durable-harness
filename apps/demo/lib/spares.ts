import { getSessions } from './sessions';

/**
 * Close pre-created sessions a tab never used (the `pagehide`
 * beacon). A session that received any submission is left alone, so a late
 * or duplicate beacon cannot end a real conversation.
 */
export async function closeUnusedSpares(ids: unknown): Promise<string[]> {
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.startsWith('wrun_')).slice(0, 4) : [];
  if (!list.length) return [];
  const sessions = await getSessions();
  const closed: string[] = [];
  await Promise.all(
    list.map(async (id) => {
      const state = await sessions.inspect(id).catch(() => undefined);
      if (!state || state.status !== 'running' || state.submissions.length > 0) return;
      await sessions.close(id).catch(() => {});
      closed.push(id);
    })
  );
  return closed;
}
