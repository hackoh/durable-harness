import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness, type HarnessOptions, MemoryStorage, ROOT_CONVERSATION_ID, type Storage, type ToolRegistration } from '@earendil-works/pi-durable';
import { registerEnvConformance } from '@earendil-works/pi-durable/testing';
import { CodingTools as PiCodingTools } from '@earendil-works/pi-durable/tools';
import { readBlobContents } from 'harness-world';
import type { AcquireMachine } from 'harness-world-process';
import { devRelayArtifact, FILES_LOST_NOTE, prepareBase, sandboxSession, vercelSandboxApi } from 'harness-world-sandbox';
import { MachineEnv } from 'pi-world/env';
import { deltaOf } from 'pi-world/files';
import { NOT_RUN, SANDBOX_ENDED, sandboxEnvBuilder, sandboxSessionOf } from 'pi-world/sandbox';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as vitest from 'vitest';
import { CodingTools, openWorldReader, openWorldStorage, sandboxEnv } from '../src/pi-durable.ts';
import { sandbox } from '../src/workspace.ts';
import { getWorld } from '../src/world.ts';
import { AtWorkspace, FakeSandboxApi, localMachine, nameOf, relayBundle, SPEC, standIn } from './sandbox-stand-in.ts';

/**
 * B7 for pi-durable (docs/workspaces.md §11.4): `pi-durable-env.test.ts`'s
 * suite on the session's Vercel Sandbox instead of `virtual()`. pi-durable's
 * own Harness with a scripted model, durable-harness's `CodingTools` (and
 * pi-durable's own) on `sandboxEnv()`'s environment, through the sandbox
 * tier's real session factory (`sandboxSession`) with this runtime's own
 * fence (P0.12): the `WorldStorage`'s token, its signal and its record of
 * the sandbox in the session's log.
 *
 * The sandbox is the stand-in (§5.8, always on: `DH_TEST_LOCAL_SANDBOX=1`):
 * each "VM" a local relay child over temp dirs (`localMachine()`'s relay,
 * through harness-sandbox's fake Sandbox API), each "Drive" a temp dir that
 * outlives the VMs mounted on it, each machine's workspace seen at
 * /workspace (`sandbox-stand-in.ts`). In the degraded tier (macOS,
 * unprivileged Linux) its commands run as this user on this machine; what is
 * checked of them is what the tier promises there (their environment is the
 * relay's allowlist, never this process's).
 *
 * With `DH_LIVE_SANDBOX=1`, the last case runs on a live Vercel Sandbox
 * through the same factory and the real Sandbox API (see there).
 */

/** The live case: a real Vercel Sandbox (see there). */
const LIVE = process.env.DH_LIVE_SANDBOX === '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(50);
  }
}

type Env = NonNullable<HarnessOptions['env']>;

/** A Pi app's own setup: a scripted faux model, `registry.install(...)` of `extensions`, and an opener with `env`. */
function piApp(answers: FauxResponseStep[], extensions: Parameters<ReturnType<typeof createRegistry>['install']>[0][], env?: Env) {
  const faux = fauxProvider();
  faux.setResponses(answers);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry = createRegistry();
  for (const e of extensions) registry.install(e);
  const open = (storage: Storage) => Harness.open(storage, { models, registry, ...(env ? { env } : {}) }, ctx);
  return { faux, open, agent: { model: { provider: model.provider, modelId: model.id }, instructions: 'Use the tools.' } };
}

/** One prompt, until its submission settles. */
async function ask(harness: Harness, agent: ReturnType<typeof piApp>['agent'], text: string): Promise<void> {
  const root = await harness.root(ctx, { agent });
  const submission = await root.submit({ type: 'input', content: text }, ctx);
  await submission.wait(ctx);
  await harness.waitForIdle(ctx);
}

