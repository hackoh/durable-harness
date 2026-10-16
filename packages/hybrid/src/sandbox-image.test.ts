import { spawnSync } from 'node:child_process';
import { APIError, Sandbox } from '@vercel/sandbox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isImageNotFound, prefetchScript, VercelSandboxProvider } from './sandbox.ts';

/** The sandbox lane's VCR image (P6): VMs ask for it with its tag, and fall back to the default image when it is missing. */

function fakeSandbox(commands: string[] = []) {
  return {
    name: 'vm',
    status: 'running',
    update: async () => {},
    runCommand: async (p: { args?: string[] }) => {
      commands.push(p.args?.join(' ') ?? '');
      return { exitCode: 0, stdout: async () => '', stderr: async () => '' };
    },
  };
}

const notFound = () => new APIError(new Response('{}', { status: 404 }), { message: 'Status code 404 is not ok: Image not found.' });

afterEach(() => vi.restoreAllMocks());

describe('VercelSandboxProvider with an image', () => {
  it('creates VMs from the image with its tags next to the app tags', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.spyOn(Sandbox, 'getOrCreate').mockImplementation((async (p: Record<string, unknown>) => {
      calls.push(p);
      return fakeSandbox();
    }) as never);
    const provider = new VercelSandboxProvider({ image: 'harness-host:v1', imageTags: { hostImage: 'v1' } });
    await provider.open('wrun_a');
    expect(calls[0]).toMatchObject({ image: 'harness-host:v1', tags: { app: 'harness-on-world', lane: 'sandbox', hostImage: 'v1' } });
  });

  it('a missing image (404) falls back to the default image without its tags, and is asked for again after imageRetryMs', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let pushed = false;
    vi.spyOn(Sandbox, 'getOrCreate').mockImplementation((async (p: Record<string, unknown>) => {
      calls.push(p);
      if (p.image && !pushed) throw notFound();
      return fakeSandbox();
    }) as never);
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const provider = new VercelSandboxProvider({ image: 'harness-host:v1', imageTags: { hostImage: 'v1' }, imageRetryMs: 60_000 });
    await provider.open('wrun_a');
    await provider.open('wrun_b');
    expect(calls.map((c) => c.image)).toEqual(['harness-host:v1', undefined, undefined]);
    expect((calls[1]!.tags as Record<string, string>).hostImage).toBeUndefined();
    // Pushed after the deployment went live: a warm process picks it up once the retry window passes.
    pushed = true;
    now += 60_001;
    await provider.open('wrun_c');
    expect(calls.at(-1)).toMatchObject({ image: 'harness-host:v1', tags: { hostImage: 'v1' } });
  });

  it('a zero retry window still makes one fallback create, not a loop', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Sandbox, 'getOrCreate').mockImplementation((async (p: Record<string, unknown>) => {
      calls.push(p);
      if (p.image) throw notFound();
      return fakeSandbox();
    }) as never);
    await new VercelSandboxProvider({ image: 'harness-host:v1', imageRetryMs: 0 }).open('wrun_a');
    expect(calls.map((c) => c.image)).toEqual(['harness-host:v1', undefined]);
  });

  it('warms the image\'s files in the background on connect, only for VMs from the image', async () => {
    const commands: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let missing = false;
    vi.spyOn(Sandbox, 'getOrCreate').mockImplementation((async (p: Record<string, unknown>) => {
      if (p.image && missing) throw notFound();
      return fakeSandbox(commands);
    }) as never);
    const opts = { image: 'harness-host:v1', imageTags: { hostImage: 'v1' }, imagePrefetch: ['/opt/harness-image', '/usr/local/bin/node'] };
    await new VercelSandboxProvider(opts).open('wrun_a');
    expect(commands[0]).toContain(`(find '/opt/harness-image' '/usr/local/bin/node' -type f -exec cat {} + >/dev/null 2>&1 </dev/null &) ; sudo mkdir -p '/workspace'`);
    missing = true;
    await new VercelSandboxProvider(opts).open('wrun_b');
    expect(commands[1]).not.toContain('find');
  });

  it('the prefetch does not hold the command open', () => {
    const t = Date.now();
    const r = spawnSync('bash', ['-c', `${prefetchScript([process.execPath])}echo done`], { encoding: 'utf8', timeout: 5000 });
    expect(r.stdout).toBe('done\n');
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('other errors are not taken for a missing image', async () => {
    expect(isImageNotFound(notFound())).toBe(true);
    expect(isImageNotFound(new APIError(new Response('{}', { status: 404 }), { message: 'Status code 404 is not ok: Sandbox not found' }))).toBe(false);
    expect(isImageNotFound(new APIError(new Response('{}', { status: 500 }), { message: 'image' }))).toBe(false);
    expect(isImageNotFound(new Error('Image not found'))).toBe(false);
  });
});
