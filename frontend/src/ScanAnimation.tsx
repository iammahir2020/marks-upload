// The "How it works" scan animation (step.md 14.7/14.8, plan.md §19). One
// pinned inline SVG moving through five states as the reader scrolls, with
// the section's own step captions providing the scroll distance beside
// (wide) or beneath (phone) it — see landing.css for the actual scroll-
// linked CSS (`view-timeline`/`animation-timeline`), gated behind
// `@supports` and `prefers-reduced-motion` so an unsupported or motion-
// averse browser gets the settled, final state statically rather than a
// blank or half-drawn frame (14.8 ships in the same phase as 14.7, not
// after it).
//
// Purely presentational, same as ScanGraphic — no hooks, nothing touching
// a browser API, since Landing.tsx (which renders this) has to survive
// `renderToStaticMarkup` in Node.
//
// The pin is `aria-hidden`: a screen reader would otherwise be handed a
// single, static description of an illustration that is visually
// mid-crossfade between two of five states at any given scroll position.
// The captions carry the same content in real, always-correct text.
import type { ReactNode } from 'react';

const ID_DIGITS = ['2', '6', '3', '2', '7', '1', '1'];
const SERIAL_DIGITS = ['0', '1', '2', '7'];
const MARKS: Array<{ label: string; value: string | null }> = [
  { label: 'Q1', value: '5' },
  { label: 'Q2', value: '4.5' },
  { label: 'Q3', value: null }, // the flagged cell — read, never guessed
  { label: 'Q4', value: '5' },
];

// Shared cell geometry for states 3 and 4 (the "cells separate" and
// "digits resolve" states) — kept as one source so the two states'
// otherwise-duplicated rects can't quietly drift apart in position.
const ID_CELL = { x0: 28, y: 38, w: 26, h: 28, step: 32 };
const SERIAL_CELL = { x0: 28, y: 94, w: 26, h: 26, step: 32 };
const MARK_CELL = { x0: 28, y: 150, w: 66, h: 56, step: 78 };

function CardFrame() {
  return <rect x="8" y="8" width="344" height="216" rx="14" fill="var(--lp-surface)" stroke="var(--lp-border)" />;
}

function EmptyCells() {
  return (
    <>
      {ID_DIGITS.map((_, i) => (
        <rect
          key={`id-${i}`}
          x={ID_CELL.x0 + i * ID_CELL.step}
          y={ID_CELL.y}
          width={ID_CELL.w}
          height={ID_CELL.h}
          rx="6"
          fill="var(--lp-surface-2)"
          stroke="var(--lp-border)"
        />
      ))}
      {SERIAL_DIGITS.map((_, i) => (
        <rect
          key={`serial-${i}`}
          x={SERIAL_CELL.x0 + i * SERIAL_CELL.step}
          y={SERIAL_CELL.y}
          width={SERIAL_CELL.w}
          height={SERIAL_CELL.h}
          rx="5"
          fill="var(--lp-surface-2)"
          stroke="var(--lp-border)"
        />
      ))}
      {MARKS.map((mark, i) => (
        <rect
          key={mark.label}
          x={MARK_CELL.x0 + i * MARK_CELL.step}
          y={MARK_CELL.y}
          width={MARK_CELL.w}
          height={MARK_CELL.h}
          rx="8"
          fill="var(--lp-surface-2)"
          stroke="var(--lp-border)"
        />
      ))}
    </>
  );
}

function RowLabels() {
  return (
    <>
      <text x="28" y="30" fontSize="10" fontWeight="600" fill="var(--lp-faint)" letterSpacing="0.06em">
        STUDENT ID
      </text>
      <text x="28" y="86" fontSize="10" fontWeight="600" fill="var(--lp-faint)" letterSpacing="0.06em">
        SERIAL
      </text>
      <text x="28" y="142" fontSize="10" fontWeight="600" fill="var(--lp-faint)" letterSpacing="0.06em">
        MARKS
      </text>
    </>
  );
}

