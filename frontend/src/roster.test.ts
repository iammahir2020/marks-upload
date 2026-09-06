import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  analyzeWorkbook,
  canonicalKey,
  findRosterHeaderRow,
  hasExamSignature,
  isRosterError,
  normalizeIdForMatch,
  parseRosterSheet,
} from './roster';

// Builds workbooks in memory rather than from a fixture file — deliberate,
// per step.md step 12's own Test section: a real class roster carries real
// student names and must never be committed. Every case below stands in
// for a real workbook shape without any real student's data anywhere near
// the repo.

function rosterWorkbook(rows: (string | number | null)[][] = [
  ['SL', 'STUDENT ID', 'STUDENT NAME'],
  [1, '1722112', 'Monem Tazwar'],
  [2, '2130643', 'Salman Noor'],
]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  rows.forEach((r) => ws.addRow(r));
  return wb;
}

function addExamSheet(
  wb: ExcelJS.Workbook,
  name: string,
  rows: (string | number | null)[][] = [
    ['SL', 'STUDENT ID', 'STUDENT NAME', 'Q1', 'Total', 'Serial'],
    [1, '1722112', 'Monem Tazwar', 5, 5, 1],
  ],
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name);
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

async function roundTrip(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  return back;
}

describe('canonicalKey', () => {
  it('collapses case and punctuation variants to the same key', () => {
    expect(canonicalKey('Student ID')).toBe('STUDENTID');
    expect(canonicalKey('STUDENT  ID')).toBe('STUDENTID');
    expect(canonicalKey('student_id')).toBe('STUDENTID');
    expect(canonicalKey('StudentID')).toBe('STUDENTID');
  });

  it('is empty for blank/nullish values', () => {
    expect(canonicalKey(null)).toBe('');
    expect(canonicalKey(undefined)).toBe('');
    expect(canonicalKey('')).toBe('');
  });

  it('unwraps ExcelJS rich text and hyperlink cell shapes', () => {
    expect(canonicalKey({ richText: [{ text: 'Student' }, { text: ' ID' }] })).toBe('STUDENTID');
    expect(canonicalKey({ text: 'Student ID', hyperlink: 'x' })).toBe('STUDENTID');
  });
});

describe('findRosterHeaderRow', () => {
  it('finds the header on row 1', () => {
    const wb = rosterWorkbook();
    const match = findRosterHeaderRow(wb.getWorksheet('data')!);
    expect(match?.row).toBe(1);
    expect(match?.columns.get('STUDENTID')).toBe(2);
    expect(match?.columns.get('STUDENTNAME')).toBe(3);
  });

  it('finds the header below a title row', () => {
    const wb = rosterWorkbook([
      ['CSE211L Section 1 — Fall 2026'],
      [],
      ['SL', 'STUDENT ID', 'STUDENT NAME'],
      [1, '1722112', 'Monem Tazwar'],
    ]);
    const match = findRosterHeaderRow(wb.getWorksheet('data')!);
    expect(match?.row).toBe(3);
  });

  it('returns null when no row has both required columns', () => {
    const wb = rosterWorkbook([['SL', 'STUDENT ID'], [1, '1722112']]);
    expect(findRosterHeaderRow(wb.getWorksheet('data')!)).toBeNull();
  });

  it('does not look past the scan limit', () => {
    const rows: (string | number | null)[][] = Array.from({ length: 25 }, (_, i) => [`filler ${i}`]);
    rows.push(['SL', 'STUDENT ID', 'STUDENT NAME']);
    const wb = rosterWorkbook(rows);
    expect(findRosterHeaderRow(wb.getWorksheet('data')!)).toBeNull();
  });
});

