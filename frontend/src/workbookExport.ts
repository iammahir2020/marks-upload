// The ExcelJS-touching half of step.md step 12.6/12.7/12.8 (plan.md §17):
// sanitising a sheet name to ExcelJS's own enforced rule set, detecting a
// collision against the uploaded workbook, and writing the exam sheet in.
// examSheet.ts does the matching/shaping with no ExcelJS at all; this
// module is the "SheetWriter" half — it takes an already-loaded `Workbook`
// and an already-built `ExamSheetResult` and never itself decides what
// goes in a cell.
import type { Workbook } from 'exceljs';
import type { ExamSheetResult, ExamSheetRow } from './examSheet';
import type { ParsedRoster } from './roster';
import type { QuizConfig } from './types';

// Excel's own limit. ExcelJS truncates silently past this (with a console
// warning) rather than throwing — sanitizeSheetName truncates itself
// instead, so the caller can show the real final name up front rather
// than discovering it after the fact.
const MAX_SHEET_NAME_LENGTH = 31;

// Verified directly against ExcelJS 4.4.0 (step.md's step 12 header,
// "What was verified before speccing this") rather than assumed from
// Excel's own documented rules: addWorksheet throws on any of these
// characters, on a name whose first or last character is a single quote,
// and on an empty name. `File Upload.md`'s own sanitiser missed the
// apostrophe rule.
const ILLEGAL_CHARS = /[*?:\\/[\]]/g;

export interface SanitizedSheetName {
  name: string;
  // True if the result differs from the trimmed input at all — the signal
  // for "show the instructor the final name" (12.6's own words).
  changed: boolean;
  truncated: boolean;
}

