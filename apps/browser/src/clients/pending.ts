import type { SessionRow } from 'harness-world-demo-ui';

/**
 * Sessions this page started that the World's run list may not show yet
 * (world-vercel's list lags a new run by several seconds). `merge` puts them
 * at the top until the list includes them, for at most a minute.
 */
export function pendingRows(harness: (h: string) => string = (h) => h) {
  const pending = new Map<string, SessionRow>();
  return {
    add(id: string, h: string) {
      pending.set(id, { id, harness: harness(h), status: 'running', createdAt: new Date() });
    },
    merge(rows: SessionRow[]): SessionRow[] {
      if (!pending.size) return rows;
      const listed = new Set(rows.map((r) => r.id));
      const now = Date.now();
      const extra: SessionRow[] = [];
      for (const [id, row] of pending) {
        if (listed.has(id) || now - new Date(row.createdAt).getTime() > 60_000) pending.delete(id);
        else extra.push(row);
      }
      return extra.length ? [...extra.reverse(), ...rows] : rows;
    },
  };
}
