import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_RESUME_DEDUP_VERSION, type CreateEventParams, type CreateEventRequest } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode } from './codec.ts';
import { SessionLog } from './session-log.ts';
import { durableSessions, SubmissionConflict } from './sessions.ts';
import type { Harness } from './types.ts';

const worlds: LocalWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close?.();
});

async function setup(atomic = true, runAhead = false) {
  const world = createWorld({ dataDir: await mkdtemp(join(tmpdir(), 'hw-identity-')), recoverActiveRuns: false });
  worlds.push(world);
  world.capabilities!.hookResumeDedup = atomic;
  const wake = vi.spyOn(world, 'queue').mockResolvedValue({ messageId: null });
  const executed: string[] = [];
  const harness: Harness = {
    name: 'identity',
    async drive(ctx) {
      for (const s of ctx.pending()) {
        await ctx.effect(`consume:${s.id}`, { name: 'consume', replay: 'never', input: s.text, placed: [s.id] }, async () => {
          executed.push(s.text!);
          return 'consumed';
        });
      }
    },
  };
  const makeSessions = () => durableSessions({ world, harness, runAhead });
  const sessions = makeSessions();
  const { sessionId } = await sessions.start();
  const events = async () => (await world.events.list({ runId: sessionId, pagination: { sortOrder: 'asc', limit: 1000 }, resolveData: 'all' })).data.filter((e) => e.eventType === 'hook_received');
  return { world, sessions, sessionId, makeSessions, executed, wake, events };
}

const ambiguous = () => Object.assign(new Error('ack lost'), { ambiguous: true });

function race(world: LocalWorld) {
  const create = world.events.create.bind(world.events);
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const writes: { request: CreateEventRequest; params: CreateEventParams | undefined }[] = [];
  vi.spyOn(world.events, 'create').mockImplementation(async (runId, request, params) => {
    if (request.eventType === 'hook_received') {
      writes.push({ request, params });
      if (++arrivals === 2) release();
      await ready;
    }
    return create(runId, request, params);
  });
  return writes;
}

async function assertExecutedOnce(t: Awaited<ReturnType<typeof setup>>, text: string) {
  await t.sessions.drive(t.sessionId);
  await t.makeSessions().drive(t.sessionId);
  expect(t.executed).toEqual([text]);
}

