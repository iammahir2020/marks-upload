// The landing page's HERO visual (step.md 14.2, plan.md §19) — a static
// illustration of the "settled" state, peeking from the hero's bottom
// edge: a legible marks grid with one cell flagged rather than guessed.
// This one stays static and unanimated even after Phase C (14.7/14.8):
// the hero is a peek above the fold, not the scrollytelling section — the
// actual five-state scroll-linked animation lives in `ScanAnimation.tsx`,
// used by the "How it works" section instead. The two share a visual
// language (same grid, same flagged-cell treatment) but not literal
// markup, since five distinct states are genuinely different drawings,
// not one drawing with different attributes.
//
// Purely presentational, inline SVG only (no image request, no video) —
// plan.md §19's weight budget rules out anything else for this element.
export default function ScanGraphic() {
  const idDigits = ['2', '6', '3', '2', '7', '1', '1'];
  const marks = [
    { label: 'Q1', value: '5' },
    { label: 'Q2', value: '4.5' },
    { label: 'Q3', value: null }, // the flagged cell — read, never guessed
    { label: 'Q4', value: '5' },
  ];

  return (
    <svg
      viewBox="0 0 360 220"
      width="100%"
      height="100%"
      role="img"
      aria-label="An illustration of a marks grid being read: a student ID row, a row of question marks, and one uncertain mark flagged instead of guessed."
    >
      <rect x="8" y="8" width="344" height="204" rx="14" fill="var(--lp-surface)" stroke="var(--lp-border)" />

      <text x="28" y="38" fontSize="11" fontWeight="600" fill="var(--lp-faint)" letterSpacing="0.06em">
        STUDENT ID
      </text>
      {idDigits.map((digit, i) => (
        <g key={`id-${i}`} transform={`translate(${28 + i * 32}, 48)`}>
          <rect width="26" height="32" rx="6" fill="var(--lp-surface-2)" stroke="var(--lp-border)" />
          <text x="13" y="21" fontSize="14" fontWeight="600" fill="var(--lp-foreground)" textAnchor="middle">
            {digit}
          </text>
        </g>
      ))}

      <text x="28" y="112" fontSize="11" fontWeight="600" fill="var(--lp-faint)" letterSpacing="0.06em">
        MARKS
      </text>
      {marks.map((mark, i) => (
        <g key={mark.label} transform={`translate(${28 + i * 78}, 122)`}>
          <rect width="66" height="60" rx="8" fill="var(--lp-surface-2)" stroke="var(--lp-border)" />
          <text x="33" y="18" fontSize="10" fill="var(--lp-faint)" textAnchor="middle">
            {mark.label}
          </text>
          {mark.value ? (
            <text x="33" y="42" fontSize="18" fontWeight="600" fill="var(--lp-foreground)" textAnchor="middle">
              {mark.value}
            </text>
          ) : (
            <g transform="translate(33, 38)" aria-hidden="true">
              <path
                d="M0 -10 L8 6 L-8 6 Z"
                fill="none"
                stroke="var(--lp-warning)"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <circle cx="0" cy="-3.5" r="0.75" fill="var(--lp-warning)" />
              <rect x="-0.75" y="-1.5" width="1.5" height="3" fill="var(--lp-warning)" />
            </g>
          )}
        </g>
      ))}
    </svg>
  );
}
