import type { Event, Storage } from '@workflow/world';
import { eventIdToSlot, slotToEventId } from '@workflow/world';
import { req, STORES, transact } from './idb.ts';

/* biome-ignore-all lint/suspicious/noExplicitAny: entity rows are loosely typed */
type Row = Record<string, any>;

const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled']);

/** Errors carry an HTTP-ish status like the other Worlds' errors do. */
class WorldError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'WorkflowWorldError';
  }
}

function page<T>(items: T[], limit = 100, cursor?: string) {
  const start = cursor ? Number(cursor) : 0;
  const data = items.slice(start, start + limit);
  const next = start + data.length;
  return { data, cursor: next < items.length ? String(next) : null, hasMore: next < items.length };
}

function stripRun(row: Row, resolveData?: string) {
  const { eventCount: _eventCount, ...run } = row;
  if (resolveData === 'none') {
    delete run.input;
    delete run.output;
    delete run.error;
  }
  return run;
}

function stripData(row: Row, resolveData?: string) {
  if (resolveData !== 'none') return row;
  const { input: _i, output: _o, error: _e, ...rest } = row;
  return rest;
}

/**
 * Storage over IndexedDB. Every `events.create` is one IndexedDB
 * transaction over the run, its log, and the touched entity, so slot
 * allocation is atomic across tabs: IndexedDB serializes overlapping
 * readwrite transactions, which is exactly the "allocate at the commit"
 * property the World contract asks for.
 */
export function createStorage(db: IDBDatabase, onEvent: (runId: string) => void): Storage {
  async function listEvents(runId: string): Promise<Row[]> {
    const tx = db.transaction(STORES.events, 'readonly');
    const range = IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
    return req(tx.objectStore(STORES.events).getAll(range));
  }

  const storage = {
    runs: {
      async get(id: string, params?: { resolveData?: string }) {
        const row = await req(db.transaction(STORES.runs).objectStore(STORES.runs).get(id));
        if (!row) throw new WorldError(`Workflow run "${id}" not found`, 404);
        return stripRun(row, params?.resolveData);
      },
      async list(params: Row = {}) {
        const rows: Row[] = await req(db.transaction(STORES.runs).objectStore(STORES.runs).getAll());
        let runs = rows.filter(
          (r) =>
            (!params.workflowName || r.workflowName === params.workflowName) &&
            (!params.status || r.status === params.status)
        );
        runs.sort((a, b) => (a.runId < b.runId ? -1 : 1));
        if (params.pagination?.sortOrder !== 'asc') runs = runs.reverse();
        return page(
          runs.map((r) => stripRun(r, params.resolveData)),
          params.pagination?.limit,
          params.pagination?.cursor
        );
      },
    },

    steps: {
      async get(runId: string, stepId: string, params?: { resolveData?: string }) {
        const row = await req(db.transaction(STORES.steps).objectStore(STORES.steps).get([runId, stepId]));
        if (!row) throw new WorldError(`Step "${stepId}" not found`, 404);
        return stripData(row, params?.resolveData);
      },
      async list(params: Row) {
        const rows: Row[] = await req(
          db.transaction(STORES.steps).objectStore(STORES.steps).index('runId').getAll(params.runId)
        );
        rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        return page(rows.map((r) => stripData(r, params.resolveData)), params.pagination?.limit, params.pagination?.cursor);
      },
    },

    hooks: {
      async get(hookId: string) {
        const row = await req(db.transaction(STORES.hooks).objectStore(STORES.hooks).get(hookId));
        if (!row) throw new WorldError(`Hook "${hookId}" not found`, 404);
        return row;
      },
      async getByToken(token: string) {
        const row = await req(db.transaction(STORES.hooks).objectStore(STORES.hooks).index('token').get(token));
        if (!row) throw new WorldError(`Hook with token "${token}" not found`, 404);
        return row;
      },
      async list(params: Row) {
        const store = db.transaction(STORES.hooks).objectStore(STORES.hooks);
        const rows: Row[] = params.runId ? await req(store.index('runId').getAll(params.runId)) : await req(store.getAll());
        return page(rows, params.pagination?.limit, params.pagination?.cursor);
      },
    },

    events: {
      async create(runId: string | null, data: Row, params: Row = {}) {
        const id = runId ?? data.runId;
        if (!id) throw new WorldError('runId is required', 400);
        const result = await transact(
          db,
          [STORES.runs, STORES.events, STORES.steps, STORES.hooks, STORES.waits],
          'readwrite',
          (tx) => applyEvent(tx, id, data, params)
        );
        onEvent(id);
        return result;
      },

      async list(params: Row) {
        const rows = await listEvents(params.runId);
        let events = rows.map(toEvent);
        if (params.pagination?.sortOrder === 'desc') events = events.reverse();
        const limit = params.pagination?.limit ?? 1000;
        // Cursor is the last slot returned, so readers that fold appends can
        // resume without rereading.
        const after = params.pagination?.cursor ? Number(params.pagination.cursor) : undefined;
        const sliced =
          after === undefined
            ? events
            : events.filter((e) => {
                const slot = eventIdToSlot(e.eventId)!;
                return params.pagination?.sortOrder === 'desc' ? slot < after : slot > after;
              });
        const data = sliced.slice(0, limit).map((e) => stripEventData(e, params.resolveData));
        const last = data.at(-1);
        return {
          data,
          cursor: last ? String(eventIdToSlot(last.eventId)) : (params.pagination?.cursor ?? null),
          hasMore: sliced.length > limit,
        };
      },

      async get(runId: string, eventId: string) {
        const slot = eventIdToSlot(eventId);
        const row = await req(db.transaction(STORES.events).objectStore(STORES.events).get([runId, slot!]));
        if (!row) throw new WorldError(`Event "${eventId}" not found`, 404);
        return toEvent(row);
      },

      async listByCorrelationId(params: Row) {
        const rows = await listEvents(params.runId);
        return page(
          rows.filter((r) => r.correlationId === params.correlationId).map(toEvent),
          params.pagination?.limit ?? 1000,
          params.pagination?.cursor
        );
      },
    },
  };
  return storage as unknown as Storage;
}

