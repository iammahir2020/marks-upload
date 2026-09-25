// A scan that could not read everything, in a real browser at the
// narrowest phone width this app supports: the partial-scan banner and the
// failure banner, each with a Save photo that really downloads the capture.
// jsdom renders no layout and performs no downloads, so neither the "do
// three pill buttons fit at 320px" question nor the download itself can be
// answered there.
import { expect, test, type Page } from '@playwright/test';
import { captureOne, createSectionAndQuiz, mockBackend, SHOTS, skipLanding } from './helpers';

test.use({ viewport: { width: 320, height: 720 } });

test.beforeEach(async ({ page }) => {
  await skipLanding(page);
});

const partial = {
  status: 'ok',
  failure_reason: null,
  student_id: null,
  serial: '07',
  questions: [
    { q: 1, value: 4 },
    { q: 2, value: 3 },
  ],
  total: { q: 0, value: 7 },
  low_confidence_fields: ['student_id'],
  unmatched_fields: [],
  crossed_out_fields: [],
  suggestions: {},
  table_mismatches: [{ table: 'id', found: 7, expected: 8 }],
};

const failed = {
  status: 'failed',
  failure_reason: 'column_count_mismatch',
  student_id: null,
  serial: null,
  questions: [],
  total: null,
  low_confidence_fields: [],
  unmatched_fields: [],
};

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectSavedPhoto(page: Page, name: RegExp) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Save photo' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(name);
  // The capture itself, not an empty file: a JPEG starts FF D8.
  const path = await download.path();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path);
  expect(bytes.length).toBeGreaterThan(1000);
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
}

test('a partial scan names the unread table, keeps the rest, and saves the photo', async ({ page }) => {
  await mockBackend(page, partial);
  await createSectionAndQuiz(page, { serialBox: true });
  await captureOne(page);

  const banner = page.getByRole('status').filter({ hasText: 'couldn’t be read' });
  await expect(banner).toContainText('Student ID row: found 6 digit boxes, expected 7.');
  await expect(page.getByLabel('Serial', { exact: true })).toHaveValue('07');
  // A role, not the label: the landing page's hidden illustration (still in
  // the DOM) has an aria-label that mentions "a student ID row" too.
  await expect(page.getByRole('textbox', { name: 'Student ID' })).toHaveValue('');
  await expectNoSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/partial-320.png`, fullPage: true });

  await expectSavedPhoto(page, /^scan-partial-[\d-]+\.jpg$/);
});

test('a tie offers both readings inside a narrow mark field without overflowing', async ({ page }) => {
  await mockBackend(page, {
    ...partial,
    student_id: '1912345',
    low_confidence_fields: ['q1', 'total'],
    unmatched_fields: ['q1', 'total'],
    questions: [
      { q: 1, value: null },
      { q: 2, value: 3 },
    ],
    total: { q: 0, value: null },
    table_mismatches: [],
    // The widest pair the field could meet: a 4.5rem box holding "Use 10.5".
    choices: { q1: ['1.5', '10.5'], total: ['4.5', '13.5'] },
  });
  // Review lays out whatever choices arrive; this is about fit, not legality.
  await createSectionAndQuiz(page, { serialBox: true });
  await captureOne(page);

  for (const name of ['Use 1.5', 'Use 10.5', 'Use 4.5', 'Use 13.5']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    const field = (await button.locator('xpath=ancestor::*[contains(@class,"field")][1]').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(field.x + field.width + 1);
  }
  await expect(page.getByText(/two readings are offered/i)).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/tie-320.png`, fullPage: true });
});

test('a failed scan offers Save photo beside Retake and Enter manually', async ({ page }) => {
  await mockBackend(page, failed);
  await createSectionAndQuiz(page, { serialBox: true });
  await captureOne(page, /Enter manually/);

  const banner = page.getByRole('alert').filter({ hasText: 'Scan failed' });
  for (const name of ['Retake', 'Enter manually']) {
    await expect(banner.getByRole('button', { name })).toBeVisible();
  }
  await expect(banner.getByRole('link', { name: 'Save photo' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/failed-320.png`, fullPage: true });

  await expectSavedPhoto(page, /^scan-column_count_mismatch-[\d-]+\.jpg$/);
});
