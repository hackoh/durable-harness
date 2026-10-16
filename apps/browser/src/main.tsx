// Page flags are read before the page rewrites its URL (see flags.ts).
import './flags.ts';
import { Compare, Shell } from 'harness-world-demo-ui';
import 'harness-world-demo-ui/styles.css';
import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { eveLoader, fxDurableLoader, loaders, nativeLoader, nativeLoaders, piDurableLoader, rawLoaders } from './clients/index.ts';
import { tabGateway } from './direct.ts';
import { MODEL } from './model.ts';

// `/bench` (or `/?bench=1`): the latency benchmark, in its own chunk.
const path = location.pathname.replace(/\/+$/, '');
const isBench = path === '/bench' || new URLSearchParams(location.search).has('bench');
// `/compare` (or `/?compare=1`): what durability costs a harness: the same prompt to 2-4 columns at once.
const isCompare = path === '/compare' || new URLSearchParams(location.search).has('compare');
const BenchPage = lazy(() => import('./bench/BenchPage.tsx').then((m) => ({ default: m.BenchPage })));

// The page's route to AI Gateway (the server's proxy), made once.
tabGateway();

createRoot(document.getElementById('root')!).render(
  isBench ? (
    <Suspense fallback={null}>
      <BenchPage />
    </Suspense>
  ) : isCompare ? (
    <Compare loaders={loaders} rawLoaders={rawLoaders} nativeLoader={nativeLoader} nativeTabLoader={nativeLoaders.tab} eveLoader={eveLoader} fxDurableLoader={fxDurableLoader} piDurableLoader={piDurableLoader} model={MODEL} />
  ) : (
    <Shell loaders={loaders} rawLoaders={rawLoaders} nativeLoaders={nativeLoaders} piDurableLoader={piDurableLoader} fxDurableLoader={fxDurableLoader} model={MODEL} />
  )
);
