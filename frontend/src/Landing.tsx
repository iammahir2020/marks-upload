// The landing page (step.md step 14, plan.md §19) — the story before the
// tool, for someone who was sent the link rather than someone who
// already knows why they'd want a section.
//
// Since Phase B (14.5/14.6), this component is a BUILD-TIME input only —
// `src/prerenderEntry.tsx` runs it through `renderToStaticMarkup` in
// Node, and `scripts/prerender-landing.mjs` injects the result straight
// into `dist/index.html`, outside `#root`. Nothing in the shipped app
// imports this file any more (App.tsx dropped its 'landing' screen
// entirely); it still gets exercised by Landing.test.tsx as a plain
// component render, and by the prerender pipeline at build time — both
// need it to stay purely presentational, no hooks, nothing touching a
// browser API during render, since `renderToStaticMarkup` runs with no
// DOM and no IndexedDB. The three `data-open-app` attributes are what let
// the static markup's buttons work with zero runtime JS of their own —
// see `scripts/prerender-landing.mjs`'s inline bootstrap script, which
// wires them up by event delegation rather than by any handler this
// component's own `onClick={onOpenApp}` could carry into static HTML
// (React event handlers never serialize; they exist here only for
// Landing.test.tsx's component-level tests).
import './landing.css';
import GridTemplateFigure from './GridTemplateFigure';
import ScanAnimation from './ScanAnimation';
import ScanGraphic from './ScanGraphic';
import QrCode from './QrCode';
import { DEPLOYED_APP_URL } from './landing';

interface LandingProps {
  onOpenApp: () => void;
}

const HOW_IT_WORKS = [
  {
    title: 'Photograph the grid',
    detail:
      'Scanning only works if the grid is already printed on the script — an ID table, a Serial table, and a marks table, copied once from the template. That structure is exactly what the camera looks for and reads.',
    visual: <GridTemplateFigure />,
  },
  {
    title: 'The table is found and straightened',
    detail: "It doesn't matter how the photo was held. The grid is located and squared up automatically.",
  },
  {
    title: 'Each cell is read',
    detail: 'The student ID, the serial number, and every question mark — read one cell at a time.',
  },
  {
    title: 'Anything uncertain is flagged, never guessed',
    detail: "A digit it isn't confident about is left blank with a flag, not filled in with a best guess.",
  },
  {
    title: 'You confirm, and it saves',
    detail: 'One tap per script. The whole class exports as a single spreadsheet whenever you’re ready.',
  },
];

const REFUSALS = [
  'An uncertain digit is left blank and flagged — never filled in with a confident guess.',
  "If what the camera sees doesn’t match the quiz you set up, the scan fails outright — it never writes one question’s mark into another’s column.",
  'A blank never exports as a zero.',
];

const PRIVACY_POINTS = [
  'The photograph reaches your own laptop and is never stored — it’s read once, then discarded.',
  'On the default recognizer, nothing leaves that laptop at all — no third party ever sees a script.',
  'Individual cells are kept, with the value you confirmed, to improve recognition — no names, nothing that reassembles a student ID.',
  'Marks live in your browser until you export them. No account, no sign-up, no server-side database.',
];

export default function Landing({ onOpenApp }: LandingProps) {
  return (
    <div className="landing">
      <header className="lp-topbar">
        <span className="lp-topbar-name">Script Mark Scanner</span>
        <button type="button" className="btn btn-primary btn-sm" data-open-app onClick={onOpenApp}>
          Open the app
        </button>
      </header>

      {/* 1. Hero */}
      <section className="lp-section lp-hero">
        <div className="lp-hero-copy">
          <h1 className="lp-h1">You already graded it. Let the camera do the typing.</h1>
          <p className="lp-lead">
            Photograph the marks grid on each script and it reads the student ID, serial number, and every
            question’s mark. You confirm each one, and it exports as a single spreadsheet.
          </p>
          <div>
            <button type="button" className="btn btn-primary" data-open-app onClick={onOpenApp}>
              Open the app
            </button>
          </div>
        </div>
        <div className="lp-hero-visual" aria-hidden="true">
          <ScanGraphic />
        </div>
      </section>

      {/* 2. The problem, in real numbers */}
      <section className="lp-section">
        <div className="lp-section-inner lp-prose">
          <p className="lp-eyebrow">The problem</p>
          <p className="lp-stat">~700 numbers</p>
          <p className="lp-body">
            Four sections of about thirty scripts each, six numbers a script — that’s on the order of seven
            hundred numbers typed by hand, at the end of a day already spent marking. One transposed digit is a
            wrong grade nobody catches, because there’s nothing to catch it against.
          </p>
        </div>
      </section>

      {/* 3. How it works — told by the scan animation (step.md 14.7/14.8):
          one pinned graphic moving through five states as the reader
          scrolls past these same five captions. */}
      <section className="lp-section">
        <div className="lp-section-inner">
          <p className="lp-eyebrow">How it works</p>
          <h2 className="lp-h2">Five steps, and one of them is checking its own work.</h2>
          <ScanAnimation steps={HOW_IT_WORKS} />
        </div>
      </section>

      {/* 4. What it refuses to do */}
      <section className="lp-section">
        <div className="lp-section-inner lp-prose">
          <p className="lp-eyebrow">What it refuses to do</p>
          <h2 className="lp-h2">A wrong number is worse than a blank one.</h2>
          <ul className="lp-list">
            {REFUSALS.map((point) => (
              <li key={point} className="lp-card">
                <span className="lp-body">{point}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 5. Where your work actually goes */}
      <section className="lp-section">
        <div className="lp-section-inner lp-prose">
          <p className="lp-eyebrow">Where your work actually goes</p>
          <h2 className="lp-h2">No account. No server-side database.</h2>
          <ul className="lp-list">
            {PRIVACY_POINTS.map((point) => (
              <li key={point} className="lp-body">
                {point}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 6. Close */}
      <section className="lp-section lp-close">
        <div className="lp-section-inner lp-prose">
          <h2 className="lp-h2">Open the app and photograph the first one.</h2>
          <button type="button" className="btn btn-primary" data-open-app onClick={onOpenApp}>
            Open the app
          </button>
          <div className="lp-share">
            <p className="lp-eyebrow">Share it</p>
            <div className="lp-qr-frame">
              <QrCode url={DEPLOYED_APP_URL} />
            </div>
            <a className="lp-share-link" href={DEPLOYED_APP_URL}>
              {DEPLOYED_APP_URL.replace(/^https?:\/\//, '')}
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
