// step.md 14.4/14.6 (plan.md §19) — the two small pieces of the landing
// page's entry/exit that still need to run as real JS, now that 14.6 has
// moved the FIRST-paint decision (first-time visitor vs. returning
// instructor) out of React entirely and into the static shell that
// `scripts/prerender-landing.mjs` builds at `npm run build` time.
//
// `LANDING_SEEN_KEY` is re-exported by `prerenderEntry.tsx` and embedded,
// unchanged, into that shell's own inline bootstrap script — see
// prerender.test.ts's drift guard — so there is exactly one definition of
// which localStorage key means "has seen the landing page", even though
// it now gets READ in two different places (Node, at build time producing
// the shell's script text; and that script itself, in the browser, before
// the React bundle exists to run any TypeScript at all).
//
// Phase A's `hasSeenLanding`/`markLandingSeen` functions are retired:
// nothing calls them any more. The check they performed is now the
// bootstrap script's job, written as plain JS because it must run before
// there is a bundle to import this module from.
export const LANDING_SEEN_KEY = 'msLandingSeen';

// The class the bootstrap script adds to <html> once "Open the app" has
// been tapped (this visit, or a stored earlier one). Its CSS half lives
// at the bottom of landing.css under the same literal name — a `<style>`
// block can't import a TS constant, so landing.test.ts pins the two
// copies together instead.
export const APP_VISIBLE_CLASS = 'ms-app-visible';

// step.md 14.4 — Library's "Read the full story" link back to the
// landing page. There is no client-rendered <Landing> to switch back to
// any more (14.6 retired that): the exact static markup the shell showed
// on first visit is still sitting in the DOM the whole time, merely
// hidden by this class. Going back is that same hide undone.
export function showLandingOverlay(): void {
  document.documentElement.classList.remove(APP_VISIBLE_CLASS);
}