describe('hasExamSignature', () => {
  it('is true only when Total, a Q<n> column, and Serial are all present', () => {
    const cols = new Map([['TOTAL', 1], ['Q1', 2], ['SERIAL', 3]]);
    expect(hasExamSignature(cols)).toBe(true);
  });

  it('is false when Serial is missing (an accumulated class-list summary)', () => {
    // The instructor's actual stated workflow: SL | STUDENT ID | STUDENT NAME
    // | Q1 | Q2 | Mid | Total — no Serial column.
    const cols = new Map([['TOTAL', 1], ['Q1', 2], ['Q2', 3], ['MID', 4]]);
    expect(hasExamSignature(cols)).toBe(false);
  });

  it('is false when there is no Q<n> column', () => {
    const cols = new Map([['TOTAL', 1], ['SERIAL', 2], ['MARKS', 3]]);
    expect(hasExamSignature(cols)).toBe(false);
  });

  it('does not match a column that merely contains Q, like "QUIZ1"', () => {
    const cols = new Map([['TOTAL', 1], ['SERIAL', 2], ['QUIZ1', 3]]);
    expect(hasExamSignature(cols)).toBe(false);
  });

  // A sheet this app writes headers its Total column "Total (20)" (the
  // max mark shown alongside it), which canonicalizes to "TOTAL20" — an
  // exact 'TOTAL' match would stop recognizing a sheet THIS APP WROTE as
  // exam-shaped on a later re-upload, reopening the exact misdetection
  // the exclusion rule exists to prevent (a written exam sheet also has
  // STUDENT NAME, per step.md 12.5's decision).
  it('still matches when Total carries its max mark, e.g. "Total (20)"', () => {
    const cols = new Map([['TOTAL20', 1], ['Q15', 2], ['SERIAL', 3]]);
    expect(hasExamSignature(cols)).toBe(true);
  });

  it('does not let a real column starting with "Total" through, e.g. "Total Marks Trend"', () => {
    const cols = new Map([['TOTALMARKSTREND', 1], ['Q1', 2], ['SERIAL', 3]]);
    expect(hasExamSignature(cols)).toBe(false);
  });
});

describe('normalizeIdForMatch', () => {
  it('left-pads a short all-digit id to idDigits', () => {
    expect(normalizeIdForMatch(212345, 7)).toBe('0212345');
    expect(normalizeIdForMatch('212345', 7)).toBe('0212345');
  });

  it('leaves an id already at idDigits length unchanged', () => {
    expect(normalizeIdForMatch('1722112', 7)).toBe('1722112');
  });

  it('returns null for blank input', () => {
    expect(normalizeIdForMatch('', 7)).toBeNull();
    expect(normalizeIdForMatch(null, 7)).toBeNull();
  });

  it('leaves a non-numeric id as-is', () => {
    expect(normalizeIdForMatch('12?4567', 7)).toBe('12?4567');
  });
});