describe.each([true, false])('caller identity (atomic support: %s)', (atomic) => {
  it('returns the canonical ID across fresh callers and retries the wake', async () => {
    const t = await setup(atomic);
    const id = await t.sessions.send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' });
    expect(await t.makeSessions().send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' })).toBe(id);
    expect(await t.events()).toHaveLength(1);
    expect(t.wake).toHaveBeenCalledTimes(2);
    await assertExecutedOnce(t, 'hello');
  });

  it('rejects changed text and kind without appending', async () => {
    const t = await setup(atomic);
    const id = await t.sessions.send(t.sessionId, 'private text', 'prompt', { identity: 'request-1' });
    for (const [text, kind] of [['changed text', 'prompt'], ['private text', 'steer']] as const) {
      await expect(t.makeSessions().send(t.sessionId, text, kind, { identity: 'request-1' })).rejects.toMatchObject({ name: 'SubmissionConflict', submissionId: id });
    }
    expect(await t.events()).toHaveLength(1);
  });

  it('arbitrates concurrent identical sends and binds a stable digest', async () => {
    const t = await setup(atomic);
    const writes = race(t.world);
    const ids = await Promise.all([t.sessions, t.makeSessions()].map((s) => s.send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' })));
    expect(ids[0]).toBe(ids[1]);
    expect(await t.events()).toHaveLength(atomic ? 1 : 2);
    expect((await t.sessions.inspect(t.sessionId)).submissions).toHaveLength(1);
    if (atomic) {
      expect(writes[0]!.params?.resumeId).toBe('caller:request-1');
      expect(writes[0]!.params?.resumePayloadDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(writes[1]!.params?.resumePayloadDigest).toBe(writes[0]!.params?.resumePayloadDigest);
      const request = writes[0]!.request;
      if (request.eventType !== 'hook_received') throw new Error('expected hook');
      expect(writes[0]!.params?.resumePayloadDigest).toBe(createHash('sha256').update(request.eventData.payload as Uint8Array).digest('hex'));
    } else {
      expect(writes.every((w) => w.params?.resumeId === undefined && w.params?.resumePayloadDigest === undefined)).toBe(true);
    }
    await assertExecutedOnce(t, 'hello');
  });

  it('rejects the concurrent conflicting loser and executes only the winner', async () => {
    const t = await setup(atomic);
    race(t.world);
    const results = await Promise.allSettled([t.sessions.send(t.sessionId, 'one', 'prompt', { identity: 'request-1' }), t.makeSessions().send(t.sessionId, 'two', 'prompt', { identity: 'request-1' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SubmissionConflict);
    expect(rejected.reason.message).not.toContain('one');
    expect(rejected.reason.message).not.toContain('two');
    const state = await t.sessions.inspect(t.sessionId);
    expect(state.submissions).toHaveLength(1);
    expect(rejected.reason.submissionId).toBe(state.submissions[0]!.id);
    expect(await t.events()).toHaveLength(atomic ? 1 : 2);
    await assertExecutedOnce(t, state.submissions[0]!.text!);
  });

  it('recovers a write acknowledgment lost after commit', async () => {
    const t = await setup(atomic);
    const create = t.world.events.create.bind(t.world.events);
    let armed = true;
    vi.spyOn(t.world.events, 'create').mockImplementation(async (runId, request, params) => {
      const result = await create(runId, request, params);
      if (request.eventType === 'hook_received' && armed) { armed = false; throw ambiguous(); }
      return result;
    });
    const id = await t.sessions.send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' });
    expect(await t.makeSessions().send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' })).toBe(id);
    expect(await t.events()).toHaveLength(1);
  });

  it('recovers externally after exhausted transport retries without blind atomic resend', async () => {
    const t = await setup(atomic);
    const create = t.world.events.create.bind(t.world.events);
    let writes = 0;
    vi.spyOn(t.world.events, 'create').mockImplementation(async (runId, request, params) => {
      if (request.eventType === 'hook_received' && ++writes <= 2) throw ambiguous();
      return create(runId, request, params);
    });
    await expect(t.sessions.send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' })).rejects.toThrow('ack lost');
    expect(writes).toBe(atomic ? 1 : 2);
    expect(await t.events()).toHaveLength(0);
    // Atomic mode leaves recovery to the next caller; fallback retains its one resend.
    if (atomic) writes = 2;
    const id = await t.makeSessions().send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' });
    expect((await t.sessions.inspect(t.sessionId)).submissions[0]!.id).toBe(id);
    expect(await t.events()).toHaveLength(1);
  });

  it('recovers a lost wake acknowledgment using the same committed submission', async () => {
    const t = await setup(atomic);
    t.wake.mockRejectedValueOnce(new Error('wake ack lost'));
    await expect(t.sessions.send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' })).rejects.toThrow('wake ack lost');
    const committed = (await t.sessions.inspect(t.sessionId)).submissions[0]!.id;
    expect(await t.makeSessions().send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' })).toBe(committed);
    expect(await t.events()).toHaveLength(1);
  });
});

it('reads a fresh by-token capability attestation and honors its removal', async () => {
  const t = await setup(false);
  const lookup = t.world.hooks.getByToken.bind(t.world.hooks);
  let attested = true;
  const get = vi.spyOn(t.world.hooks, 'getByToken').mockImplementation(async (...args) => ({
    ...await lookup(...args),
    resumeCapabilities: attested ? { hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION } : undefined,
  }));
  const create = vi.spyOn(t.world.events, 'create');
  await t.sessions.send(t.sessionId, 'one', 'prompt', { identity: 'one' });
  expect(create.mock.calls.at(-1)?.[2]?.resumeId).toBe('caller:one');
  attested = false;
  await t.sessions.send(t.sessionId, 'two', 'prompt', { identity: 'two' });
  expect(create.mock.calls.at(-1)?.[2]?.resumeId).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(2);
});

it('refuses an attestation for a hook whose owner has changed', async () => {
  const t = await setup(false);
  const lookup = t.world.hooks.getByToken.bind(t.world.hooks);
  vi.spyOn(t.world.hooks, 'getByToken').mockImplementation(async (...args) => ({ ...await lookup(...args), runId: 'another-run', resumeCapabilities: { hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION } }));
  await expect(t.sessions.send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' })).rejects.toThrow('ownership changed');
  expect(await t.events()).toHaveLength(0);
});

it('does not refold an older canonical event returned by World', async () => {
  const t = await setup();
  const id = await t.sessions.send(t.sessionId, 'hello', 'prompt', { identity: 'request-1' });
  const log = new SessionLog(t.world, t.sessionId);
  await log.refresh();
  const before = log.state.eventCount;
  const payload = encode({ kind: 'prompt', text: 'hello', nonce: 'caller:request-1' });
  const result = await log.write({ eventType: 'hook_received', correlationId: log.state.inbox!.hookId, eventData: { token: log.state.inbox!.token, payload } }, { resume: { resumeId: 'caller:request-1', resumePayloadDigest: createHash('sha256').update(payload).digest('hex') } });
  expect(result.event!.eventId).toBe(id);
  expect(log.state.eventCount).toBe(before);
  expect(log.state.submissions).toHaveLength(1);
  expect(await t.events()).toHaveLength(1);
});

it('keeps generated sends independent and skips capability lookup', async () => {
  const t = await setup(false);
  const get = vi.spyOn(t.world.hooks, 'getByToken');
  const create = vi.spyOn(t.world.events, 'create');
  const ids = [await t.sessions.send(t.sessionId, 'hello'), await t.sessions.send(t.sessionId, 'hello')];
  expect(ids[0]).not.toBe(ids[1]);
  expect(get).not.toHaveBeenCalled();
  expect(create.mock.calls.every((c) => c[2]?.resumeId === undefined)).toBe(true);
});

it('scopes identity to each session and rejects empty identity or run-ahead', async () => {
  const t = await setup();
  const first = await t.sessions.send(t.sessionId, 'one', 'prompt', { identity: 'same' });
  const { sessionId: other } = await t.sessions.start();
  await t.sessions.send(other, 'two', 'prompt', { identity: 'same' });
  expect((await t.sessions.inspect(t.sessionId)).submissions[0]!.id).toBe(first);
  expect((await t.sessions.inspect(other)).submissions[0]!.text).toBe('two');
  await expect(t.sessions.send(t.sessionId, 'hello', 'prompt', { identity: '' })).rejects.toThrow('nonempty');
  const ahead = await setup(true, true);
  await expect(ahead.sessions.send(ahead.sessionId, 'hello', 'prompt', { identity: 'request-1', wake: 'backstop' })).rejects.toThrow('requires runAhead=false');
  expect(await ahead.events()).toHaveLength(0);
});
