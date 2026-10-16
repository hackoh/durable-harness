import { getVercelOidcToken } from '@vercel/oidc';

/** Where this deployment's sessions show in Vercel Agent Runs (agent-runs.ts sends them their traces). */
export interface AgentRunsLink {
  /** `https://vercel.com/<team>/<project>/observability/agent-runs`: a session's page is `<base>/<runId>?environment=<environment>`. */
  base: string;
  environment: 'production' | 'preview';
}

/**
 * The Agent Runs page for this deployment's sessions, or undefined where
 * there is none (off Vercel, `next dev`, `vercel dev`). The environment is
 * `VERCEL_ENV`. The team slug and project name are not system environment
 * variables; the project's OIDC token (the request's, which the server
 * already uses for the AI Gateway) names both, as its `owner` and `project`
 * claims. Nothing here verifies the token: it only picks a dashboard URL,
 * which checks access itself.
 */
export async function agentRunsLink(): Promise<AgentRunsLink | undefined> {
  const environment = process.env.VERCEL_ENV;
  if (environment !== 'production' && environment !== 'preview') return undefined;
  let claims: { owner?: unknown; project?: unknown };
  try {
    const payload = (await getVercelOidcToken()).split('.')[1];
    claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as typeof claims;
  } catch {
    return undefined;
  }
  const slug = (v: unknown) => (typeof v === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(v) ? v : undefined);
  const team = slug(claims.owner);
  const project = slug(claims.project);
  if (!team || !project) return undefined;
  return { base: `https://vercel.com/${team}/${project}/observability/agent-runs`, environment };
}
