// step.md 14.5 (plan.md §19) — the ONLY module `scripts/prerender-landing.mjs`
// imports, after bundling this file to plain JS with Vite's own SSR build
// (see that script for why: it already does JSX/TS, so no second toolchain
// is needed and no new dependency gets added). Never imported by
// `main.tsx`/`App.tsx` — this file exists purely for that one build step,
// so Landing.tsx never ships a runtime chunk of its own (14.6).
import { renderToStaticMarkup } from 'react-dom/server';
import Landing from './Landing';
import { APP_VISIBLE_CLASS, LANDING_SEEN_KEY } from './landingShell';

export function renderLandingMarkup(): string {
  // onOpenApp is never called here — renderToStaticMarkup produces plain
  // HTML, and React event handlers don't serialize into it. The static
  // markup's "Open the app" buttons work via the `data-open-app`
  // attribute and the bootstrap script's own event delegation instead.
  return renderToStaticMarkup(<Landing onOpenApp={() => {}} />);
}

// Re-exported so the Node script can embed the SAME key and class name
// into the bootstrap script's text it generates — one definition each of
// "has this visitor seen the landing page" and "the app is now showing",
// never two copies that can drift apart.
export { APP_VISIBLE_CLASS, LANDING_SEEN_KEY };
