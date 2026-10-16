import type { ClientLoaders, RawClientLoaders } from 'harness-world-demo-ui';
import * as server from './server.ts';

/**
 * One module per brain. Server is plain fetch and ships in the first chunk;
 * the in-tab World (IndexedDB, Pi, fx, just-bash) and the hybrid client
 * load only when their brain is chosen, or prefetch on hover.
 */
export const loaders: ClientLoaders = {
  server: async () => server,
  tab: () => import('./tab.ts'),
  hybrid: () => import('./hybrid.ts'),
};

/** Durability off: the same harnesses with no World, in a Function or in this tab. */
export const rawLoaders: RawClientLoaders = {
  server: () => import('./raw-server.ts'),
  tab: () => import('./raw-tab.ts'),
};

/** The native baseline: plain Pi / fx on a Fluid Function, none of the durability code (`/api/native`). */
export const nativeLoader = () => import('./native.ts');

/** eve on Vercel Workflow (`/eve/v1`, the agent in apps/demo/agent): a `/compare` column. */
export const eveLoader = () => import('./eve.ts');

/** Native per brain on the main page: the Function, or this tab. Not Hybrid: moving lanes needs a log. */
export const nativeLoaders: RawClientLoaders = {
  server: nativeLoader,
  tab: () => import('./native-tab.ts'),
};

/** "Pi (pi-durable)": Pi 1.0's own durable Harness on the server's World (`/api/pi-durable`, apps/demo lib/pi-durable.ts). */
export const piDurableLoader = () => import('./pi-durable.ts');
/** "fx (libfx durable)": libfx's own durable sessions on the server's World (`/api/fx-durable`, apps/demo lib/fx-durable.ts). */
export const fxDurableLoader = () => import('./fx-durable.ts');