const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1], id?: string) => fauxToolCall(name, args, id ? { id } : undefined);
const calls = (...c: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(c, { stopReason: 'toolUse' });
const done = (text = 'Done.') => fauxAssistantMessage([fauxText(text)]);

interface ResultEntry {
  name: string;
  text: string;
  isError: boolean;
  details: unknown;
}

/** The session's tool results, as the log has them (what the model saw, and their details). */
async function results(sessionId: string): Promise<ResultEntry[]> {
  const reader = openWorldReader(sessionId);
  await reader.refresh();
  const snap = await reader.snapshot();
  return snap.entries
    .filter((e) => e.kind === 'pi.tool-result')
    .map((e) => {
      const m = e.model?.[0] as { toolName: string; content: { type: string; text?: string }[]; isError: boolean; details?: unknown };
      return { name: m.toolName, text: m.content.map((c) => c.text ?? '').join(''), isError: m.isError, details: m.details };
    });
}

/** How many sandbox records the session's log holds (the reader lists them, never as commits). */
async function sandboxEntries(sessionId: string): Promise<number> {
  const reader = openWorldReader(sessionId);
  await reader.refresh();
  return (await reader.snapshot()).log.filter((c) => c.summary.includes('sandbox record')).length;
}

/** One turn on a fresh storage (another invocation): open, ask, close. */
async function turn(acquire: AcquireMachine, answers: FauxResponseStep[], options: { sessionId?: string; prompt?: string; tools?: Parameters<ReturnType<typeof createRegistry>['install']>[0][] } = {}) {
  const app = piApp(answers, options.tools ?? [CodingTools], sandboxEnvBuilder(acquire));
  const storage = await openWorldStorage(options.sessionId);
  const harness = await app.open(storage);
  await ask(harness, app.agent, options.prompt ?? 'go');
  await harness.close(ctx);
  return { storage, sessionId: storage.sessionId, out: await results(storage.sessionId) };
}

const apis: FakeSandboxApi[] = [];
/** A stand-in sandbox (`standIn`), disposed after the test. */
function stand(options: Parameters<typeof standIn>[0] = {}) {
  const s = standIn(options);
  if (!options.api) apis.push(s.api);
  return s;
}
/** The fence a VM carries (`dh-fence`, raised at every owner's arm). */
const fenceMark = (api: FakeSandboxApi, name: string) => Number(api.vms.get(name)?.tags['dh-fence']);
const driveFile = (api: FakeSandboxApi, sessionId: string, path: string) => join(api.driveDir(nameOf(sessionId)), path);
/** Whether a process (the stand-in's commands run on this machine) is still alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const envKeys = ['DH_TEST_LOCAL_SANDBOX', 'VERCEL', 'WORKFLOW_TARGET_WORLD', 'WORKFLOW_LOCAL_DATA_DIR', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'HARNESS_CANARY_SECRET'] as const;
const env0: Partial<Record<(typeof envKeys)[number], string>> = {};
const restore = (k: (typeof envKeys)[number]) => (env0[k] === undefined ? delete process.env[k] : (process.env[k] = env0[k]));

beforeAll(async () => {
  for (const k of envKeys) env0[k] = process.env[k];
  // The stand-in's guard (§5.8): the test flag, a test runner, not on Vercel.
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  delete process.env.VERCEL;
  process.env.WORKFLOW_TARGET_WORLD = 'local';
  process.env.WORKFLOW_LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'dh-pi-durable-sandbox-'));
  // The relay bundle, built once (esbuild).
  await relayBundle();
}, 120_000);

afterEach(async () => {
  for (const api of apis.splice(0)) await api.dispose();
});

afterAll(async () => {
  await ((await getWorld()) as { close?: () => Promise<void> }).close?.();
  for (const k of envKeys) restore(k);
});

describe('sandboxEnv(): pi-durable CodingTools on the session sandbox (the stand-in, world-local)', () => {
  it("runs write, edit, read and bash in the session's VM, attached at the first call as the storage's owner: the files on the Drive, none in the log", async () => {
    const CANARY = 'CANARY-ENV-SECRET-b7pd';
    process.env.AI_GATEWAY_API_KEY = `${CANARY}-gateway`;
    process.env.VERCEL_OIDC_TOKEN = `${CANARY}-oidc`;
    process.env.HARNESS_CANARY_SECRET = CANARY;
    try {
      const { api, acquire } = stand();
      const ids: string[] = [];
      const whoami = defineTool({
        name: 'whoami',
        description: 'The workspace id.',
        parameters: Type.Object({}),
        execute: async (_args, api) => (ids.push(String(api.env?.id)), { content: [{ type: 'text', text: String(api.env?.id) }] }),
      }) as ToolRegistration;
      const big = 'line of text\n'.repeat(2000);
      const { sessionId, out } = await turn(
        acquire,
        [
          // Two calls at once (pi-durable runs them side by side): both on the VM, each result its own commit.
          calls(toolCall('write', { path: 'a.txt', content: 'alpha\n' }, 'w1'), toolCall('bash', { command: 'printf beta > b.txt && mkdir -p sub && printf gamma > sub/c.txt' }, 'b1')),
          calls(toolCall('edit', { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }, 'e1'), toolCall('write', { path: 'big.txt', content: big }, 'w2')),
          calls(toolCall('read', { path: 'a.txt' }, 'r1')),
          calls(toolCall('bash', { command: 'cat a.txt b.txt sub/c.txt; echo; wc -l < big.txt | tr -d \' \'; echo "[$AI_GATEWAY_API_KEY][$VERCEL_OIDC_TOKEN][$HARNESS_CANARY_SECRET]"; pwd' }, 'b2'), toolCall('whoami', {}, 'i1')),
          done(),
        ],
        { tools: [CodingTools, defineExtension({ name: 'app', tools: [whoami] })] }
      );
      const by = (name: string, n = 0) => out.filter((r) => r.name === name)[n]!;
      for (const r of out) expect(r.isError, `${r.name}: ${r.text}`).toBe(false);
      expect(by('read').text).toBe('ALPHA\n');
      const lines = by('bash', 1).text.split('\n');
      expect(lines.slice(0, 3)).toEqual(['ALPHA', 'betagamma', '2000']);
      // The commands' environment is the relay's allowlist: nothing of this process's.
      expect(lines[3]).toBe('[][][]');
      expect(lines[4]).toBe('/workspace');
      expect(ids).toEqual([`sandbox:${sessionId}`]);
      // The files are on the Drive, and nothing of them is in the log (no hw.workspace changes, no blobs).
      expect(readFileSync(driveFile(api, sessionId, 'a.txt'), 'utf8')).toBe('ALPHA\n');
      expect(readFileSync(driveFile(api, sessionId, 'sub/c.txt'), 'utf8')).toBe('gamma');
      expect(statSync(driveFile(api, sessionId, 'big.txt')).size).toBe(big.length);
      for (const r of out) expect(deltaOf(r.details)).toBeUndefined();
      expect((await readBlobContents(await getWorld(), sessionId)).size).toBe(0);
      const again = await openWorldStorage(sessionId);
      expect(again.files.entries.size).toBe(0);
      // One VM, one Drive, booted at the first call: the record of it is in the session's log, written in-band.
      expect(api.calls.filter((c) => c.startsWith('createSandbox:'))).toHaveLength(1);
      expect(again.sandbox.record).toMatchObject({ sandboxName: nameOf(sessionId), driveName: nameOf(sessionId), driveId: expect.stringMatching(/^drv_/), image: 'stand-in' });
      expect(await sandboxEntries(sessionId)).toBeGreaterThan(0);
      // The VM was armed with the storage's own token.
      expect(fenceMark(api, nameOf(sessionId))).toBeGreaterThan(0);
      await again.close(ctx);
    } finally {
      for (const k of ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'HARNESS_CANARY_SECRET'] as const) restore(k);
    }
  }, 60_000);

  it('a turn whose tools never reach the workspace boots no VM and writes no sandbox record', async () => {
    const { api, acquire } = stand();
    const echo = defineTool({ name: 'echo', description: 'Echo.', parameters: Type.Object({ text: Type.String() }), execute: async (args: { text: string }) => ({ content: [{ type: 'text', text: args.text }] }) }) as ToolRegistration;
    const { sessionId, out } = await turn(acquire, [calls(toolCall('echo', { text: 'hi' })), done()], { tools: [CodingTools, defineExtension({ name: 'app', tools: [echo] })] });
    expect(out.map((r) => r.text)).toEqual(['hi']);
    expect(api.calls.filter((c) => /^(createSandbox|createDrive|getSandbox|getDrive):/.test(c))).toEqual([]);
    expect(await sandboxEntries(sessionId)).toBe(0);
  });

  it("P0.12: the token is the storage's own: the same for every attach of one storage, higher for the next owner, which preempts it; the old one runs nothing more", async () => {
    const { api, acquire } = stand();
    const a = await openWorldStorage();
    const sessionId = a.sessionId;
    expect(a.writerFence).toBeUndefined();
    const sa = sandboxSessionOf(a, acquire);
    const m1 = await sa.attach();
    // Claimed first (an in-band write of the record), then read: the count its first accepted write was checked against.
    const fa = a.writerFence!;
    expect(fa.fenced).toBe(true);
    expect(m1.fence).toEqual(fa);
    await m1.workspace.writeFile('/workspace/a.txt', 'from A');
    // A re-attach in the same storage (the link closed) shows the relay the same token.
    await m1.close();
    const m2 = await sa.attach();
    expect(m2).not.toBe(m1);
    expect(m2.fence).toEqual(fa);
    expect(a.writerFence).toEqual(fa);

    // Another invocation takes the session over: its token is higher, and its arm preempts A's link at the relay.
    const b = await openWorldStorage(sessionId);
    const sb = sandboxSessionOf(b, acquire);
    const mb = await sb.attach();
    expect(mb.fence!.count).toBeGreaterThan(fa.count);
    expect(mb.fence!.fenced).toBe(true);
    expect(fenceMark(api, nameOf(sessionId))).toBe(mb.fence!.count);
    await until(() => m2.signal.aborted);
    // A doesn't know yet (it has not written since): its token still reads fenced, but the relay refuses it, and its call does not run.
    expect(a.writerFence!.fenced).toBe(true);
    await expect(m2.workspace.writeFile('/workspace/stale.txt', 'from A, late')).rejects.toThrow();
    await expect(sa.attach()).rejects.toThrow(NOT_RUN);
    expect(existsSync(driveFile(api, sessionId, 'stale.txt'))).toBe(false);
    // A's next write is refused by the World: its token is no longer fenced, its signal aborts, and its calls say so.
    await expect(a.writeSandbox(a.sandbox.record ?? {})).rejects.toThrow(/committed to by another process/);
    expect(a.writerFence).toEqual({ count: fa.count, fenced: false });
    expect(a.signal.aborted).toBe(true);
    await expect(sa.attach()).rejects.toThrow(SANDBOX_ENDED);
    // B runs, on the files A wrote.
    expect(new TextDecoder().decode(await mb.workspace.readFile('/workspace/a.txt'))).toBe('from A');
    await b.close(ctx);
    expect(b.writerFence!.fenced).toBe(false);
  }, 60_000);

  it('write on VM A, delete VM A, read on VM B: another invocation, another factory, the same Drive', async () => {
    const { api, acquire } = stand();
    const t1 = await turn(acquire, [
      calls(toolCall('bash', { command: "mkdir -p notes && printf 'written on VM A\\n' > notes/a.txt && printf '#!/bin/sh\\necho hi\\n' > run.sh && chmod 755 run.sh && echo AP8B | base64 -d > bin.dat && echo one >> runs.txt; exit 3" }, 'b1')),
      done(),
    ]);
    // A nonzero exit is the call's error, and what it wrote stays on the Drive, as on a disk.
    expect(t1.out[0]!.isError).toBe(true);
    expect(t1.out[0]!.text).toContain('Command exited with code 3');
    const name = nameOf(t1.sessionId);
    const vmA = (await api.getSandbox(name))!.sessionId;
    const fenceA = fenceMark(api, name);
    const record = (await openWorldStorage(t1.sessionId)).sandbox.record!;

    // VM A goes; the Drive stays. Another process's factory drives the next invocation.
    await (await api.getSandbox(name))!.delete();
    const other = stand({ api });
    const t2 = await turn(other.acquire, [calls(toolCall('read', { path: 'notes/a.txt' }, 'r1')), calls(toolCall('bash', { command: 'test -x run.sh && echo executable; base64 < bin.dat; cat runs.txt; ls' }, 'b2')), done()], { sessionId: t1.sessionId });
    const [read, bash] = t2.out.slice(1);
    expect(read!.text).toBe('written on VM A\n');
    expect(bash!.text).toBe('executable\nAP8B\none\nbin.dat\nnotes\nrun.sh\nruns.txt\n');
    const vmB = (await api.getSandbox(name))!.sessionId;
    expect(vmB).not.toBe(vmA);
    expect(fenceMark(api, name)).toBeGreaterThan(fenceA);
    // Same Drive: no note about lost files, the record unchanged.
    expect(JSON.stringify(t2.out)).not.toContain(FILES_LOST_NOTE);
    const after = (await openWorldStorage(t1.sessionId)).sandbox.record!;
    expect(after.driveId).toBe(record.driveId);
    expect(after.filesLost).toBeUndefined();
  }, 60_000);

  it("the Drive lost: the first result after says the session's files were lost, once; the record acknowledges it with that result", async () => {
    const { api, acquire } = stand();
    const t1 = await turn(acquire, [calls(toolCall('write', { path: 'a.txt', content: 'a' })), done()]);
    const name = nameOf(t1.sessionId);
    const drive1 = (await openWorldStorage(t1.sessionId)).sandbox.record!.driveId;
    await (await api.getSandbox(name))!.delete();
    api.dropDrive(name);
    const t2 = await turn(acquire, [calls(toolCall('bash', { command: 'ls' }, 'b1')), calls(toolCall('bash', { command: 'echo ok' }, 'b2')), done()], { sessionId: t1.sessionId });
    const [ls, ok] = t2.out.slice(1);
    expect(ls!.text).toContain(`<harness>\n[warn] ${FILES_LOST_NOTE}\n</harness>`);
    expect(ls!.text).not.toContain('a.txt');
    // Its result names the Drive it told the model about: committed with it, that acknowledges the note.
    expect(ls!.details).toMatchObject({ 'hw.sandbox': { told: expect.stringMatching(/^drv_/) } });
    expect(ok!.text).toBe('ok\n');
    const record = (await openWorldStorage(t1.sessionId)).sandbox.record!;
    expect(record.driveId).not.toBe(drive1);
    expect(record.filesLost).toBeUndefined();
    // A later invocation says nothing more.
    const t3 = await turn(acquire, [calls(toolCall('bash', { command: 'echo again' })), done()], { sessionId: t1.sessionId });
    expect(t3.out.at(-1)!.text).toBe('again\n');
  }, 60_000);

  it("a failed attach answers the call 'Not run: the sandbox is starting, try again' (nothing ran), and the next call attaches and runs", async () => {
    const { api, acquire } = stand();
    // The control plane refuses the first arm for now (a 503): the factory yields `contended`.
    api.failRuns = { count: 1, error: () => Object.assign(new Error('Service Unavailable'), { response: { status: 503 } }) };
    const { sessionId, out } = await turn(acquire, [calls(toolCall('write', { path: 'first.txt', content: 'x' }, 'w1')), calls(toolCall('write', { path: 'second.txt', content: 'y' }, 'w2')), done()]);
    const [first, second] = out;
    expect(first!.isError).toBe(true);
    expect(first!.text).toContain(NOT_RUN);
    expect(existsSync(driveFile(api, sessionId, 'first.txt'))).toBe(false);
    expect(second!.isError).toBe(false);
    expect(readFileSync(driveFile(api, sessionId, 'second.txt'), 'utf8')).toBe('y');
    // A definite outcome: the call's task failed, it was not interrupted.
    const reader = openWorldReader(sessionId);
    await reader.refresh();
    const tools = (await reader.snapshot()).tasks.filter((t) => t.kind === 'pi.tool');
    expect(tools.every((t) => t.status === 'terminal')).toBe(true);
  }, 60_000);

  it('a crash mid-command: what the command did stays on the Drive, the recovered call is interrupted and never runs again, and the next VM has the files', async () => {
    const { api, acquire } = stand();
    const app = piApp([calls(toolCall('bash', { command: 'echo $$ > shell.pid; echo one >> a.txt; sleep 30; echo two >> a.txt' }, 'b1')), done('Crashed.')], [CodingTools], sandboxEnvBuilder(acquire));
    const storage = await openWorldStorage();
    const sessionId = storage.sessionId;
    const harness = await app.open(storage);
    const root = await harness.root(ctx, { agent: app.agent });
    await root.submit({ type: 'input', content: 'run it' }, ctx);
    // The command is running in the VM: the process dies (nothing more it does lands; its link to the VM drops).
    await until(() => api.drives.has(nameOf(sessionId)) && existsSync(driveFile(api, sessionId, 'a.txt')) && readFileSync(driveFile(api, sessionId, 'a.txt'), 'utf8') === 'one\n');
    storage.abandon();
    // Its link closed, the command's process goes with it (no driver, no command: §5.4).
    const pid = Number(readFileSync(driveFile(api, sessionId, 'shell.pid'), 'utf8'));
    await until(() => !alive(pid), 15_000);
    const name = nameOf(sessionId);
    await (await api.getSandbox(name))!.delete();

    // Another process resumes the session on a new VM.
    const other = stand({ api });
    const app2 = piApp([calls(toolCall('bash', { command: 'cat a.txt' }, 'b2')), done('Recovered.')], [CodingTools], sandboxEnvBuilder(other.acquire));
    const storage2 = await openWorldStorage(sessionId);
    const harness2 = await app2.open(storage2);
    harness2.resume();
    await harness2.waitForIdle(ctx);
    await harness2.close(ctx);
    const [crashed, cat] = await results(sessionId);
    expect(crashed!.isError).toBe(true);
    expect(crashed!.text).toContain('Tool bash was interrupted and may have partially run');
    // It may have taken effect, and it did: the first echo is on the Drive; it was never run again (one line, not two or three).
    expect(cat!.text).toBe('one\n');
    expect(readFileSync(driveFile(api, sessionId, 'a.txt'), 'utf8')).toBe('one\n');
  }, 90_000);

  it('two sessions in one process get distinct env ids, VMs and Drives', async () => {
    const { api, acquire } = stand();
    const ids: string[] = [];
    const whoami = defineTool({
      name: 'whoami',
      description: 'The workspace id.',
      parameters: Type.Object({}),
      execute: async (_args, api) => (ids.push(String(api.env?.id)), { content: [{ type: 'text', text: String(api.env?.id) }] }),
    }) as ToolRegistration;
    const run = (file: string) =>
      turn(acquire, [calls(toolCall('whoami', {}), toolCall('write', { path: file, content: file })), calls(toolCall('bash', { command: 'ls' })), done()], { tools: [CodingTools, defineExtension({ name: 'app', tools: [whoami] })] });
    const [a, b] = await Promise.all([run('one.txt'), run('two.txt')]);
    expect(ids.sort()).toEqual([`sandbox:${a.sessionId}`, `sandbox:${b.sessionId}`].sort());
    expect(a.out.at(-1)!.text).toBe('one.txt\n');
    expect(b.out.at(-1)!.text).toBe('two.txt\n');
    expect(nameOf(a.sessionId)).not.toBe(nameOf(b.sessionId));
    expect(api.vms.size).toBe(2);
    expect(api.driveDir(nameOf(a.sessionId))).not.toBe(api.driveDir(nameOf(b.sessionId)));
  }, 60_000);

  it("a command past the sandbox's time limit is stopped with a definite error; what it wrote first stays (not transactional)", async () => {
    const { api, acquire } = stand({ spec: { commandTimeoutMs: 1000 } });
    const { sessionId, out } = await turn(acquire, [calls(toolCall('bash', { command: 'printf x > t.txt; sleep 5; printf y > u.txt' })), done()]);
    const [bash] = out;
    expect(bash!.isError).toBe(true);
    expect(bash!.text).toContain('ran past its time limit (1 s), so it was stopped: partial effects may exist');
    expect(bash!.text).not.toContain('nothing this call changed was kept');
    expect(readFileSync(driveFile(api, sessionId, 't.txt'), 'utf8')).toBe('x');
    expect(existsSync(driveFile(api, sessionId, 'u.txt'))).toBe(false);
  }, 30_000);

  it('the VM-time budget holds across invocations: the record of the time granted is in the session’s log', async () => {
    const { api, acquire } = stand({ spec: { budget: { vmSeconds: 120 } } });
    const t1 = await turn(acquire, [calls(toolCall('bash', { command: 'echo first' })), done()]);
    expect(t1.out[0]!.text).toBe('first\n');
    expect((await openWorldStorage(t1.sessionId)).sandbox.record!.vmSeconds).toBe(120);
    // VM A goes: the next invocation would need a fresh VM, and the session has used its 120 s.
    await (await api.getSandbox(nameOf(t1.sessionId)))!.delete();
    const t2 = await turn(acquire, [calls(toolCall('bash', { command: 'echo second' })), done()], { sessionId: t1.sessionId });
    const second = t2.out.at(-1)!;
    expect(second.isError).toBe(true);
    expect(second.text).toContain('used its sandbox VM time');
    expect(second.text).not.toContain(NOT_RUN);
    expect(api.calls.filter((c) => c.startsWith('createSandbox:'))).toHaveLength(1);
  }, 60_000);

  it("pi-durable's own CodingTools work on the sandbox too: read and write, on the same Drive", async () => {
    const { api, acquire } = stand();
    const { sessionId, out } = await turn(acquire, [calls(toolCall('write', { path: 'own.txt', content: 'own tools' })), calls(toolCall('read', { path: 'own.txt' }), toolCall('bash', { command: 'cat own.txt' })), done()], { tools: [PiCodingTools] });
    for (const r of out) expect(r.isError, r.text).toBe(false);
    expect(out[1]!.text).toBe('own tools');
    expect(out[2]!.text).toBe('own tools');
    expect(readFileSync(driveFile(api, sessionId, 'own.txt'), 'utf8')).toBe('own tools');
  }, 60_000);

  it('sandboxEnv() needs a World storage: on another storage a call says so', async () => {
    const { acquire } = stand();
    const app = piApp([calls(toolCall('bash', { command: 'echo hi' })), done()], [CodingTools], sandboxEnvBuilder(acquire));
    const memory = new MemoryStorage();
    const harness = await app.open(memory);
    await ask(harness, app.agent, 'hi');
    const entries = await memory.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, ctx);
    await harness.close(ctx);
    const result = entries.items.find((e) => e.kind === 'pi.tool-result');
    expect(JSON.stringify(result?.model)).toContain('openWorldStorage()');
  });

  it('sandboxEnv(sandbox()): on a World without the in-band writer fence a call fails closed, saying so, before the Sandbox API is asked anything', async () => {
    const before = process.env.HARNESS_IN_BAND_FENCE;
    process.env.HARNESS_IN_BAND_FENCE = '0';
    try {
      const app = piApp([calls(toolCall('bash', { command: 'echo hi' })), done()], [CodingTools], sandboxEnv(sandbox({ image: 'never-booted' })));
      const storage = await openWorldStorage();
      const harness = await app.open(storage);
      await ask(harness, app.agent, 'hi');
      await harness.close(ctx);
      const [bash] = await results(storage.sessionId);
      expect(bash!.isError).toBe(true);
      expect(bash!.text).toContain('sandbox() needs a World with the in-band writer fence');
      expect(bash!.text).not.toContain(NOT_RUN);
    } finally {
      if (before === undefined) delete process.env.HARNESS_IN_BAND_FENCE;
      else process.env.HARNESS_IN_BAND_FENCE = before;
    }
  });
});

// pi-durable's own conformance suite, on the environment `sandboxEnv()` gives each call, over the stand-in VM's workspace
// (`localMachine()`: the relay's helper behind `RemoteMachine`), each case in a fresh directory of it.
let local: Awaited<ReturnType<typeof localMachine>> | undefined;
let cases = 0;
afterAll(async () => {
  await local?.dispose();
});
registerEnvConformance(vitest, 'MachineEnv on the session sandbox (pi-durable env conformance, the stand-in)', async (use) => {
  process.env.DH_TEST_LOCAL_SANDBOX = '1';
  local ??= await localMachine();
  const machine = new AtWorkspace(local.machine.workspace);
  const cwd = `/workspace/case-${++cases}`;
  await machine.mkdir(cwd, { recursive: true });
  await use(new MachineEnv({ id: `sandbox:conformance:${cases}`, cwd, access: { use: (_mode, work) => work(machine) }, transactional: false }));
});

/**
 * The live case (`DH_LIVE_SANDBOX=1`): the same integration on a real Vercel
 * Sandbox, through the session factory and `@vercel/sandbox` (no stand-in, no
 * path view: the VM's Drive is at /workspace), with the storage's own fencing
 * token: a turn on VM A runs pi-durable's write and bash as the VM's
 * unprivileged user; VM A is deleted (the Drive stays); the next invocation,
 * on VM B through another factory, reads the files. Run it from a directory
 * linked to a Vercel project (`DH_LIVE_SANDBOX_DIR`, default the directory
 * the test started in), with the Vercel CLI logged in: the SDK mints the
 * linked project's development token through `@vercel/oidc`. Every sandbox,
 * Drive and snapshot is named `dh-probe-*` and tagged (harness-sandbox's
 * `probes/sweep.ts` finds what a killed run left), and `afterAll` deletes
 * them. No secret is printed.
 */
describe.runIf(LIVE)('live: pi-durable on a Vercel Sandbox', () => {
  let lib: typeof import('../../harness-sandbox/probes/lib.ts');
  const cwd0 = process.cwd();
  beforeAll(async () => {
    process.chdir(process.env.DH_LIVE_SANDBOX_DIR ?? cwd0);
    lib = await import('../../harness-sandbox/probes/lib.ts');
  });
  // A Drive can be deleted only once it detached (6-20 s after its VM went): the cleanup retries for longer than a hook's default.
  afterAll(async () => {
    try {
      expect(await lib.cleanup()).toEqual([]);
    } finally {
      process.chdir(cwd0);
    }
  }, 240_000);

  it('a turn on VM A writes with the CodingTools; VM A is deleted; the next invocation, on VM B over the same Drive, reads them', { timeout: 15 * 60_000 }, async () => {
    const api = vercelSandboxApi();
    // A base with the relay only (pi-durable's tools need no CLI), built in a builder named for the sweep.
    const snapshot = await prepareBase({ region: 'iad1', relay: await devRelayArtifact(), clis: [], name: lib.track('sandbox', lib.probeName('b7pdbase')), tags: lib.TAGS });
    lib.created.snapshots.add(snapshot.snapshotId);
    const name = lib.probeName('b7pd');
    lib.track('sandbox', name);
    lib.track('drive', name);
    const factory = () =>
      sandboxSession({
        spec: { image: { snapshot: snapshot.snapshotId }, vcpus: 2, network: 'allow-all', idleMs: 60_000, driveSize: 1024 ** 3, budget: { vmSeconds: 3600 } },
        tags: lib.TAGS,
        test: { name: () => name },
      });
    const a = await turn(factory(), [
      calls(toolCall('write', { path: 'notes/live.txt', content: 'written on VM A\n' }, 'v1')),
      calls(toolCall('bash', { command: 'cat /workspace/notes/live.txt; id -un; pwd; echo "[$AI_GATEWAY_API_KEY][$VERCEL_OIDC_TOKEN]"' }, 'v2')),
      done(),
    ]);
    expect(a.out.map((r) => r.isError)).toEqual([false, false]);
    expect(a.out[1]!.text).toBe('written on VM A\nagent\n/workspace\n[][]\n');
    const vmA = (await api.getSandbox(name))!;
    const fenceA = vmA.fenceMark!;
    expect(fenceA).toBeGreaterThan(0);

    // VM A goes; the Drive stays. Another factory (another process's) drives the next invocation.
    await vmA.delete();
    const b = await turn(factory(), [calls(toolCall('read', { path: 'notes/live.txt' }, 'v3')), calls(toolCall('bash', { command: 'ls /workspace/notes; stat -c %U /workspace/notes/live.txt' }, 'v4')), done()], { sessionId: a.sessionId });
    const [read, ls] = b.out.slice(2);
    expect(read!.text).toBe('written on VM A\n');
    expect(ls!.text).toBe('live.txt\nagent\n');
    const vmB = (await api.getSandbox(name))!;
    expect(vmB.sessionId).not.toBe(vmA.sessionId);
    expect(vmB.fenceMark!).toBeGreaterThan(fenceA);
    expect(JSON.stringify(b.out)).not.toContain(FILES_LOST_NOTE);
  });
});
