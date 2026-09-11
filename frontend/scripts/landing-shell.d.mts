// Type declarations for landing-shell.mjs, imported from both
// vite.config.ts (checked under tsconfig.node.json) and
// prerender-landing.mjs (plain Node, untyped). Kept separate from the
// .mjs file itself rather than converting it to .ts, since
// prerender-landing.mjs runs as a plain Node script with no build step of
// its own.
export function buildBootstrapScript(landingSeenKey: string, appVisibleClass: string): string;

export interface LandingShellInput {
  landingHtml: string;
  landingCss: string;
  landingSeenKey: string;
  appVisibleClass: string;
}

export function injectLandingShell(html: string, input: LandingShellInput): string;
