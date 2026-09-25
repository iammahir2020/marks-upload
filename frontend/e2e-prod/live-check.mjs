// issues.md N43 — a one-off check of the LIVE site after a deploy: the served
// page carries its CSP <meta>, and the landing page, service worker and app
// shell run with zero CSP violations. Reads nothing private and sends no scans.
//
//   node e2e-prod/live-check.mjs [url]
import { chromium, devices } from '@playwright/test';

const url = process.argv[2] ?? 'https://d2n2meq17rr1oi.cloudfront.net/';
const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['Pixel 7'] });
const page = await context.newPage();
const blocked = [];
page.on('console', (msg) => {
  if (/Content[- ]Security[- ]Policy/i.test(msg.text())) blocked.push(msg.text());
});
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (e) => {
    console.error(`Content-Security-Policy: ${e.violatedDirective} blocked ${e.blockedURI || '(inline)'}`);
  });
});

await page.goto(url, { waitUntil: 'networkidle' });
const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
await page.locator('#landing-root').waitFor({ state: 'visible' });
await page.locator('[data-open-app]').first().click();
await page.getByRole('button', { name: '+ New section' }).first().waitFor();
await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length > 0, null,
  { timeout: 20_000 });

console.log(`CSP meta present: ${Boolean(csp)}  (${csp?.slice(0, 60)}...)`);
console.log(`landing -> app shell -> service worker: OK`);
console.log(`CSP violations: ${blocked.length}`);
for (const b of blocked) console.log(`  ${b}`);
await browser.close();
process.exit(blocked.length || !csp ? 1 : 0);
