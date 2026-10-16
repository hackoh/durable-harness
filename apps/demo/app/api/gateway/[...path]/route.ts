import { waitUntil } from '@vercel/functions';
import { getVercelOidcToken } from '@vercel/oidc';
import { MODEL } from '@/lib/model';
import { tokenRun } from '@/lib/run-tokens';
import { tabGateway } from '@/lib/tab-gateway';
import { getWorld } from '@/lib/world';

/** The model the tab bundle calls by default (apps/browser/src/model.ts; harness-world-hybrid's HYBRID_MODEL). */
const TAB_DEFAULT_MODEL = 'anthropic/claude-opus-5.5-fast';

export const maxDuration = 300;

const GATEWAY = 'https://ai-gateway.vercel.sh';
// fx's kernel reads the model catalog for models it has no built-in metadata
// for, and a model's `max_tokens` ends up in the request body. The tab and
// a Function must see the same catalog, or a hybrid fx session's tape would
// diverge when it changes lanes.
const ALLOWED_GET = [/^coding-agent\/v1\/models$/];

async function credential(): Promise<string | undefined> {
  return getVercelOidcToken().catch(() => process.env.AI_GATEWAY_API_KEY);
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  if (!ALLOWED_GET.some((re) => re.test(path))) return new Response('not allowed', { status: 403 });
  const token = await credential();
  if (!token) return new Response('no gateway credential', { status: 500 });
  const upstream = await fetch(`${GATEWAY}/${path}${new URL(request.url).search}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: request.signal,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

const g = globalThis as { __harnessTabGateway?: ReturnType<typeof tabGateway> };

/** The model spend each tab session may make through this proxy: `HARNESS_TAB_SESSION_USD`, default $5 (`Infinity` turns it off). */
function sessionUsd(): number {
  const raw = process.env.HARNESS_TAB_SESSION_USD;
  const usd = raw === undefined || raw === '' ? 5 : Number(raw);
  return Number.isNaN(usd) || usd < 0 ? 5 : usd;
}

/**
 * AI Gateway proxy for the browser tab's model calls: the tab runs the
 * harness (a hybrid session's tab lane, or a Tab mode); only model calls
 * come here, so the credential (the project's OIDC token) never reaches
 * the browser. Each call is a session's, by its run token, and is checked
 * against the fixed table, the body schema and the session's budget before
 * the credential is added (lib/tab-gateway.ts).
 */
export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = `/${(await params).path.join('/')}${new URL(request.url).search}`;
  g.__harnessTabGateway ??= tabGateway({
    world: getWorld,
    runOf: tokenRun,
    // The server's model, and the tab bundle's default (the same unless HARNESS_MODEL is set).
    models: { model: MODEL, smallModel: TAB_DEFAULT_MODEL },
    sessionUsd: sessionUsd(),
    credential: async () => {
      const token = await credential();
      if (!token) throw new Error('no gateway credential');
      return token;
    },
    waitUntil,
  });
  return g.__harnessTabGateway(request, path);
}
