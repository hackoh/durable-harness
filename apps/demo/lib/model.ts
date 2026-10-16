import { getVercelOidcToken } from '@vercel/oidc';

/**
 * What every lane in this app shares, durable or not: the model, the system
 * prompt and the AI Gateway credential. Kept apart from `sessions.ts` so the
 * native baseline (`/api/native`) imports none of the durable machinery.
 */

export { INSTRUCTIONS, instructionsFor, MODEL } from './prompt';

/** AI Gateway credential: the project's OIDC token, or an API key. */
export async function gatewayKey(): Promise<string> {
  try {
    return await getVercelOidcToken();
  } catch {
    const key = process.env.AI_GATEWAY_API_KEY;
    if (!key) throw new Error('No AI Gateway credential: run `vercel env pull` or set AI_GATEWAY_API_KEY');
    return key;
  }
}