describe('analyzeWorkbook', () => {
  it('picks the only roster-shaped sheet', async () => {
    const wb = await roundTrip(rosterWorkbook());
    const result = analyzeWorkbook(wb);
    expect(result.chosenSheetName).toBe('data');
    expect(result.ambiguous).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].studentCount).toBe(2);
  });

  it('excludes a sheet that has the full exam signature', async () => {
    const wb = rosterWorkbook();
    addExamSheet(wb, 'Quiz 1');
    const back = await roundTrip(wb);
    const result = analyzeWorkbook(back);
    expect(result.chosenSheetName).toBe('data');
    expect(result.candidates.map((c) => c.sheetName)).toEqual(['data']);
  });

  it('still excludes the exam sheet after its tab is dragged to the front', async () => {
    // Reproduces the exact adversarial case plan.md §17 documents: since
    // exam sheets carry STUDENT NAME, an exam sheet is itself a valid
    // roster shape. If position were consulted before the exclusion, this
    // would wrongly resolve to "Quiz 1". It must not.
    const wb = rosterWorkbook();
    addExamSheet(wb, 'Quiz 1');
    let back = await roundTrip(wb);

    // Move "Quiz 1" to the front by rebuilding a workbook with that order.
    const reordered = new ExcelJS.Workbook();
    for (const name of ['Quiz 1', 'data']) {
      const src = back.getWorksheet(name)!;
      const dst = reordered.addWorksheet(name);
      src.eachRow({ includeEmpty: true }, (row, r) => {
        row.eachCell({ includeEmpty: true }, (cell, c) => {
          dst.getCell(r, c).value = cell.value;
        });
      });
    }
    back = await roundTrip(reordered);

    expect(back.worksheets[0].name).toBe('Quiz 1'); // sanity: reorder worked
    const result = analyzeWorkbook(back);
    expect(result.chosenSheetName).toBe('data');
    expect(result.ambiguous).toBe(false);
  });

  it('survives a class list that has accumulated quiz/mid columns', async () => {
    const wb = rosterWorkbook([
      ['SL', 'STUDENT ID', 'STUDENT NAME', 'Quiz 1', 'Quiz 2', 'Mid', 'Total'],
      [1, '1722112', 'Monem Tazwar', 14.5, 12, 28, 54.5],
    ]);
    const back = await roundTrip(wb);
    const result = analyzeWorkbook(back);
    expect(result.chosenSheetName).toBe('data');
  });

  it('breaks a tie between two roster-shaped sheets using first-visible order', async () => {
    const wb = rosterWorkbook();
    const other = wb.addWorksheet('section 2');
    other.addRow(['SL', 'Student_ID', 'student name']);
    other.addRow([1, '2531794', 'Adnan Faisal']);
    const back = await roundTrip(wb);

    const result = analyzeWorkbook(back);
    expect(result.candidates.map((c) => c.sheetName).sort()).toEqual(['data', 'section 2']);
    expect(result.chosenSheetName).toBe('data'); // "data" is first-visible
    expect(result.ambiguous).toBe(false);
  });

  it('is ambiguous when two roster-shaped sheets exist and neither is first-visible', async () => {
    const wb = new ExcelJS.Workbook();
    const cover = wb.addWorksheet('Cover');
    cover.addRow(['Course info, not a roster']);
    const a = wb.addWorksheet('Section 1');
    a.addRow(['SL', 'STUDENT ID', 'STUDENT NAME']);
    a.addRow([1, '1111111', 'A']);
    const b = wb.addWorksheet('Section 2');
    b.addRow(['SL', 'STUDENT ID', 'STUDENT NAME']);
    b.addRow([1, '2222222', 'B']);
    const back = await roundTrip(wb);

    const result = analyzeWorkbook(back);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toHaveLength(2);
  });

  it('returns no candidates for a workbook with nothing roster-shaped', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(['just', 'some', 'data']);
    const back = await roundTrip(wb);
    const result = analyzeWorkbook(back);
    expect(result.candidates).toHaveLength(0);
    expect(result.chosenSheetName).toBeNull();
    expect(result.ambiguous).toBe(false);
  });

  it('surfaces exam-shaped sheets for a manual pick when nothing else survives', async () => {
    const wb = new ExcelJS.Workbook();
    addExamSheet(wb, 'Quiz 1');
    const back = await roundTrip(wb);
    const result = analyzeWorkbook(back);
    expect(result.candidates.map((c) => c.sheetName)).toEqual(['Quiz 1']);
    expect(result.chosenSheetName).toBeNull();
    expect(result.ambiguous).toBe(true);
  });
});

