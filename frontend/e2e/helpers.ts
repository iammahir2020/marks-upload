// Shared by the e2e specs: a mocked backend and the create-section ->
// create-quiz -> capture steps every flow starts with.
import { expect, type Page, type Request } from '@playwright/test';

export const SHOTS = 'test-results/screens';

// Mocks the backend and records the `config` form field of every scan.
export async function mockBackend(page: Page, result: object): Promise<string[]> {
  const configs: string[] = [];
  await page.route('**/api/scan', async (route) => {
    configs.push(configField(route.request()));
    await route.fulfill({ json: result });
  });
  await page.route('**/api/harvest', (route) => route.fulfill({ json: { harvested: false } }));
  return configs;
}

function configField(request: Request): string {
  const body = request.postDataBuffer()?.toString('utf8') ?? '';
  const match = body.match(/name="config"\r\n\r\n([^\r]*)/);
  return match ? match[1] : '';
}

export async function createSectionAndQuiz(page: Page, { serialBox }: { serialBox: boolean }) {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New section' }).first().click();
  await page.getByLabel('Course code').fill('CSE211L');
  await page.getByLabel('Section', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Autumn' }).click();
  await page.getByLabel('Semester year').fill('2026');
  await expect(page.getByLabel(/student id digits/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Create section' }).click();

  await page.getByRole('button', { name: '+ New assessment' }).click();
  await page.getByLabel('Quiz name').fill('Quiz 1');
  await page.getByLabel('Number of questions').fill('2');
  const toggle = page.getByRole('checkbox', { name: 'Serial box on paper' });
  await expect(toggle).toBeChecked();
  if (!serialBox) {
    await toggle.uncheck();
    await expect(page.getByText(/nothing can catch a misread/)).toBeVisible();
  }
  return toggle;
}

// Starts scanning and captures one photo, waiting for Review to open.
// `ready` is what Review shows once it is up — Confirm on a normal scan.
export async function captureOne(page: Page, ready = /Confirm & next/) {
  await page.getByRole('button', { name: /start scanning/i }).click();
  const capture = page.getByRole('button', { name: 'Capture' });
  await expect(capture).toBeEnabled({ timeout: 15_000 });
  // Scan.tsx's capture() silently returns while the video has no frame yet
  // (videoWidth === 0). A person never taps that fast; a test does.
  await page.waitForFunction(() => (document.querySelector('video')?.videoWidth ?? 0) > 0);
  await capture.click();
  await expect(page.getByRole('button', { name: ready })).toBeVisible({ timeout: 15_000 });
}

// Skip the landing page: the static shell shows it until this is set.
export async function skipLanding(page: Page) {
  await page.addInitScript(() => localStorage.setItem('msLandingSeen', '1'));
}
