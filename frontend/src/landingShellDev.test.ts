// step.md 14.9 — this is the test written as the failure: before this
// fix, `vite dev` (and therefore `./dev.sh`, the everyday workflow) never
// served the landing page's static shell at all. `prerender.test.ts`
// already guards the BUILD output; nothing guarded dev mode, which is
// exactly why the gap went unnoticed until real use found it. Drives the
// actual plugin through a real Vite dev server in middleware mode (no
// port bound, no network) rather than trusting the wiring by inspection.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { landingShellDevPlugin } from '../vite.config';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawIndexHtml = readFileSync(path.join(root, 'index.html'), 'utf8');

let server: ViteDevServer;

beforeAll(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [react(), landingShellDevPlugin()],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
});

afterAll(async () => {
  await server.close();
}, 20_000);

describe('the dev server injects the same landing shell the build does (step.md 14.9)', () => {
  it('serves the static markup, critical CSS, and bootstrap script — not the bare index.html', async () => {
    const html = await server.transformIndexHtml('/', rawIndexHtml);

    expect(html).toContain('id="landing-root"');
    expect(html).toContain('You already graded it');
    expect(html).toContain('id="lp-critical-css"');
    expect(html).toContain('id="lp-bootstrap"');
    expect(html).toContain('data-open-app');
  });

  it('carries all five scan-animation states too, same as the built output', async () => {
    const html = await server.transformIndexHtml('/', rawIndexHtml);
    for (let i = 1; i <= 5; i++) {
      expect(html).toContain(`scan-state-${i}`);
    }
  });
});
