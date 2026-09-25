// issues.md N43 — scripts/csp.mjs, the build-time Content-Security-Policy.
// The real-browser proof that the policy blocks nothing the app does is
// e2e-prod/csp.spec.ts (npm run test:e2e:prod); these pin the rules.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs build script with no declaration file
import { addCspMeta, buildCsp, inlineHashes } from '../scripts/csp.mjs';

const hash = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

const PAGE = `<!doctype html><html><head><title>x</title>
<script type="module" src="/assets/index.js"></script>
<script id="lp-bootstrap">var a=1;</script>
<style id="lp-critical-css">body{color:red}</style>
</head><body></body></html>`;

describe('csp', () => {
  it('hashes inline scripts and styles, never a script loaded by src', () => {
    const { scripts, styles } = inlineHashes(PAGE);
    expect(scripts).toEqual([hash('var a=1;')]);
    expect(styles).toEqual([hash('body{color:red}')]);
  });

  it('allows only this site plus those exact inline blocks', () => {
    const csp = buildCsp(PAGE);
    expect(csp).toContain(`script-src 'self' ${hash('var a=1;')}`);
    expect(csp).toContain(`style-src 'self' ${hash('body{color:red}')}`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
  });

  it('allows blob: where the capture preview and the harvest re-read need it', () => {
    const csp = buildCsp(PAGE);
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self' blob:");
  });

  it('puts the meta first in <head>, before anything it has to govern', () => {
    const out: string = addCspMeta(PAGE);
    const meta = out.indexOf('http-equiv="Content-Security-Policy"');
    expect(meta).toBeGreaterThan(out.indexOf('<head>'));
    expect(meta).toBeLessThan(out.indexOf('<script'));
  });

  it('a changed inline block changes the policy — so a stale one can never ship', () => {
    expect(buildCsp(PAGE)).not.toBe(buildCsp(PAGE.replace('var a=1;', 'var a=2;')));
  });

  it('refuses to add a second policy', () => {
    expect(() => addCspMeta(addCspMeta(PAGE))).toThrow();
  });
});
