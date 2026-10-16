import { afterEach, describe, expect, it, vi } from 'vitest';

const oidc = vi.hoisted(() => ({ token: '' }));
vi.mock('@vercel/oidc', () => ({ getVercelOidcToken: async () => oidc.token }));
const { agentRunsLink } = await import('./agent-runs-link');

const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const env = process.env.VERCEL_ENV;
afterEach(() => {
  if (env === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = env;
});

describe('agentRunsLink', () => {
  it("names the project's Agent Runs page from the OIDC token's owner and project, and VERCEL_ENV", async () => {
    oidc.token = jwt({ owner: 'acme', project: 'my-agent', environment: 'production' });
    process.env.VERCEL_ENV = 'production';
    expect(await agentRunsLink()).toEqual({ base: 'https://vercel.com/acme/my-agent/observability/agent-runs', environment: 'production' });
    process.env.VERCEL_ENV = 'preview';
    expect((await agentRunsLink())?.environment).toBe('preview');
  });
  it('is undefined off Vercel, in development, and without a usable token', async () => {
    oidc.token = jwt({ owner: 'acme', project: 'my-agent' });
    delete process.env.VERCEL_ENV;
    expect(await agentRunsLink()).toBeUndefined();
    process.env.VERCEL_ENV = 'development';
    expect(await agentRunsLink()).toBeUndefined();
    process.env.VERCEL_ENV = 'production';
    oidc.token = 'not a jwt';
    expect(await agentRunsLink()).toBeUndefined();
    oidc.token = jwt({ owner: 'acme/../x', project: 'my-agent' });
    expect(await agentRunsLink()).toBeUndefined();
    oidc.token = jwt({ project: 'my-agent' });
    expect(await agentRunsLink()).toBeUndefined();
  });
});
