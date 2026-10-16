import { bytesToBase64, DocConflict, DocTooLarge, SessionLog } from 'harness-world';
import { Todos } from '@/lib/docs';
import { getSessions } from '@/lib/sessions';
import { getWorld } from '@/lib/world';

/**
 * A session's documents, read and written by app code (not the model):
 * - `GET` the todo list (`sessions.doc`) and the workspace's files (the
 *   `hw.workspace` document, large files read from the blob stream; a
 *   binary file as `{ base64 }`).
 * - `POST { add, expectRevision? }` appends an item out of band
 *   (`sessions.updateDoc`); a stale `expectRevision` answers 409, a document
 *   past the size limit (64 KB of JSON) 413.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [sessions, world] = await Promise.all([getSessions(), getWorld()]);
  const todos = await sessions.doc(id, Todos);
  const log = new SessionLog(world, id);
  await log.refresh();
  const { readWorkspace, workspaceManifest } = await import('harness-world-hands/tools');
  const files = Object.fromEntries(
    Object.entries(await readWorkspace(world, log.state)).map(([path, content]) => [path, typeof content === 'string' ? content : { base64: bytesToBase64(content) }])
  );
  const workspace = log.state.docs.get('hw.workspace');
  return Response.json({
    todos,
    workspace: {
      revision: workspace?.revision ?? 0,
      entries: workspaceManifest(log.state).map((f) => ({ path: f.path, bytes: f.bytes, inline: f.inline, ...(f.binary ? { binary: true } : {}), ...(f.mode !== undefined ? { mode: f.mode } : {}) })),
      files,
    },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { add?: unknown; expectRevision?: unknown };
  if (typeof body.add !== 'string' || !body.add) return Response.json({ error: 'add must be a non-empty string' }, { status: 400 });
  const expectRevision = typeof body.expectRevision === 'number' ? body.expectRevision : undefined;
  try {
    const result = await (await getSessions()).updateDoc(id, Todos, (d) => ({ ...d, items: [...(Array.isArray(d.items) ? d.items : []), body.add as string] }), expectRevision !== undefined ? { expectRevision } : {});
    return Response.json(result);
  } catch (error) {
    if (error instanceof DocConflict) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof DocTooLarge) return Response.json({ error: error.message }, { status: 413 });
    throw error;
  }
}
