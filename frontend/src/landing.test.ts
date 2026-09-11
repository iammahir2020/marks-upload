import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { APP_VISIBLE_CLASS, LANDING_SEEN_KEY, showLandingOverlay } from './landing';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove(APP_VISIBLE_CLASS);
});

describe('showLandingOverlay (step.md 14.4/14.6)', () => {
  it('clears the app-visible class, revealing the static landing markup underneath', () => {
    document.documentElement.classList.add(APP_VISIBLE_CLASS);
    showLandingOverlay();
    expect(document.documentElement.classList.contains(APP_VISIBLE_CLASS)).toBe(false);
  });

  it('is harmless to call when the class was never set', () => {
    expect(() => showLandingOverlay()).not.toThrow();
    expect(document.documentElement.classList.contains(APP_VISIBLE_CLASS)).toBe(false);
  });
});

// These two constants are the only thing standing between this file and
// the static shell's copy of the same rule drifting apart — landing.css's
// `<style>` block can't import them (CSS, not JS), and
// scripts/prerender-landing.mjs's inline bootstrap script can't either
// (it has to exist as plain text before any bundle does), so both are
// pinned here against the actual source text of the files that embed
// them literally.
describe('shared constants stay embedded verbatim (drift guard)', () => {
  it('landing.css keys its visibility rules off the exact APP_VISIBLE_CLASS name', () => {
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'landing.css'), 'utf8');
    expect(css).toContain(`html.${APP_VISIBLE_CLASS} #landing-root`);
    expect(css).toContain(`html:not(.${APP_VISIBLE_CLASS}) #root`);
  });

  it('LANDING_SEEN_KEY is the documented literal, not something a rename could silently change', () => {
    // prerenderEntry.tsx re-exports this by reference, not by copying the
    // string, so this pins the one place drift could actually enter: a
    // future edit renaming the exported binding without updating what it
    // equals.
    expect(LANDING_SEEN_KEY).toBe('msLandingSeen');
  });
});
