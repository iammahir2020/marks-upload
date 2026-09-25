// issues.md N43 — the page's Content-Security-Policy, written into the built
// index.html as a <meta> at build time (scripts/prerender-landing.mjs).
//
// Why a <meta> and not only a CloudFront header: the policy has to allow
// exactly the inline <script> and <style> blocks this build produced, by
// SHA-256 hash, and those change whenever landing.css or the bootstrap does.
// Written into the same file it describes, the policy and the page can never
// be out of step — not even for the minutes a CloudFront change takes to
// propagate. The directives a <meta> CSP can't carry (frame-ancestors)
// come from deploy.sh's response headers policy instead; browsers enforce
// both policies together.
//
// Build only. `vite dev` injects inline scripts of its own (HMR, React
// Refresh), so the dev server never gets this.
import { createHash } from 'node:crypto';

// Everything the app loads is its own: the bundle, the service worker, the
// manifest, icons. blob: is for the capture preview (<img src=blob:>) and
// for Review re-reading that same blob to harvest it (fetch(blob:)).
const FIXED = {
  'default-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'connect-src': ["'self'", 'blob:'],
  'media-src': ["'self'", 'blob:'],
  'font-src': ["'self'"],
  'worker-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
};

function sha256(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** Hashes of every inline <script> (no src) and every <style> in `html`. */
export function inlineHashes(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs))
    .map(([, , body]) => sha256(body));
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(([, body]) => sha256(body));
  return { scripts, styles };
}

export function buildCsp(html) {
  const { scripts, styles } = inlineHashes(html);
  const directives = {
    ...FIXED,
    'script-src': ["'self'", ...scripts],
    'style-src': ["'self'", ...styles],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

/** index.html with the CSP <meta> as the first thing in <head> — it only
 *  governs what comes after it, so it must precede every script and style. */
export function addCspMeta(html) {
  if (html.includes('http-equiv="Content-Security-Policy"')) {
    throw new Error('csp: index.html already has a CSP meta');
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(html)}">`;
  const withMeta = html.replace(/<head(\s[^>]*)?>/i, (open) => `${open}\n    ${meta}`);
  if (withMeta === html) throw new Error('csp: no <head> in index.html');
  return withMeta;
}
