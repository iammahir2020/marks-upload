// issues.md N43 — the production page's Content-Security-Policy must block
// nothing the app itself does. Every CSP violation the browser reports is
// collected, from before the first byte of the page runs, and any at all
// fails the test: a policy that breaks the landing page, the camera, the
// harvest upload or the Excel export would be worse than no policy.
import { expect, test, type Page } from '@playwright/test';
import { captureOne, createSectionAndQuiz, mockBackend, skipLanding } from '../e2e/helpers';

async function recordViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'}`);
    });
  });
  const console: string[] = [];
  page.on('console', (msg) => {
    if (/Content[- ]Security[- ]Policy/i.test(msg.text())) console.push(msg.text());
  });
  return async () => [
    ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])),
    ...console,
  ];
}

test('the built page carries the policy', async ({ page }) => {
  await page.goto('/');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self' 'sha256-");
  expect(csp).toContain("object-src 'none'");
});

test('the landing page, its bootstrap script and the service worker run under the policy', async ({ page }) => {
  const violations = await recordViolations(page);
  await page.goto('/');
  await expect(page.locator('#landing-root')).toBeVisible();
  await page.locator('[data-open-app]').first().click();
  await expect(page.getByRole('button', { name: '+ New section' }).first()).toBeVisible();
  // The service worker is allowed here (worker-src 'self'); give it a moment.
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length > 0, null,
    { timeout: 15_000 });
  expect(await violations()).toEqual([]);
});

test.describe('the whole grading loop', () => {
  // A service worker would take /api/* requests out of page.route's reach.
  test.use({ serviceWorkers: 'block' });

  test('scan, confirm (with its blob: harvest), results and Excel export — nothing blocked', async ({ page }) => {
    const violations = await recordViolations(page);
    await skipLanding(page);
    await mockBackend(page, {
      status: 'ok', failure_reason: null, student_id: '1912345', serial: '07',
      questions: [{ q: 1, value: 4 }, { q: 2, value: 3 }], total: { q: 0, value: 7 },
      low_confidence_fields: [], unmatched_fields: [], crossed_out_fields: [], suggestions: {},
    });
    let harvested = false;
    await page.route('**/api/harvest', (route) => {
      harvested = true;
      return route.fulfill({ json: { harvested: true } });
    });

    await createSectionAndQuiz(page, { serialBox: true });
    await captureOne(page);
    await page.getByRole('button', { name: /Confirm & next/ }).click();
    await expect.poll(() => harvested, { timeout: 10_000 }).toBe(true); // fetch(blob:) then POST
    await page.getByRole('button', { name: /View results/ }).click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download Excel' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    expect(await violations()).toEqual([]);
  });
});
