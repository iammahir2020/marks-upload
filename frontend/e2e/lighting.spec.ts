// The live lighting hint and the Light (torch) button in a real browser
// (2026-09-25). Chromium can take its fake camera from a video file, so each
// test launches its own browser playing a small generated .y4m: an evenly lit
// page, a dark one, or one with a shadow over its left half.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { devices, expect, test, type Page, type TestInfo } from '@playwright/test';
import { createSectionAndQuiz, mockBackend, skipLanding } from './helpers';

const DIR = path.resolve('test-results', 'fake-camera');
mkdirSync(DIR, { recursive: true });

/** A 320x180 4:2:0 .y4m of a "page": paper at `paper`, grid lines at 30, and
 *  the left half multiplied by (1 - shadow). */
function fakeCamera(name: string, paper: number, shadow = 0): string {
  const W = 320;
  const H = 180;
  const y = Buffer.alloc(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let v = c % 32 === 0 || r % 24 === 0 ? 30 : paper;
      if (c < W / 2) v = Math.round(v * (1 - shadow));
      y[r * W + c] = v;
    }
  }
  const chroma = Buffer.alloc((W / 2) * (H / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma, chroma]);
  const file = path.join(DIR, `${name}.y4m`);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame, frame]));
  return file;
}

type Chromium = typeof import('@playwright/test').chromium;

/** A fresh browser whose fake camera plays `file`. Launch flags can't vary per
 *  test group within one file, so each test launches its own, with the same
 *  phone profile and settings as the rest of the suite. */
async function withCamera(chromium: Chromium, info: TestInfo, file: string, run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${file}`,
    ],
  });
  try {
    const context = await browser.newContext({
      ...devices['Pixel 7'],
      baseURL: info.project.use.baseURL,
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
    });
    await run(await context.newPage());
  } finally {
    await browser.close();
  }
}

async function openCamera(page: Page) {
  await skipLanding(page);
  await mockBackend(page, { status: 'failed', failure_reason: 'table_not_found' });
  await createSectionAndQuiz(page, { serialBox: true });
  await page.getByRole('button', { name: /start scanning/i }).click();
  await page.waitForFunction(() => (document.querySelector('video')?.videoWidth ?? 0) > 0);
}

const torchCalls = (page: Page) => page.evaluate(() => (window as unknown as { __torch: unknown[] }).__torch);

test('an evenly lit page shows no hint, and a camera without a torch shows no Light button', async ({ playwright }, info) => {
  await withCamera(playwright.chromium, info, fakeCamera('bright', 200), async (page) => {
    await openCamera(page);
    await page.waitForTimeout(1500); // several readings
    await expect(page.locator('.lighting-hint')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Light/ })).toHaveCount(0);
  });
});

test('a dark page says it is too dark, without blocking Capture', async ({ playwright }, info) => {
  await withCamera(playwright.chromium, info, fakeCamera('dark', 55), async (page) => {
    await openCamera(page);
    await expect(page.getByRole('status').filter({ hasText: /too dark/i })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Capture' })).toBeEnabled();
  });
});

test('a page half in shadow says there is a shadow', async ({ playwright }, info) => {
  await withCamera(playwright.chromium, info, fakeCamera('shadow', 200, 0.65), async (page) => {
    await openCamera(page);
    await expect(page.getByRole('status').filter({ hasText: /shadow/i })).toBeVisible({ timeout: 5000 });
  });
});

test('a camera with a torch offers Light, switched only by a tap', async ({ playwright }, info) => {
  await withCamera(playwright.chromium, info, fakeCamera('dark-torch', 55), async (page) => {
    // Chromium's fake camera has no torch: report one, and record requests.
    await page.addInitScript(() => {
      const calls: unknown[] = [];
      (window as unknown as { __torch: unknown[] }).__torch = calls;
      const proto = MediaStreamTrack.prototype as unknown as {
        getCapabilities: () => object;
        applyConstraints: (c: unknown) => Promise<void>;
      };
      const original = proto.getCapabilities;
      proto.getCapabilities = function (this: unknown) {
        return { ...(original ? original.call(this) : {}), torch: true };
      };
      proto.applyConstraints = async (c: unknown) => {
        calls.push(c);
      };
    });
    await openCamera(page);

    const light = page.getByRole('button', { name: /^Light/ });
    await expect(light).toBeVisible();
    await expect(light).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('status').filter({ hasText: /tap Light/i })).toBeVisible({ timeout: 5000 });
    // Dark, and a torch available — and still never switched on by the app.
    expect(await torchCalls(page)).toEqual([]);
    await page.locator('.camera-frame').screenshot({ path: 'test-results/screens/lighting-dark-torch.png' });

    await light.click();
    await expect(light).toHaveAttribute('aria-pressed', 'true');
    expect(await torchCalls(page)).toEqual([{ advanced: [{ torch: true }] }]);
    await expect(page.getByRole('status').filter({ hasText: /tap Light/i })).toHaveCount(0);

    await light.click();
    await expect(light).toHaveAttribute('aria-pressed', 'false');
    expect(await torchCalls(page)).toEqual([{ advanced: [{ torch: true }] }, { advanced: [{ torch: false }] }]);
  });
});