function toEvent(row: Row): Event {
  const { slot, ...event } = row;
  return { ...event, eventId: slotToEventId(slot), createdAt: new Date(row.createdAt) } as Event;
}

function stripEventData(event: Event, resolveData?: string): Event {
  if (resolveData !== 'none' || !('eventData' in event)) return event;
  const { eventData, ...rest } = event as Row;
  const { input: _i, result: _r, error: _e, payload: _p, output: _o, ...meta } = eventData ?? {};
  return { ...rest, eventData: meta } as Event;
}

/** The one place the log's semantics live: validate, materialize, append. */
async function applyEvent(tx: IDBTransaction, runId: string, data: Row, params: Row) {
  const runs = tx.objectStore(STORES.runs);
  const events = tx.objectStore(STORES.events);
  const steps = tx.objectStore(STORES.steps);
  const hooks = tx.objectStore(STORES.hooks);
  const waits = tx.objectStore(STORES.waits);
  const now = new Date();
  const eventData = data.eventData ?? {};

  let run: Row | undefined = await req(runs.get(runId));
  const appended: Row[] = [];
  const append = (event: Row) => {
    run!.eventCount = (run!.eventCount ?? 0) + 1;
    const row = { runId, slot: run!.eventCount, createdAt: (params.occurredAt ?? now).getTime?.() ?? now.getTime(), ...event };
    events.put(row);
    appended.push(row);
    return row;
  };

  if (data.eventType === 'run_created') {
    if (run) throw new WorldError(`Workflow run "${runId}" already exists`, 409);
    run = {
      runId,
      status: 'pending',
      deploymentId: eventData.deploymentId,
      workflowName: eventData.workflowName,
      specVersion: data.specVersion,
      executionContext: eventData.executionContext,
      input: eventData.input,
      attributes: eventData.attributes ?? {},
      createdAt: now,
      updatedAt: now,
      eventCount: 0,
    };
  } else if (!run) {
    throw new WorldError(`Workflow run "${runId}" not found`, 404);
  }
  const reportedFrom = (params.eventCount ?? run.eventCount ?? 0) + 1;

  const needStep = async () => {
    const step = await req(steps.get([runId, data.correlationId]));
    if (!step) throw new WorldError(`Step "${data.correlationId}" not found`, 404);
    return step as Row;
  };
  const isTerminalRun = TERMINAL_RUN.has(run.status);
  let entity: Row = {};

  switch (data.eventType) {
    case 'run_created':
      append({ eventType: 'run_created', specVersion: data.specVersion, eventData });
      entity = { run };
      break;
    case 'run_started':
      if (isTerminalRun) throw new WorldError('run is terminal', 409);
      run.status = 'running';
      run.startedAt ??= now;
      append({ eventType: 'run_started', eventData });
      entity = { run };
      break;
    case 'run_completed':
    case 'run_failed':
    case 'run_cancelled': {
      if (isTerminalRun) throw new WorldError('run is terminal', 409);
      run.status = data.eventType.slice(4);
      run.completedAt = now;
      if (data.eventType === 'run_completed') run.output = eventData.output;
      if (data.eventType === 'run_failed') run.error = eventData.error;
      append({ eventType: data.eventType, eventData });
      // A terminal run's hooks can no longer be resumed.
      const owned: Row[] = await req(hooks.index('runId').getAll(runId));
      for (const hook of owned) hooks.delete(hook.hookId);
      entity = { run };
      break;
    }
    case 'step_created': {
      if (isTerminalRun) throw new WorldError('run is terminal', 409);
      if (await req(steps.get([runId, data.correlationId]))) throw new WorldError('step exists', 409);
      const step = { runId, stepId: data.correlationId, stepName: eventData.stepName, status: 'pending', input: eventData.input, attempt: 0, createdAt: now, updatedAt: now };
      steps.put(step);
      append({ eventType: 'step_created', correlationId: data.correlationId, eventData });
      entity = { step };
      break;
    }
    case 'step_started': {
      let step: Row | undefined = await req(steps.get([runId, data.correlationId]));
      let stepCreated: true | undefined;
      if (!step) {
        // Born running: materialize the step and a synthetic step_created
        // so replay still observes the creation.
        if (eventData.input === undefined) throw new WorldError(`Step "${data.correlationId}" not found`, 404);
        if (isTerminalRun) throw new WorldError('run is terminal', 409);
        step = { runId, stepId: data.correlationId, stepName: eventData.stepName, status: 'pending', input: eventData.input, attempt: 0, createdAt: now, updatedAt: now };
        append({ eventType: 'step_created', correlationId: data.correlationId, eventData: { stepName: eventData.stepName, input: eventData.input } });
        stepCreated = true;
      }
      if (step.status === 'completed' || step.status === 'failed') throw new WorldError('step is terminal', 409);
      step.status = 'running';
      step.attempt += 1;
      step.startedAt ??= now;
      step.updatedAt = now;
      steps.put(step);
      const { input: _input, ...meta } = eventData;
      append({ eventType: 'step_started', correlationId: data.correlationId, eventData: meta });
      entity = { step, ...(stepCreated ? { stepCreated } : {}) };
      break;
    }
    case 'step_completed':
    case 'step_failed':
    case 'step_retrying': {
      const step = await needStep();
      if (step.status === 'completed' || step.status === 'failed') throw new WorldError('step is terminal', 409);
      if (data.eventType === 'step_completed') {
        step.status = 'completed';
        step.output = eventData.result;
        step.completedAt = now;
      } else if (data.eventType === 'step_failed') {
        step.status = 'failed';
        step.error = eventData.error;
        step.completedAt = now;
      } else {
        step.status = 'pending';
        step.error = eventData.error;
        step.retryAfter = eventData.retryAfter;
      }
      step.updatedAt = now;
      steps.put(step);
      append({ eventType: data.eventType, correlationId: data.correlationId, eventData });
      entity = { step };
      break;
    }
    case 'hook_created': {
      if (isTerminalRun) throw new WorldError('run is terminal', 409);
      const holder: Row | undefined = await req(hooks.index('token').get(eventData.token));
      if (holder) {
        append({ eventType: 'hook_conflict', correlationId: data.correlationId, eventData: { token: eventData.token, conflictingRunId: holder.runId } });
        break;
      }
      const hook = { runId, hookId: data.correlationId, token: eventData.token, metadata: eventData.metadata, isWebhook: eventData.isWebhook, createdAt: now, ownerId: 'browser', projectId: 'browser', environment: 'browser', specVersion: run.specVersion };
      hooks.put(hook);
      append({ eventType: 'hook_created', correlationId: data.correlationId, eventData });
      entity = { hook };
      break;
    }
    case 'hook_received': {
      const hook = await req(hooks.get(data.correlationId));
      if (!hook) throw new WorldError(`Hook "${data.correlationId}" not found`, 404);
      append({ eventType: 'hook_received', correlationId: data.correlationId, eventData });
      break;
    }
    case 'hook_disposed':
      hooks.delete(data.correlationId);
      append({ eventType: 'hook_disposed', correlationId: data.correlationId, eventData });
      break;
    case 'wait_created': {
      const wait = { runId, waitId: data.correlationId, status: 'waiting', resumeAt: eventData.resumeAt, createdAt: now };
      waits.put(wait);
      append({ eventType: 'wait_created', correlationId: data.correlationId, eventData });
      entity = { wait };
      break;
    }
    case 'wait_completed': {
      const wait = { ...(await req(waits.get([runId, data.correlationId]))), status: 'completed', completedAt: now };
      waits.put(wait);
      append({ eventType: 'wait_completed', correlationId: data.correlationId, eventData });
      entity = { wait };
      break;
    }
    case 'attr_set':
      run.attributes = { ...run.attributes, ...(eventData.attributes ?? {}) };
      append({ eventType: 'attr_set', eventData });
      break;
    default:
      throw new WorldError(`Unsupported event type "${data.eventType}"`, 400);
  }

  run.updatedAt = now;
  runs.put(run);
  if (entity.run) entity.run = stripRun(run);

  const ours = appended.at(-1);
  const event = ours ? toEvent(ours) : undefined;
  // Bump and report: anything between the writer's view and our commit.
  const skippedFrom = reportedFrom;
  const skippedTo = (appended[0]?.slot ?? run.eventCount + 1) - 1;
  let skipped: Event[] = [];
  if (skippedTo >= skippedFrom) {
    const range = IDBKeyRange.bound([runId, skippedFrom], [runId, skippedTo]);
    skipped = ((await req(events.getAll(range))) as Row[]).map(toEvent);
  }
  return {
    event,
    ...entity,
    ...(skipped.length ? { events: skipped, cursor: String(skippedTo), hasMore: false } : {}),
  };
}
