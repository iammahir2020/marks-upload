// Class-list roster parsing (step.md step 12.2/12.3/12.4, plan.md §17).
// Pure and dependency-free apart from ExcelJS's own types — kept separate
// from any component so it's directly unit-testable, matching this
// project's established pattern (validateMarks.ts, validateConfig.ts,
// resultsTable.ts). Operates on an already-loaded `ExcelJS.Workbook`; loading
// the file itself (and catching a corrupt/non-xlsx upload) is the caller's
// job, not this module's — see Setup.tsx's `unreadable_file` handling.
import type { Workbook, Worksheet } from 'exceljs';

// How many rows from the top of a sheet to scan for the header row before
// giving up on it as a candidate. A title row or two above the real header
// is common; a whole roster of hundreds of students is not going to have
// its header past row 20.
const HEADER_SCAN_ROWS = 20;

// A cell's value can be a plain string/number, or one of ExcelJS's richer
// shapes (hyperlink `{text, hyperlink}`, rich text `{richText: [...]}`,
// or a formula result `{formula, result}`). Reduced to plain text so
// header matching and ID/name extraction don't have to special-case each
// shape separately.
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v.richText)) {
      return v.richText.map((r) => (r as { text?: string }).text ?? '').join('');
    }
    if ('result' in v) return cellText(v.result);
    return '';
  }
  return String(value);
}

