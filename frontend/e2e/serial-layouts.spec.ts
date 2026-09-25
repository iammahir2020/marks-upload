// Step 16 (plan.md §21) in a real browser: the full create-section ->
// create-quiz -> capture -> review -> results flow, once per paper layout.
//
// The layout A test is the one guarding the hard rule for step 16 — the
// existing flow must not change — so it also asserts that a Serial-box
// quiz's scan request carries NO hasSerial field at all, exactly as before.
//
// Screenshots land in test-results/screens/ for looking at, not diffing.
import { expect, test } from '@playwright/test';
import { captureOne, createSectionAndQuiz, mockBackend, SHOTS, skipLanding } from './helpers';

function scanResult(serial: string | null) {
  return {
    status: 'ok',
    failure_reason: null,
    student_id: '1912345',
    serial,
    questions: [
      { q: 1, value: 4 },
      { q: 2, value: 3 },
    ],
    total: { q: 0, value: 7 },
    low_confidence_fields: [],
    unmatched_fields: [],
    crossed_out_fields: [],
    suggestions: {},
  };
}

test.beforeEach(async ({ page }) => {
  await skipLanding(page);
});

test('layout B: no Serial box, end to end', async ({ page }) => {
  const configs = await mockBackend(page, scanResult(null));

  await createSectionAndQuiz(page, { serialBox: false });
  await page.screenshot({ path: `${SHOTS}/b-1-quiz-form.png`, fullPage: true });

  await captureOne(page);
  expect(JSON.parse(configs[0])).toMatchObject({ hasSerial: false, idDigits: 7 });

  await expect(page.getByText('Student ID', { exact: true })).toBeVisible();
  // A field, not the word: the landing page's hidden static markup (its
  // scan animation draws a SERIAL row) stays in the DOM the whole visit.
  await expect(page.getByLabel('Serial', { exact: true })).toHaveCount(0);
  // Found by this test: Scan's queue line (behind the Review overlay) used
  // to say "Serial ?" on every capture, as if each were a failed read.
  await expect(page.getByText('ID 1912345 · Total 7')).toBeAttached();
  await page.screenshot({ path: `${SHOTS}/b-2-review.png`, fullPage: true });

  await page.getByRole('button', { name: /Confirm & next/ }).click();
  await expect(page.getByRole('heading', { name: /Scanned 1/ })).toBeVisible();

  await page.getByRole('button', { name: /View results/ }).click();
  await expect(page.getByRole('columnheader', { name: 'Student ID' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Serial' })).toHaveCount(0);
  // No class list on this section, so nothing verified the ID.
  await expect(page.locator('.badge', { hasText: 'no list' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/b-3-results.png`, fullPage: true });
});

test('layout A: the existing flow is unchanged', async ({ page }) => {
  const configs = await mockBackend(page, scanResult('07'));

  await createSectionAndQuiz(page, { serialBox: true });
  await captureOne(page);

  // The request a Serial-box quiz sends is exactly what it was before
  // step 16: no hasSerial key at all.
  expect(configs[0]).not.toContain('hasSerial');

  await expect(page.getByLabel('Serial', { exact: true })).toHaveValue('07');
  await expect(page.getByText('ID 1912345 · Serial 07 · Total 7')).toBeAttached();
  await page.screenshot({ path: `${SHOTS}/a-1-review.png`, fullPage: true });

  await page.getByRole('button', { name: /Confirm & next/ }).click();
  await page.getByRole('button', { name: /View results/ }).click();
  await expect(page.getByRole('columnheader', { name: 'Serial' })).toBeVisible();
});

test('a new quiz starts from the section’s last layout', async ({ page }) => {
  await mockBackend(page, scanResult(null));
  await createSectionAndQuiz(page, { serialBox: false });
  await page.getByRole('button', { name: /start scanning/i }).click();
  await page.getByRole('button', { name: 'All sections' }).click();

  await page.getByRole('button', { name: '+ New assessment' }).click();
  await expect(page.getByRole('checkbox', { name: 'Serial box on paper' })).not.toBeChecked();
});

test('dark theme renders the new form and warning legibly', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await createSectionAndQuiz(page, { serialBox: false });
  await page.screenshot({ path: `${SHOTS}/b-1-quiz-form-dark.png`, fullPage: true });
});
