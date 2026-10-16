import { readDriveManifest } from 'durable-harness/tools';
import { SessionLog } from 'harness-world';
import { sessionView, withLedger } from 'harness-world-demo-ui/view';
import { getSessions } from '@/lib/sessions';
import { getWorld } from '@/lib/world';

/**
 * Folds kept per run, so a poll reads only the events past the last one it
 * saw instead of re-reading (and re-decoding) the whole log. On `globalThis`
 * because Next can hold more than one copy of this module per process.
 */
const g = globalThis as { __harnessLogs?: Map<string, SessionLog> };
const MAX_LOGS = 32;

async function logFor(id: string): Promise<SessionLog> {
  const logs = (g.__harnessLogs ??= new Map());
  let log = logs.get(id);
  if (log) logs.delete(id);
  else log = new SessionLog(await getWorld(), id);
  logs.set(id, log);
  for (const key of logs.keys()) {
    if (logs.size <= MAX_LOGS) break;
    logs.delete(key);
  }
  return log;
}

/**
 * The fold: what the session "is", derived entirely from its event log.
 * `?known=<eventCount>` answers `{ unchanged: true }` when nothing landed
 * since the caller's copy.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const known = new URL(request.url).searchParams.get('known');
  const log = await logFor(id);
  try {
    await log.refresh();
  } catch (error) {
    g.__harnessLogs?.delete(id);
    if (isRunNotFound(error)) return notFound(id);
    throw error;
  }
  // A run this World never had: an empty log (no run_created).
  if (log.state.eventCount === 0) {
    g.__harnessLogs?.delete(id);
    return notFound(id);
  }
  if (known !== null && Number(known) === log.state.eventCount) {
    return Response.json({ unchanged: true, eventCount: log.state.eventCount });
  }
  // The unsafe example tools' side effects live outside the log: read them too. The files are readWorkspace's (`log`), and a
  // sandbox() session's Drive is its last snapshot (`drive`, readDriveManifest: in the log, readable after the VM stopped).
  const view = await withLedger(await getWorld(), sessionView(id, log.state), log.state);
  const drive = readDriveManifest(log.state);
  return Response.json(drive ? { ...view, drive: { at: drive.at, truncated: drive.truncated, files: drive.files } } : view);
}

/**
 * The World's answer for a run it does not have (by name and status: errors
 * cross process boundaries). world-vercel answers an id that is not a run id
 * at all with a 400 validation error.
 */
function isRunNotFound(error: unknown): boolean {
  const e = error as { name?: unknown; status?: unknown; code?: unknown } | undefined;
  return !!e && (e.name === 'WorkflowRunNotFoundError' || e.status === 404 || (e.status === 400 && e.code === 'validation-error'));
}

const notFound = (id: string) => Response.json({ error: 'not_found', message: `No session ${id} on this deployment.` }, { status: 404 });

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await (await getSessions()).close(id);
  return Response.json({ ok: true });
}