export default function ScanAnimation({
  steps,
}: {
  steps: Array<{ title: string; detail: string; visual?: ReactNode }>;
}) {
  return (
    <div className="lp-scan-scroller">
      <div className="lp-scan-pin" aria-hidden="true">
        <svg viewBox="0 0 360 232" width="100%" height="100%">
          {/* State 1 — photographed, slightly rotated: rough row bands,
              no cell detail and no text yet, the way a phone photo
              arrives before anything has been found in it. */}
          <g className="scan-state scan-state-1" transform="rotate(-5 180 116)">
            <CardFrame />
            <rect x="28" y="38" width="220" height="28" rx="6" fill="var(--lp-surface-2)" opacity="0.55" />
            <rect x="28" y="94" width="150" height="26" rx="5" fill="var(--lp-surface-2)" opacity="0.55" />
            <rect x="28" y="150" width="328" height="56" rx="8" fill="var(--lp-surface-2)" opacity="0.55" />
            <rect x="40" y="8" width="60" height="216" fill="#ffffff" opacity="0.05" transform="rotate(18 70 116)" />
          </g>

          {/* State 2 — straightened and detected: rotation gone, the
              table's rules are found (outline bands), still no
              individual cells and no text. */}
          <g className="scan-state scan-state-2">
            <CardFrame />
            <rect x="28" y="38" width="220" height="28" rx="6" fill="none" stroke="var(--lp-border)" strokeWidth="1.5" strokeDasharray="4 3" />
            <rect x="28" y="94" width="150" height="26" rx="5" fill="none" stroke="var(--lp-border)" strokeWidth="1.5" strokeDasharray="4 3" />
            <rect x="28" y="150" width="328" height="56" rx="8" fill="none" stroke="var(--lp-border)" strokeWidth="1.5" strokeDasharray="4 3" />
          </g>

          {/* State 3 — cells separate: the ID row, the serial and the
              per-question marks each become their own cell, labelled,
              still empty — the moment right before anything is read. */}
          <g className="scan-state scan-state-3">
            <CardFrame />
            <RowLabels />
            <EmptyCells />
          </g>

          {/* State 4 — digits resolve, and one becomes a flag rather
              than a number. This is the state the whole animation
              exists for (plan.md §19): it demonstrates "flag, never
              guess" instead of claiming it. */}
          <g className="scan-state scan-state-4">
            <CardFrame />
            <RowLabels />
            <EmptyCells />
            {ID_DIGITS.map((digit, i) => (
              <text
                key={`id-v-${i}`}
                x={ID_CELL.x0 + i * ID_CELL.step + ID_CELL.w / 2}
                y={ID_CELL.y + ID_CELL.h / 2 + 5}
                fontSize="13"
                fontWeight="600"
                fill="var(--lp-foreground)"
                textAnchor="middle"
              >
                {digit}
              </text>
            ))}
            {SERIAL_DIGITS.map((digit, i) => (
              <text
                key={`serial-v-${i}`}
                x={SERIAL_CELL.x0 + i * SERIAL_CELL.step + SERIAL_CELL.w / 2}
                y={SERIAL_CELL.y + SERIAL_CELL.h / 2 + 5}
                fontSize="13"
                fontWeight="600"
                fill="var(--lp-foreground)"
                textAnchor="middle"
              >
                {digit}
              </text>
            ))}
            {MARKS.map((mark, i) => {
              const cx = MARK_CELL.x0 + i * MARK_CELL.step + MARK_CELL.w / 2;
              const cy = MARK_CELL.y + MARK_CELL.h / 2;
              return mark.value ? (
                <text key={mark.label} x={cx} y={cy + 6} fontSize="18" fontWeight="600" fill="var(--lp-foreground)" textAnchor="middle">
                  {mark.value}
                </text>
              ) : (
                <g key={mark.label} transform={`translate(${cx}, ${cy - 2})`}>
                  <path d="M0 -10 L8 6 L-8 6 Z" fill="none" stroke="var(--lp-warning)" strokeWidth="2" strokeLinejoin="round" />
                  <circle cx="0" cy="-3.5" r="0.75" fill="var(--lp-warning)" />
                  <rect x="-0.75" y="-1.5" width="1.5" height="3" fill="var(--lp-warning)" />
                </g>
              );
            })}
          </g>

          {/* State 5 — the export: everything settles into one
              spreadsheet row. The flagged mark stays blank here too —
              a blank never exports as a zero (plan.md §19, section 4). */}
          <g className="scan-state scan-state-5">
            <CardFrame />
            {['ID', 'Serial', 'Q1', 'Q2', 'Q3', 'Q4'].map((header, i) => (
              <g key={header} transform={`translate(${16 + i * 54}, 76)`}>
                <rect width="50" height="22" fill="var(--lp-surface-2)" stroke="var(--lp-border)" />
                <text x="25" y="15" fontSize="9" fontWeight="600" fill="var(--lp-faint)" textAnchor="middle">
                  {header}
                </text>
              </g>
            ))}
            {['2632711', '0127', '5', '4.5', '', '5'].map((value, i) => (
              <g key={`data-${i}`} transform={`translate(${16 + i * 54}, 98)`}>
                <rect
                  width="50"
                  height="26"
                  fill="none"
                  stroke="var(--lp-border)"
                  strokeDasharray={value ? undefined : '3 2'}
                />
                <text x="25" y="18" fontSize={i === 0 ? '8' : '11'} fontWeight="600" fill="var(--lp-foreground)" textAnchor="middle">
                  {value}
                </text>
              </g>
            ))}
            <text x="16" y="150" fontSize="10" fill="var(--lp-faint)">
              one_class.xlsx
            </text>
          </g>
        </svg>
      </div>

      <ol className="lp-list lp-scan-captions">
        {steps.map((step, i) => (
          <li key={step.title} className="lp-step">
            <span className="lp-step-number" aria-hidden="true">
              {i + 1}
            </span>
            <span className="lp-step-text">
              <strong>{step.title}</strong>
              <span className="lp-body">{step.detail}</span>
              {step.visual && <span className="lp-step-visual">{step.visual}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
