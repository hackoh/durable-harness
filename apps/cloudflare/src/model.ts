/**
 * The model every harness here uses, through AI Gateway, and its
 * credential: `AI_GATEWAY_API_KEY`, else a Vercel OIDC token
 * (`VERCEL_OIDC_TOKEN`). Locally they come from `.dev.vars` (gitignored);
 * deployed, from `wrangler secret put`. Read per call: a token rotates.
 */
const env = (name: string): string | undefined => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];

export const MODEL = env('HARNESS_MODEL') ?? 'anthropic/claude-haiku-4.5';

export const INSTRUCTIONS = `You are a coding agent working in a sandboxed workspace at /workspace.
Use the tools to inspect and change files, and run commands with bash.
Keep answers short. Your session is durable: it can be interrupted and resumed at any point.`;

export function gatewayCredential(): { token: string; method: 'api-key' | 'oidc' } {
  const apiKey = env('AI_GATEWAY_API_KEY');
  if (apiKey) return { token: apiKey, method: 'api-key' };
  const oidc = env('VERCEL_OIDC_TOKEN');
  if (oidc) return { token: oidc, method: 'oidc' };
  throw new Error('No AI Gateway credential: set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN (.dev.vars locally, a secret deployed)');
}

export const gatewayKey = (): string => gatewayCredential().token;

/** How long the unsafe tools wait for their simulated confirmation (the crash window). */
export const CONFIRM_MS = Number(env('HARNESS_CONFIRM_MS') ?? 3000);
