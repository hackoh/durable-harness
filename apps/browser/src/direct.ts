import { type GatewayFetch, gatewayFetch } from 'harness-world-hybrid/gateway';
import { runTokens } from './run-tokens.ts';

/**
 * This tab's route to AI Gateway: the server's `/api/gateway` proxy, which
 * adds the credential (the tab holds none: the project OIDC token that
 * `/api/token` used to hand out is not given to a browser), checks each
 * call's body, and keeps each session's budget. Every call carries the
 * token of the session being driven (`run-tokens.ts`), or of this page's
 * own run for a tab mode whose sessions are not on the server.
 */

let shared: GatewayFetch | undefined;

export function tabGateway(): GatewayFetch {
  if (shared) return shared;
  const tokens = runTokens(location.origin);
  let lastRoute: string | undefined;
  shared = gatewayFetch({
    proxyBase: `${location.origin}/api/gateway`,
    mode: 'proxy',
    proxyHeaders: () => tokens.headers(),
    onRoute: ({ route, reason }) => {
      if (route === lastRoute) return;
      lastRoute = route;
      console.log('[gateway] model requests go through /api/gateway', reason ?? '');
    },
  });
  return shared;
}
