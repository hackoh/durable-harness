import { armedChaos, currentLane, harnessOf, readBlobs, type SessionState } from 'harness-world';
import { filesFromState, readLedger, readWorkspace, UNSAFE_TOOL_NAMES, workspaceManifest } from 'harness-world-hands/tools';
import { JOURNAL, openTurn, summarizeBatch } from 'harness-world-process/records';
import { isHands } from './axes.ts';
import { isHybrid, type SessionView } from './view.ts';

export type * from './view.ts';

const UNSAFE_EFFECTS = new Set(UNSAFE_TOOL_NAMES.map((n) => `tool.${n}`));

/**
 * The view plus what lives outside the log, read from `world` only when the
 * session has some: its ledger (the unsafe example tools' side effects) and
 * the workspace files kept in its blob stream. With the session's `state`,
 * those files are `readWorkspace`'s (the Files panel's `log` source: one
 * manifest format for every store, docs/workspaces.md §4.3).
 */
export async function withLedger(world: Parameters<typeof readLedger>[0], view: SessionView, state?: SessionState): Promise<SessionView> {
  let out = view;
  if (view.blobFiles && Object.keys(view.blobFiles).length > 0) {
    const all = state ? await readWorkspace(world, state).catch(() => undefined) : undefined;
    const blobs = all ? undefined : await readBlobs(world, view.id).catch(() => new Map<string, string>());
    const files = { ...view.files };
    for (const [path, hash] of Object.entries(view.blobFiles)) {
      const text = all ? all[path] : blobs!.get(hash);
      if (typeof text === 'string') files[path] = text;
    }
    out = { ...out, files };
  }
  if (!view.effects.some((e) => UNSAFE_EFFECTS.has(e.name))) return out;
  return { ...out, ledger: await readLedger(world, view.id) };
}

const iso = (d: Date | string | undefined) => (d === undefined ? undefined : new Date(d).toISOString());

/** Project the fold into what the UI shows. */
export function sessionView(id: string, state: SessionState): SessionView {
  const armed = armedChaos(state);
  // A process harness (harness-world-process): its turns end with a transcript entry, not a model step.
  const journaled = state.effectOrder.some((e) => e.name === JOURNAL);
  // The hands its run_created recorded (the page's choice; older sessions have none: `legacyHands`).
  const hands = (state.config as { hands?: unknown } | undefined)?.hands;
  return {
    id,
    harness: harnessOf(state.workflowName),
    ...(isHands(hands) ? { hands } : {}),
    status: state.status,
    ...(state.failure ? { failure: state.failure.message } : {}),
    eventCount: state.eventCount,
    ...(isHybrid(harnessOf(state.workflowName)) ? { lane: currentLane(state) } : {}),
    ...(armed ? { armedChaos: armed.chaos } : {}),
    ...(journaled ? { turnOpen: !!openTurn(state) } : {}),
    submissions: state.submissions.map((s) => ({
      id: s.id,
      kind: s.kind,
      text: s.text,
      placed: state.placed.has(s.id),
      withdrawn: state.withdrawn.has(s.id),
    })),
    effects: state.effectOrder.map((e) => ({
      key: e.key,
      stepId: e.stepId,
      name: e.name,
      status: e.status,
      attempt: e.attempt,
      // A settlement carries the files it changed: the view needs only their paths.
      input:
        e.name === 'settle' && e.input && typeof e.input === 'object'
          ? { ...(e.input as object), files: undefined, paths: Object.keys((e.input as { files?: object }).files ?? {}) }
          : // A journal batch: the transcript as it is, native records as counts.
            e.name === JOURNAL
            ? summarizeBatch(e.input)
            : e.input,
      output:
        e.name === 'checkpoint' ? { ...(e.output as object), data: '<kernel checkpoint bytes>' } : e.output,
      error: e.error,
      startedAt: iso(e.startedAt),
      placed: e.placed ?? [],
      ...(e.driver ? { driver: e.driver } : {}),
      ...(e.park
        ? {
            park: {
              kind: e.park.kind,
              ...(typeof e.park.cmdId === 'string' ? { cmdId: e.park.cmdId } : {}),
              ...(typeof e.park.push === 'boolean' ? { push: e.park.push } : {}),
              ...(typeof e.park.sandbox === 'string' ? { sandbox: e.park.sandbox } : {}),
            },
          }
        : {}),
      ...(e.settlement
        ? {
            settlement: {
              by: e.settlement.by,
              ok: e.settlement.ok,
              ...(e.settlement.exitCode !== undefined ? { exitCode: e.settlement.exitCode } : {}),
              files: Object.keys(e.settlement.files ?? {}),
            },
          }
        : {}),
    })),
    files: { ...filesFromState(state), ...binaryFilesOf(state) },
    ...blobFilesOf(state),
    supersededStepIds: [...state.superseded],
    ...docsOf(state),
  };
}

/** The app's documents (the kernel keeps its workspace as `hw.workspace`: that one shows as files). */
function docsOf(state: SessionState): { docs?: SessionView['docs'] } {
  const docs = [...(state.docs?.values() ?? [])].filter((d) => !d.kind.startsWith('hw.')).map((d) => ({ kind: d.kind, revision: d.revision, value: d.value }));
  return docs.length ? { docs } : {};
}

/** A document-backed workspace's text files that are in the blob stream, path to hash. */
function blobFilesOf(state: SessionState): { blobFiles?: Record<string, string> } {
  const blobs = workspaceManifest(state).filter((f) => !f.inline && f.hash && !f.binary);
  return blobs.length ? { blobFiles: Object.fromEntries(blobs.map((f) => [f.path, f.hash!])) } : {};
}

/** Binary files (bytes that are not text) are shown by their size. */
function binaryFilesOf(state: SessionState): Record<string, string> {
  return Object.fromEntries(workspaceManifest(state).filter((f) => f.binary).map((f) => [f.path, `(binary file, ${f.bytes.toLocaleString('en-US')} bytes)`]));
}
