// issues.md N43 — real-browser checks against the PRODUCTION build, the only
// build that carries the Content-Security-Policy (scripts/csp.mjs writes it
// into dist/index.html; `vite dev` never has one). Kept apart from
// playwright.config.ts, whose dev server is the right target for everything
// else and is much faster to start.
//
//   npm run test:e2e:prod
import { defineConfig, devices } from '@playwright/test';

const PORT = 5198;

export default defineConfig({
  testDir: './e2e-prod',
  outputDir: './test-results-prod',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `https://localhost:${PORT}`,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  projects: [{ name: 'phone', use: { ...devices['Pixel 7'] } }],
  webServer: {
    // VITE_API_BASE='' so /api/* is same-origin, as it is behind CloudFront
    // — and so page.route can mock it.
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `https://localhost:${PORT}`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { VITE_API_BASE: '' },
  },
});