// Case- and punctuation-insensitive header matching (the user's own
// requirement): "Student ID", "STUDENT  ID", "student_id" and "StudentID"
// must all resolve to the same key.
export function canonicalKey(raw: unknown): string {
  return cellText(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface HeaderMatch {
  row: number; // 1-indexed
  columns: Map<string, number>; // canonical key -> 1-indexed column
}

// The roster sheet is identified by content, never by name or position
// (the File Format Contract): a header row carrying both STUDENT ID and
// STUDENT NAME. Scanned rather than assumed to be row 1, since a title row
// above the real header is a normal thing for a real workbook to have.
export function findRosterHeaderRow(ws: Worksheet, maxRows = HEADER_SCAN_ROWS): HeaderMatch | null {
  const limit = Math.min(maxRows, ws.rowCount);
  for (let r = 1; r <= limit; r++) {
    const columns = new Map<string, number>();
    ws.getRow(r).eachCell((cell, colNumber) => {
      const key = canonicalKey(cell.value);
      if (key) columns.set(key, colNumber);
    });
    if (columns.has('STUDENTID') && columns.has('STUDENTNAME')) {
      return { row: r, columns };
    }
  }
  return null;
}

// An exam sheet this app writes always carries Total + at least one Q<n>
// column + Serial, together (step.md 12.5). A class list that has grown
// its own summary columns over a semester (Q1/Q2/Mid/Total) does not have
// Serial, so it survives this test — see plan.md §17 "Identifying the
// class-list sheet" for why this exclusion runs first and unconditionally,
// before position is ever consulted.
export function hasExamSignature(columns: Map<string, number>): boolean {
  // "TOTAL" alone, or "TOTAL" followed only by digits — the exam sheet
  // this app writes headers its Total column as "Total (20)" so the
  // instructor can see the max without opening Setup, and canonicalKey
  // strips the parens/space, leaving "TOTAL20". An exact `=== 'TOTAL'`
  // check would stop recognizing a sheet THIS APP ITSELF WROTE as
  // exam-shaped the next time it's re-uploaded — reopening exactly the
  // misdetection plan.md §17's exclusion rule exists to prevent, since a
  // written exam sheet also carries STUDENT NAME. Digits-only after
  // "TOTAL" is what "Total"/"Total (20)"/"Total(5)" all reduce to; a real
  // roster column like "Total Marks Trend" canonicalizes to
  // "TOTALMARKSTREND" and still correctly fails this.
  const hasTotal = [...columns.keys()].some((key) => /^TOTAL\d*$/.test(key));
  if (!hasTotal || !columns.has('SERIAL')) return false;
  for (const key of columns.keys()) {
    if (/^Q\d+$/.test(key)) return true;
  }
  return false;
}

interface RawStudentRow {
  row: number;
  sl: unknown;
  studentId: unknown;
  studentName: unknown;
}

// A data row "exists" if its STUDENT ID cell is non-blank — matching is on
// ID only, so a row with a name but no ID isn't something this app can
// ever match against and isn't counted. `sl` is read through even though
// it isn't required by this feature (the contract's own words).
function collectStudentRows(ws: Worksheet, header: HeaderMatch): RawStudentRow[] {
  const idCol = header.columns.get('STUDENTID')!;
  const nameCol = header.columns.get('STUDENTNAME')!;
  const slCol = header.columns.get('SL');
  const rows: RawStudentRow[] = [];
  for (let r = header.row + 1; r <= ws.rowCount; r++) {
    const studentId = ws.getRow(r).getCell(idCol).value;
    if (cellText(studentId).trim() === '') continue;
    rows.push({
      row: r,
      sl: slCol ? ws.getRow(r).getCell(slCol).value : null,
      studentId,
      studentName: ws.getRow(r).getCell(nameCol).value,
    });
  }
  return rows;
}

// Comparison key only — the roster's own ID formatting is preserved
// verbatim wherever it's written back (plan.md §17's "IDs are written back
// verbatim" rule). Excel silently turns "0212345" into the number 212345
// when a column is numerically formatted (reproduced against a real
// workbook) — left-padding a short all-digit value back to `idDigits`
// recovers exactly that case without assuming it happened.
export function normalizeIdForMatch(raw: unknown, idDigits: number): string | null {
  const text = cellText(raw).trim();
  if (text === '') return null;
  if (/^\d+$/.test(text) && text.length < idDigits) {
    return text.padStart(idDigits, '0');
  }
  return text;
}

export interface RosterStudent {
  sl: string | number | null;
  studentId: string; // verbatim, as stored in the workbook — never renormalized
  studentIdKey: string; // normalized, for matching only
  studentName: string;
  // The student's ACTUAL row in the sheet — not derivable from position in
  // `students[]`. A row with a blank STUDENT ID is skipped by
  // collectStudentRows, so student i is not generally at
  // `headerRow + 1 + i`; anything writing back into this exact sheet (the
  // opt-in totals column, step.md 12.13) needs the real row number or it
  // silently writes a total next to the wrong name the moment a roster has
  // any gap at all.
  row: number;
}

export interface RosterSheetCandidate {
  sheetName: string;
  headerRow: number;
  isVisible: boolean;
  looksLikeExamSheet: boolean;
  studentCount: number;
}

export interface RosterAnalysis {
  // Roster-shaped candidates only (exam-shaped sheets excluded) — unless
  // NONE survive the exclusion, in which case every header-test-passing
  // sheet is returned instead so the instructor can still hand-pick one
  // rather than being flatly refused (see analyzeWorkbook below).
  candidates: RosterSheetCandidate[];
  // True when the pick is a guess rather than a confident default: either
  // several roster-shaped candidates exist and none is the workbook's own
  // first visible sheet, or nothing survived the exclusion at all. Callers
  // should make the confirm/"Change" step more prominent, not skip it —
  // 12.3's own rule is that confirmation always happens regardless.
  ambiguous: boolean;
  chosenSheetName: string | null;
}

// Implements plan.md §17 "Identifying the class-list sheet: exclude, then
// prefer, then confirm" — in that order. An earlier draft ran the
// position preference before the exam-sheet exclusion; verified directly
// that once exam sheets carry STUDENT NAME (step.md 12.5's decision), a
// dragged exam-sheet tab would independently pass the header test and win
// the position check before exclusion ever ran, reproducing the exact
// silent misdetection this function exists to prevent. Exclusion is
// therefore unconditional and first; position only breaks ties among
// whatever survives it.
export function analyzeWorkbook(workbook: Workbook): RosterAnalysis {
  const allCandidates: RosterSheetCandidate[] = [];
  for (const ws of workbook.worksheets) {
    const header = findRosterHeaderRow(ws);
    if (!header) continue;
    allCandidates.push({
      sheetName: ws.name,
      headerRow: header.row,
      isVisible: (ws.state ?? 'visible') === 'visible',
      looksLikeExamSheet: hasExamSignature(header.columns),
      studentCount: collectStudentRows(ws, header).length,
    });
  }

  const rosterShaped = allCandidates.filter((c) => !c.looksLikeExamSheet);

  if (rosterShaped.length === 0) {
    // Nothing survived the exclusion. If sheets that pass the header test
    // exist at all (even exam-shaped ones — e.g. the class list's own
    // header row was deleted by mistake), surface them for a manual pick
    // rather than a flat refusal; nothing is pre-selected either way.
    return { candidates: allCandidates, ambiguous: allCandidates.length > 0, chosenSheetName: null };
  }

  if (rosterShaped.length === 1) {
    return { candidates: rosterShaped, ambiguous: false, chosenSheetName: rosterShaped[0].sheetName };
  }

  // More than one roster-shaped survivor: break the tie with the
  // workbook's own first-visible-sheet order, if one of the survivors
  // holds that position — this is the payoff for keeping the class list
  // first, applied only among sheets that already passed the exclusion.
  const firstVisibleName = workbook.worksheets.find((w) => (w.state ?? 'visible') === 'visible')?.name;
  const preferred = rosterShaped.find((c) => c.sheetName === firstVisibleName);

  return {
    candidates: rosterShaped,
    ambiguous: !preferred,
    chosenSheetName: (preferred ?? rosterShaped[0]).sheetName,
  };
}

export type RosterErrorCode = 'no_candidate_sheet' | 'empty_roster';

export interface RosterError {
  code: RosterErrorCode;
  message: string;
}

export interface ParsedRoster {
  sheetName: string;
  headerRow: number;
  students: RosterStudent[];
  // studentIdKey values that appear more than once — flagged at upload
  // (step.md 12.2) rather than left to surface confusingly at export time.
  duplicateIds: string[];
}

export function isRosterError(x: ParsedRoster | RosterError): x is RosterError {
  return 'code' in x;
}

// Parses one specific sheet by name — used both for the analyzeWorkbook
// default and for whatever the instructor picks via "Change" (step.md
// 12.3's confirm step always shows every candidate).
export function parseRosterSheet(
  workbook: Workbook,
  sheetName: string,
  idDigits: number,
): ParsedRoster | RosterError {
  const ws = workbook.getWorksheet(sheetName);
  const header = ws ? findRosterHeaderRow(ws) : null;
  if (!ws || !header) {
    return {
      code: 'no_candidate_sheet',
      message: `"${sheetName}" doesn't have a header row with both STUDENT ID and STUDENT NAME columns.`,
    };
  }

  const rawRows = collectStudentRows(ws, header);
  if (rawRows.length === 0) {
    return {
      code: 'empty_roster',
      message: `"${sheetName}" has a header row but no student rows under it.`,
    };
  }

  const keyCounts = new Map<string, number>();
  const students: RosterStudent[] = rawRows.map((r) => {
    const studentId = cellText(r.studentId).trim();
    const studentIdKey = normalizeIdForMatch(r.studentId, idDigits) ?? studentId;
    keyCounts.set(studentIdKey, (keyCounts.get(studentIdKey) ?? 0) + 1);
    return {
      sl: (r.sl as string | number | null) ?? null,
      studentId,
      studentIdKey,
      studentName: cellText(r.studentName).trim(),
      row: r.row,
    };
  });

  const duplicateIds = [...keyCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key);

  return { sheetName, headerRow: header.row, students, duplicateIds };
}

// What Setup hands upward once a workbook is confirmed (step.md 12.1's
// mode choice, carried through App.tsx to Results for 12.5-12.8's export).
// `workbookBytes` is the ORIGINAL upload, byte for byte, and must never be
// mutated — Results reloads a fresh `ExcelJS.Workbook` from it on every
// export (plan.md §17's "always rebuilt from the originally uploaded
// bytes"), which is what makes exporting twice in one session idempotent
// rather than accumulating sheets: each export starts from the same
// pristine bytes, so a name that collided on the first export collides
// identically, and consistently, on the second.
export interface RosterUpload {
  fileName: string;
  workbookBytes: ArrayBuffer;
  roster: ParsedRoster;
}
