import { Sandbox } from '@vercel/sandbox';
import { describe, expect, it } from 'vitest';
import { callbackPolicy, X_VERCEL_KEY } from './sandbox.ts';

/**
 * The push callback's network policy. The deny rules are what keep the VM
 * from minting a bypass cookie, so they must be both valid (the Sandbox API
 * rejects the whole policy otherwise, and every connect fails) and in force.
 */

const callback = { url: 'https://app.example/api/hybrid/sandbox-result', secret: 's', bypass: 'b' };

describe('callbackPolicy', () => {
  it('uses a regex dialect the Sandbox API accepts (no inline flags) that denies x-vercel-* in any case', () => {
    const policy = callbackPolicy(callback) as unknown as { allow: Record<string, { match: { headers?: { key: { regex: string } }[]; queryString?: { key: { regex: string } }[] } }[]> };
    const rules = policy.allow['app.example']!;
    const regexes = rules.flatMap((r) => [...(r.match.headers ?? []), ...(r.match.queryString ?? [])].map((m) => m.key.regex));
    expect(regexes).toEqual([X_VERCEL_KEY, X_VERCEL_KEY]);
    for (const re of regexes) {
      // `(?i)` and friends are what the API refused with a 400.
      expect(re).not.toMatch(/\(\?/);
      const r = new RegExp(re);
      for (const key of ['x-vercel-set-bypass-cookie', 'X-Vercel-Set-Bypass-Cookie', 'X-VERCEL-PROTECTION-BYPASS', 'x-VeRcEl-anything']) {
        expect(r.test(key)).toBe(true);
      }
      for (const key of ['authorization', 'content-type', 'xx-vercel-a', 'x-vercelx']) expect(r.test(key)).toBe(false);
    }
    // The deny rules come before the injecting rule: first match wins.
    // The callback alone (the retired brain-in-VM lane's app routes are gone): scoped, never all of the host.
    expect(rules.map((r) => ('response' in r ? 'deny' : 'inject'))).toEqual(['deny', 'deny', 'inject']);
    expect(rules.slice(2).map((r) => (r.match as { path?: { exact: string } }).path?.exact)).toEqual(['/api/hybrid/sandbox-result']);
  });
});

/**
 * Against the real Sandbox API. Opt in with `HYBRID_LIVE_SANDBOX=1` and
 * credentials the SDK can read (`VERCEL_OIDC_TOKEN`, e.g. from `vercel env
 * pull` in apps/demo). Uses httpbin's echo as a stand-in for the app.
 */
describe.runIf(process.env.HYBRID_LIVE_SANDBOX === '1')('callbackPolicy on a live sandbox', () => {
  it('is accepted, injects the bypass only on POST to the one path, denies x-vercel-* controls, and never shows the VM the secret', { timeout: 180_000 }, async () => {
    const bypass = `bypass${Math.random().toString(36).slice(2)}`;
    const url = 'https://httpbin.org/anything/harness-cb';
    const sandbox = await Sandbox.create({ networkPolicy: callbackPolicy({ url, secret: 's', bypass }), timeout: 120_000 } as Parameters<typeof Sandbox.create>[0]);
    try {
      const sh = async (script: string) => {
        const r = await sandbox.runCommand({ cmd: 'bash', args: ['-c', script] });
        return (await r.stdout()).trim();
      };
      const code = (args: string) => sh(`curl -s -o /dev/null -w '%{http_code}' ${args}`);
      expect(await code(`-X POST -H 'X-Vercel-Set-Bypass-Cookie: true' ${url}`)).toBe('403');
      expect(await code(`-X POST -H 'x-VERCEL-protection-bypass: mine' ${url}`)).toBe('403');
      expect(await code(`-X POST '${url}?x-vercel-set-bypass-cookie=true'`)).toBe('403');
      expect(await code(`-X POST '${url}?X-Vercel-Protection-Bypass=1'`)).toBe('403');
      const posted = await sh(`curl -s -X POST ${url}`);
      expect(posted).toContain(bypass);
      const got = await sh(`curl -s ${url}`);
      expect(got).not.toContain(bypass);
      const elsewhere = await sh(`curl -s -X POST https://httpbin.org/anything/other`);
      expect(elsewhere).not.toContain(bypass);
      expect(await sh(`env | grep -c ${bypass} || true`)).toBe('0');
    } finally {
      await sandbox.stop().catch(() => {});
    }
  });
});
