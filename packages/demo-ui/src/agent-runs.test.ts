import { describe, expect, it } from 'vitest';
import { agentRunsUrl } from './view.ts';

describe('agentRunsUrl', () => {
  it("is the session's page in Agent Runs, with the deployment's environment", () => {
    const link = { base: 'https://vercel.com/acme/my-agent/observability/agent-runs', environment: 'preview' };
    expect(agentRunsUrl(link, 'wrun_01K2ABCDEF')).toBe('https://vercel.com/acme/my-agent/observability/agent-runs/wrun_01K2ABCDEF?environment=preview');
  });
});
