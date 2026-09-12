// A small inline QR code, used on the landing page's close section to
// share the app's own URL with a colleague by showing the screen rather
// than reading the address out or typing it into a message. Purely
// presentational and side-effect-free, same as ScanGraphic.tsx —
// Landing.tsx (this component's only real caller) is rendered through
// renderToStaticMarkup at build time and ships no client bundle of its
// own, so `qrcode-generator` never reaches the browser either.
//
// Built from the library's raw module matrix (isDark/getModuleCount) as
// one combined SVG path, rather than its own createSvgTag() output,
// purely to keep the same inline-SVG + viewBox style every other landing
// graphic here uses. QR codes need real light/dark contrast and a light
// quiet-zone border to scan reliably — that's a deliberate, scoped
// exception to the rest of this page's dark --lp-* palette, not an
// oversight (see .lp-qr-frame in landing.css).
//
// Dark modules are run-length merged along each row before being turned
// into path commands (one rectangle per horizontal run, not one square
// per module) — this page is weight-budgeted in prerender.test.ts, and a
// square-per-module path pushed the whole prerendered document ~1KB gzip
// over that budget for no visual difference at all.
//
// A bare origin (no path/query/fragment) is also re-encoded in QR's
// Alphanumeric mode on its uppercased form — ~5.5 bits/char instead of
// Byte mode's 8, which was the other real lever on module count (29x29
// -> 25x25 for this URL). This is deliberately gated on "no path": a
// scheme and host are case-insensitive so uppercasing one is always
// still the same URL, but a path/query often isn't, so anything beyond a
// bare origin keeps its exact case in the more expensive Byte mode.
import qrcode from 'qrcode-generator';

const QUIET_ZONE = 4; // modules of light margin most scanners expect
const ALPHANUMERIC_SAFE = /^[0-9A-Z $%*+\-./:]*$/;

function isBareOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.pathname === '' || parsed.pathname === '/') && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

interface QrCodeProps {
  url: string;
  size?: number;
}

export default function QrCode({ url, size = 120 }: QrCodeProps) {
  const qr = qrcode(0, 'M');
  const upper = url.toUpperCase();
  if (isBareOrigin(url) && ALPHANUMERIC_SAFE.test(upper)) {
    qr.addData(upper, 'Alphanumeric');
  } else {
    qr.addData(url);
  }
  qr.make();
  const modules = qr.getModuleCount();
  const dimension = modules + QUIET_ZONE * 2;

  let path = '';
  for (let row = 0; row < modules; row++) {
    let col = 0;
    while (col < modules) {
      if (!qr.isDark(row, col)) {
        col++;
        continue;
      }
      const runStart = col;
      while (col < modules && qr.isDark(row, col)) col++;
      const runLength = col - runStart;
      const x = runStart + QUIET_ZONE;
      const y = row + QUIET_ZONE;
      // Comma-only separators, no whitespace — valid SVG path grammar
      // (a command letter always ends the previous argument list) and
      // measurably smaller once this many rectangles are concatenated.
      path += `M${x},${y}l${runLength},0,0,1,${-runLength},0,0,-1z`;
    }
  }

  return (
    <svg
      viewBox={`0 0 ${dimension} ${dimension}`}
      width={size}
      height={size}
      role="img"
      aria-label={`QR code linking to ${url}`}
      shapeRendering="crispEdges"
    >
      <rect x={0} y={0} width={dimension} height={dimension} fill="#fff" />
      <path d={path.trim()} fill="#111" />
    </svg>
  );
}
