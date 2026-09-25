// Real-browser tests (e2e/), alongside Vitest's jsdom ones (src/**/*.test.*).
// jsdom renders no layout and has no camera, so anything that depends on
// either — how a screen actually looks at phone width, the capture flow —
// is checked here instead. Run with `npm run test:e2e`; first-time setup on
// a new machine is `npx playwright install chromium`.
//
// The backend is NOT started: each test mocks POST /api/scan with
// page.route, so these check the frontend alone and need no Python, no
// model and no network. The real recognizer is covered by the backend's
// own suite.
import { defineConfig, devices } from '@playwright/test';

const PORT = 5199;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `https://localhost:${PORT}`,
    // vite.config.ts serves a self-signed cert (@vitejs/plugin-basic-ssl).
    ignoreHTTPSErrors: true,
    // The dev server registers a service worker (vite-plugin-pwa's
    // devOptions). A request the service worker handles never reaches
    // page.route, so the API mocks would silently stop applying.
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    launchOptions: {
      // A fake camera, so Scan.tsx's getUserMedia succeeds and Capture
      // produces a real (synthetic) frame to upload.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  projects: [
    // Phone first, matching how the app is actually used.
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `https://localhost:${PORT}`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    // Same-origin API calls (`/api/scan`), which page.route intercepts
    // without depending on the LAN-IP:8000 default api.ts falls back to.
    env: { VITE_API_BASE: '' },
  },
});