describe('parseRosterSheet', () => {
  it('parses students with verbatim ids and comparison keys', async () => {
    const back = await roundTrip(rosterWorkbook());
    const result = parseRosterSheet(back, 'data', 7);
    expect(isRosterError(result)).toBe(false);
    if (isRosterError(result)) throw new Error('unexpected error');
    expect(result.students).toEqual([
      { sl: 1, row: 2, studentId: '1722112', studentIdKey: '1722112', studentName: 'Monem Tazwar' },
      { sl: 2, row: 3, studentId: '2130643', studentIdKey: '2130643', studentName: 'Salman Noor' },
    ]);
    expect(result.duplicateIds).toEqual([]);
  });

  it('recovers a leading zero lost to numeric storage', async () => {
    const wb = rosterWorkbook([
      ['SL', 'STUDENT ID', 'STUDENT NAME'],
      [1, 212345, 'Someone'], // stored as a NUMBER, not text — Excel's own behavior
    ]);
    const back = await roundTrip(wb);
    const result = parseRosterSheet(back, 'data', 7);
    if (isRosterError(result)) throw new Error('unexpected error');
    expect(result.students[0].studentId).toBe('212345'); // written back verbatim
    expect(result.students[0].studentIdKey).toBe('0212345'); // padded for matching
  });

  it('flags duplicate ids within the roster', async () => {
    const wb = rosterWorkbook([
      ['SL', 'STUDENT ID', 'STUDENT NAME'],
      [1, '1722112', 'A'],
      [2, '1722112', 'B'],
    ]);
    const back = await roundTrip(wb);
    const result = parseRosterSheet(back, 'data', 7);
    if (isRosterError(result)) throw new Error('unexpected error');
    expect(result.duplicateIds).toEqual(['1722112']);
  });

  it('errors when the sheet has no candidate header', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('data').addRow(['nope']);
    const back = await roundTrip(wb);
    const result = parseRosterSheet(back, 'data', 7);
    expect(isRosterError(result)).toBe(true);
    if (!isRosterError(result)) throw new Error('expected error');
    expect(result.code).toBe('no_candidate_sheet');
  });

  it('errors when the sheet is missing entirely', async () => {
    const back = await roundTrip(rosterWorkbook());
    const result = parseRosterSheet(back, 'nope', 7);
    expect(isRosterError(result)).toBe(true);
    if (!isRosterError(result)) throw new Error('expected error');
    expect(result.code).toBe('no_candidate_sheet');
  });

  it('errors on a header with no data rows beneath it', async () => {
    const wb = rosterWorkbook([['SL', 'STUDENT ID', 'STUDENT NAME']]);
    const back = await roundTrip(wb);
    const result = parseRosterSheet(back, 'data', 7);
    expect(isRosterError(result)).toBe(true);
    if (!isRosterError(result)) throw new Error('expected error');
    expect(result.code).toBe('empty_roster');
  });

  it('skips a row whose STUDENT ID cell is blank', async () => {
    const wb = rosterWorkbook([
      ['SL', 'STUDENT ID', 'STUDENT NAME'],
      [1, '1722112', 'A'],
      [2, '', 'No id, skip me'],
      [3, '2130643', 'B'],
    ]);
    const back = await roundTrip(wb);
    const result = parseRosterSheet(back, 'data', 7);
    if (isRosterError(result)) throw new Error('unexpected error');
    expect(result.students).toHaveLength(2);
  });

  // A skipped blank-ID row means student i is NOT generally at sheet row
  // headerRow + 1 + i — `row` has to be the sheet's own row number, or
  // anything writing back into this exact sheet later (the opt-in totals
  // column, step.md 12.13) lands a value next to the WRONG name the
  // moment a roster has any gap at all. Written as the attack: assert the
  // real row survives the gap, not just that `row` exists.
  it("carries each student's REAL sheet row, surviving a skipped blank row in between", async () => {
    const wb = rosterWorkbook([
      ['SL', 'STUDENT ID', 'STUDENT NAME'],
      [1, '1722112', 'A'], // row 2
      [2, '', 'skip me'], // row 3 — blank, skipped
      [3, '2130643', 'B'], // row 4, NOT row 3
    ]);
    const back = await roundTrip(wb);
    const result = parseRosterSheet(back, 'data', 7);
    if (isRosterError(result)) throw new Error('unexpected error');
    expect(result.students.map((s) => s.row)).toEqual([2, 4]);
  });
});
