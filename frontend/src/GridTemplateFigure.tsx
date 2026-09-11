// A static reference drawing of the printed grid structure (plan.md §3),
// shown next to "How it works" step 1: the three ordinary tables — ID,
// Serial, Marks — that have to already be pasted into the question paper
// before any script gets photographed. Deliberately blank (no digits, no
// values) since this is the template you print, not a scan result — that
// distinction is what ScanGraphic/ScanAnimation's filled-in cells are for.
//
// Matches the actual template's structure (`marks-grid-template.docx`):
// "ID" and "Serial" are each the FIRST COLUMN of their own table, sharing
// a border with the boxes beside them — not a caption floating next to a
// separate shape. Cells are contiguous (no gaps) with sharp corners, the
// way a real Docs/Word table renders, rather than the rounded standalone
// boxes ScanGraphic/ScanAnimation use for a filled-in *scan result*.
//
// Purely presentational, inline SVG, no animation: the template doesn't
// change over the course of the section, so nothing here needs to move.
export default function GridTemplateFigure() {
  const idBoxes = 7;
  const questions = [1, 2, 3, 4, 5];

  const labelWidth = 56;
  const digitWidth = 32;
  const rowHeight = 32;
  const serialAnswerWidth = 48;
  const rowGap = 14;

  const qWidth = 54;
  const totalWidth = 64;
  const headerHeight = 18;
  const answerHeight = 28;

  const idY = 0;
  const serialY = idY + rowHeight + rowGap;
  const marksY = serialY + rowHeight + rowGap + 4;

  const idTableWidth = labelWidth + idBoxes * digitWidth;
  const marksTableWidth = questions.length * qWidth + totalWidth;
  const viewWidth = Math.max(idTableWidth, marksTableWidth);
  const viewHeight = marksY + headerHeight + answerHeight;

  return (
    <svg
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      width="100%"
      height="100%"
      role="img"
      aria-label="The printed grid structure: an ID table with 'ID' as its own first column followed by one box per digit, a Serial table with 'Serial' as its own first column followed by one answer cell, and a Marks table with a header-and-answer column per question plus a Total column."
    >
      {/* ID table — one row: the "ID" label cell, then one box per digit,
          all sharing borders as columns of the same table. */}
      <rect x="0" y={idY} width={labelWidth} height={rowHeight} fill="var(--lp-surface)" stroke="var(--lp-border)" />
      <text x={labelWidth / 2} y={idY + rowHeight / 2 + 4} fontSize="11" fontWeight="600" fill="var(--lp-faint)" textAnchor="middle">
        ID
      </text>
      {Array.from({ length: idBoxes }).map((_, i) => (
        <rect
          key={`id-${i}`}
          x={labelWidth + i * digitWidth}
          y={idY}
          width={digitWidth}
          height={rowHeight}
          fill="var(--lp-surface-2)"
          stroke="var(--lp-border)"
        />
      ))}

      {/* Serial table — one row: the "Serial" label cell, then the single
          free-text answer cell, same shape as the ID table above it. */}
      <rect x="0" y={serialY} width={labelWidth} height={rowHeight} fill="var(--lp-surface)" stroke="var(--lp-border)" />
      <text x={labelWidth / 2} y={serialY + rowHeight / 2 + 4} fontSize="9.5" fontWeight="600" fill="var(--lp-faint)" textAnchor="middle">
        SERIAL
      </text>
      <rect
        x={labelWidth}
        y={serialY}
        width={serialAnswerWidth}
        height={rowHeight}
        fill="var(--lp-surface-2)"
        stroke="var(--lp-border)"
      />

      {/* Marks table — header row (question + max) over an empty answer
          row, one column per question plus Total. */}
      {questions.map((q, i) => (
        <g key={`q-${q}`} transform={`translate(${i * qWidth}, ${marksY})`}>
          <rect width={qWidth} height={headerHeight} fill="var(--lp-surface)" stroke="var(--lp-border)" />
          <text x={qWidth / 2} y={headerHeight - 5} fontSize="8" fill="var(--lp-faint)" textAnchor="middle">
            {`Q${q} (5)`}
          </text>
          <rect y={headerHeight} width={qWidth} height={answerHeight} fill="var(--lp-surface-2)" stroke="var(--lp-border)" />
        </g>
      ))}
      <g transform={`translate(${questions.length * qWidth}, ${marksY})`}>
        <rect width={totalWidth} height={headerHeight} fill="var(--lp-surface)" stroke="var(--lp-border)" />
        <text x={totalWidth / 2} y={headerHeight - 5} fontSize="8" fill="var(--lp-faint)" textAnchor="middle">
          Total (25)
        </text>
        <rect y={headerHeight} width={totalWidth} height={answerHeight} fill="var(--lp-surface-2)" stroke="var(--lp-border)" />
      </g>
    </svg>
  );
}