export function sanitizeSheetName(raw: string): SanitizedSheetName {
  const trimmedRaw = raw.trim();
  let name = trimmedRaw.replace(ILLEGAL_CHARS, '');
  name = name.replace(/^'+/, '').replace(/'+$/, '');
  let truncated = false;
  if (name.length > MAX_SHEET_NAME_LENGTH) {
    name = name.slice(0, MAX_SHEET_NAME_LENGTH).replace(/'+$/, '');
    truncated = true;
  }
  return { name, changed: name !== trimmedRaw, truncated };
}

function sheetNameExists(workbook: Workbook, name: string): boolean {
  // ExcelJS itself rejects a duplicate name case-insensitively — verified
  // directly (`DATA` collided with an existing `data`) — so the collision
  // check has to compare the same way, or it would let through a name
  // ExcelJS's own `addWorksheet` then throws on.
  return workbook.worksheets.some((ws) => ws.name.toUpperCase() === name.toUpperCase());
}

export interface SheetCollision {
  collides: boolean;
  // The class-list sheet can never be offered for Overwrite (plan.md §17
  // rule 3) — losing it to a mis-tap because a quiz happened to be named
  // the same as the roster sheet must not be reachable.
  isRosterSheet: boolean;
  // An auto-suffixed name guaranteed not to collide with anything already
  // in the workbook, for the Rename option — never applied unless chosen.
  suggestedRename: string;
}

export function findSheetCollision(
  workbook: Workbook,
  candidateName: string,
  rosterSheetName: string,
): SheetCollision {
  const collides = sheetNameExists(workbook, candidateName);
  if (!collides) {
    return { collides: false, isRosterSheet: false, suggestedRename: candidateName };
  }

  const isRosterSheet = candidateName.toUpperCase() === rosterSheetName.toUpperCase();

  let n = 2;
  let suggestion: string;
  do {
    const suffix = ` (${n})`;
    const base = candidateName.slice(0, MAX_SHEET_NAME_LENGTH - suffix.length);
    suggestion = `${base}${suffix}`;
    n += 1;
  } while (sheetNameExists(workbook, suggestion) && n < 1000);

  return { collides: true, isRosterSheet, suggestedRename: suggestion };
}

function toWorksheetRow(row: ExamSheetRow, config: QuizConfig): Record<string, unknown> {
  return {
    sl: row.sl,
    studentId: row.studentId,
    studentName: row.studentName,
    ...Object.fromEntries(config.questions.map((qc, i) => [`q${qc.q}`, row.questions[i] ?? null])),
    total: row.total,
    serial: row.serial,
  };
}

// Writes the exam sheet into an already-loaded workbook. `overwrite` must
// be pre-decided by the caller (via findSheetCollision + whatever the
// instructor chose) — this function only ever adds one new sheet under
// `sheetName`, removing an existing one of the same name first if told to.
//
// Deliberately does NOT touch the class-list sheet, or anything else in
// the workbook — the only mutation here is "remove a same-named sheet if
// overwriting" plus "add this one." Existing exam sheets are left exactly
// as they were (plan.md §17's own rule).
export function writeExamSheet(
  workbook: Workbook,
  sheetName: string,
  overwrite: boolean,
  result: ExamSheetResult,
  config: QuizConfig,
): void {
  if (overwrite) {
    const existing = workbook.getWorksheet(sheetName);
    if (existing) workbook.removeWorksheet(existing.id);
  }

  const ws = workbook.addWorksheet(sheetName);
  ws.columns = [
    { header: 'SL', key: 'sl', width: 6 },
    { header: 'STUDENT ID', key: 'studentId', width: 14 },
    { header: 'STUDENT NAME', key: 'studentName', width: 24 },
    // The max mark shown alongside each header ("Q1 (5)", "Total (20)")
    // canonicalizes to "Q15"/"TOTAL20" — still matches hasExamSignature's
    // patterns (see its own comment), which is what keeps a workbook this
    // app writes correctly recognized as exam-shaped on a later re-upload.
    ...config.questions.map((qc) => ({ header: `Q${qc.q} (${qc.max})`, key: `q${qc.q}`, width: 10 })),
    { header: `Total (${config.totalMax})`, key: 'total', width: 12 },
    // Kept even for a quiz with no Serial box on its paper (step 16), where
    // every value in it is blank. It is not decoration: roster.ts's
    // hasExamSignature tells an exam sheet this app wrote apart from the
    // class list BY this column, and without it a no-serial exam sheet —
    // which also has STUDENT ID and STUDENT NAME — could be taken for the
    // class list the next time the workbook is loaded.
    { header: 'Serial', key: 'serial', width: 10 },
  ];
  ws.getRow(1).font = { bold: true };

  // Explicit `null` for a blank field, never `0` (step 9's own worst-case
  // warning, unchanged by this new export path) — toWorksheetRow's `?? null`
  // is what makes that hold here too.
  ws.addRows(result.rosterRows.map((r) => toWorksheetRow(r, config)));
  ws.addRows(result.unmatchedRows.map((r) => toWorksheetRow(r, config)));
}

// Step.md 12.13 — the one operation that writes into a sheet the
// instructor owns rather than one this app created, which is why it is
// opt-in (the caller gates this behind a checkbox) rather than automatic.
//
// Takes `roster` and `result` directly rather than pre-zipped arrays, so
// the row-per-student correspondence can't be passed out of sync by a
// caller: `result.rosterRows[i]` always corresponds to `roster.students[i]`
// (buildExamSheet's own guarantee), and each student's `row` — their REAL
// row in this sheet, not `roster.headerRow + 1 + i` — comes from
// `roster.students[i].row` directly. That distinction matters the moment a
// roster has any blank-ID row skipped during parsing; see roster.ts's own
// comment on `RosterStudent.row` for why the arithmetic shortcut is wrong.
//
// Never appends a new row for a student not on the roster (plan.md §17):
// this only ever writes into `roster.students.length` existing rows.
export function writeTotalsColumn(
  workbook: Workbook,
  roster: ParsedRoster,
  columnName: string,
  totalMax: number,
  result: ExamSheetResult,
): void {
  const ws = workbook.getWorksheet(roster.sheetName);
  if (!ws) return; // the caller already validated this sheet exists

  const headerRow = ws.getRow(roster.headerRow);
  // Carries the quiz's own max, same as the exam sheet's own "Total (20)"
  // header — so a glance at the class list shows what the number is out
  // of without opening Setup or the exam sheet itself.
  const headerText = `${columnName} (${totalMax})`;

  // Re-export of the SAME quiz updates the existing column in place rather
  // than adding a second one (12.13's own words) — matched on the EXACT
  // header text, not a canonical/case-insensitive match: renaming the
  // column by hand, or a quiz whose max has genuinely changed since the
  // last export, is treated as no longer "that" column, and a fresh one is
  // added rather than silently overwritten with a different total.
  let targetCol: number | null = null;
  let maxCol = 0;
  headerRow.eachCell((cell, colNumber) => {
    maxCol = Math.max(maxCol, colNumber);
    if (String(cell.value ?? '') === headerText) targetCol = colNumber;
  });
  const col = targetCol ?? maxCol + 1;

  headerRow.getCell(col).value = headerText;
  result.rosterRows.forEach((row, i) => {
    ws.getRow(roster.students[i].row).getCell(col).value = row.total;
  });
}
