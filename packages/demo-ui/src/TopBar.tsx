import { ExternalIcon } from './bits.tsx';
import { BRAND, COMPARE_LINK_TITLE, SOURCE_LABEL, SOURCE_URL } from './copy.ts';
import { useTip } from './Tip.tsx';

/** The Vercel wordmark (masked with currentColor; the asset is the page's own, see index.html), then the product. */
export function Brand() {
  return (
    <a className="brand" href="/" aria-label={`Vercel ${BRAND}`}>
      <span className="wordmark" role="img" aria-label="Vercel" />
      <span className="brand-sep" aria-hidden="true">
        /
      </span>
      <span className="brand-name">{BRAND}</span>
    </a>
  );
}

export function TopBar() {
  const tip = useTip(COMPARE_LINK_TITLE);
  return (
    <header className="topbar">
      <Brand />
      <nav className="topbar-links" aria-label="Pages">
        <a className="source" href="/compare" {...tip.props}>
          Compare
          {tip.pop}
        </a>
        <a className="source" href={SOURCE_URL} target="_blank" rel="noreferrer">
          {SOURCE_LABEL} <ExternalIcon />
        </a>
      </nav>
    </header>
  );
}
