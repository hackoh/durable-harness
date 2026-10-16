// P0.18: does an AI Gateway response carry a cost the driver can read, so
// `sandbox({ budget })` needs no price table (docs/workspaces.md §5.5 step 6)?
// Four tiny requests with the linked project's development token: Messages and
// Responses, each streamed and not (Codex always streams). It prints the
// status, the response's header names, the `provider_metadata.gateway` cost
// fields, and for a stream which events carry them; never the token or the
// text. It creates nothing, so it needs no cleanup.
import { createRequire } from 'node:module';
import { log } from './lib.ts';

const require = createRequire(new URL('../../harness-process/package.json', import.meta.url));
// harness-process' copy of @vercel/oidc (this package has no dependency on it).
const { getVercelOidcToken } = (await import(require.resolve('@vercel/oidc'))) as { getVercelOidcToken(): Promise<string> };
const token = await getVercelOidcToken();

const COST = /"(cost|marketCost|surchargeCost|gatewayCost)"\s*:\s*"([0-9.]+)"/g;
const requests = [
  ['messages', '/v1/messages', { model: 'anthropic/claude-haiku-4.5', max_tokens: 16, messages: [{ role: 'user', content: 'Say hi' }] }],
  ['messages.stream', '/v1/messages', { model: 'anthropic/claude-haiku-4.5', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'Say hi' }] }],
  ['responses', '/v1/responses', { model: 'openai/gpt-5-mini', input: 'Say hi', max_output_tokens: 16 }],
  ['responses.stream', '/v1/responses', { model: 'openai/gpt-5-mini', input: 'Say hi', max_output_tokens: 16, stream: true }],
] as const;
for (const [key, path, body] of requests) {
  const res = await fetch(`https://ai-gateway.vercel.sh${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-api-key': token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const names: string[] = [];
  res.headers.forEach((_v, k) => names.push(k));
  log(`${key}.status`, res.status);
  log(`${key}.headers`, names.filter((n) => !/cookie|auth/i.test(n)).sort());
  log(`${key}.cost`, Object.fromEntries([...text.matchAll(COST)].map((m) => [m[1], m[2]])));
  if ('stream' in body) {
    // Each SSE event's `type`, and whether it carries the Gateway's cost: where in the stream the figure is.
    const events = text.split(/\n\n+/).filter((e) => e.includes('data:'));
    const typeOf = (e: string) => /"type"\s*:\s*"([a-z_.]+)"/.exec(e)?.[1] ?? '?';
    log(`${key}.events`, events.length);
    log(`${key}.costEvents`, events.flatMap((e, i) => (/"gatewayCost"/.test(e) ? [`${i}:${typeOf(e)}`] : [])));
    log(`${key}.lastEvent`, typeOf(events.at(-1) ?? ''));
  }
}
