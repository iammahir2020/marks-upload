#!/usr/bin/env node
// step.md 14.5/14.6 (plan.md §19). Runs after `vite build` — wired into
// `npm run build` (see package.json) so there is no second command to
// forget. In order:
//
//   1. Bundle src/prerenderEntry.tsx to plain JS with Vite's own SSR
//      build. Reusing Vite here (already a devDependency, already doing
//      exactly this JSX/TS transform for the real app) is the whole
//      reason this step needs no new dependency at all — no separate
//      loader, no esbuild/babel called directly.
//   2. Import that bundle in Node and call renderLandingMarkup() —
//      react-dom/server's renderToStaticMarkup, actually running.
//   3. Inject the resulting HTML, this page's own CSS (read straight from
//      landing.css — nothing else imports that file into the app bundle
//      any more, see Landing.tsx's own comment), and a small inline
//      bootstrap script into dist/index.html, outside #root — via
//      landing-shell.mjs, the SAME injection code vite.config.ts's
//      dev-mode plugin uses, so `vite dev` and `vite build` cannot drift
//      apart on what gets injected.
//
// The bootstrap script is the ONLY runtime JS this page ships, and it is
// inline HTML text generated here, not a module Rollup bundles — so
// there is no chunk for the service worker to precache and no chunk for
// a returning instructor's visit to ever fetch.
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { buildBootstrapScript, injectLandingShell } from './landing-shell.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// Reuses Vite's own conventional SSR output name — already gitignored
// alongside dist/, so this needs no new .gitignore entry.
const ssrOutDir = path.join(root, 'dist-ssr');
// Optional CLI arg lets preflight.sh point this at an isolated build
// directory (e.g. `.preflight-dist`) instead of the real `dist/` — see
// preflight.sh's own comment on why it can no longer reach `vite build`'s
// `--outDir` through `npm run build -- --outDir ...`: this script is now
// the LAST command in that chain, so npm appends trailing args to IT, not
// to `vite build`. `npm run build` itself (no args) is unaffected —
// unset defaults to 'dist', same as before this arg existed.
const distDir = process.argv[2] ?? 'dist';
const distIndexPath = path.join(root, distDir, 'index.html');

async function bundleEntry() {
  await build({
    root,
    configFile: false,
    plugins: [react()],
    logLevel: 'warn',
    build: {
      ssr: 'src/prerenderEntry.tsx',
      outDir: path.relative(root, ssrOutDir),
      emptyOutDir: true,
      rollupOptions: { output: { format: 'es', entryFileNames: 'entry.mjs' } },
    },
  });
  return pathToFileURL(path.join(ssrOutDir, 'entry.mjs')).href;
}

async function main() {
  const entryUrl = await bundleEntry();
  const { renderLandingMarkup, LANDING_SEEN_KEY, APP_VISIBLE_CLASS } = await import(entryUrl);

  const landingHtml = renderLandingMarkup();
  const landingCss = await readFile(path.join(root, 'src', 'landing.css'), 'utf8');

  const rawHtml = await readFile(distIndexPath, 'utf8');
  const html = injectLandingShell(rawHtml, {
    landingHtml,
    landingCss,
    landingSeenKey: LANDING_SEEN_KEY,
    appVisibleClass: APP_VISIBLE_CLASS,
  });

  if (!html.includes('id="landing-root"') || !html.includes('id="lp-bootstrap"') || !html.includes('id="lp-critical-css"')) {
    throw new Error(`prerender-landing: injection into ${distDir}/index.html failed`);
  }

  await writeFile(distIndexPath, html, 'utf8');
  await rm(ssrOutDir, { recursive: true, force: true });

  const { gzipSync } = await import('node:zlib');
  const bootstrapScript = buildBootstrapScript(LANDING_SEEN_KEY, APP_VISIBLE_CLASS);
  const firstPaintBytes = landingHtml + landingCss + bootstrapScript;
  const gzipBytes = gzipSync(Buffer.from(firstPaintBytes, 'utf8')).length;
  console.log(
    `prerender-landing: injected ${landingHtml.length}B markup + ${landingCss.length}B CSS into ${distDir}/index.html ` +
      `(~${gzipBytes}B gzip for the added first-paint content, budget ~10240B — plan.md §19)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
