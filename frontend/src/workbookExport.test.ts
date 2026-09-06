import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { ExamSheetResult } from './examSheet';
import type { ParsedRoster } from './roster';
import { findSheetCollision, sanitizeSheetName, writeExamSheet, writeTotalsColumn } from './workbookExport';
import type { QuizConfig } from './types';

const config: QuizConfig = {
  quizName: 'Quiz 1',
  idDigits: 7,
  questions: [
    { q: 1, max: 5 },
    { q: 2, max: 5 },
  ],
  totalMax: 10,
};

const result: ExamSheetResult = {
  rosterRows: [
    { sl: 1, studentId: '1722112', studentName: 'Monem Tazwar', questions: [5, 4.5], total: 9.5, serial: '1' },
    { sl: 2, studentId: '2130643', studentName: 'Salman Noor', questions: [null, null], total: null, serial: null },
  ],
  unmatchedRows: [
    { sl: null, studentId: '9999999', studentName: '', questions: [5, 5], total: 10, serial: '12' },
  ],
  duplicates: [],
  missingStudents: [],
};

const roster: ParsedRoster = {
  sheetName: 'data',
  headerRow: 1,
  students: [
    { sl: 1, row: 2, studentId: '1722112', studentIdKey: '1722112', studentName: 'Monem Tazwar' },
    { sl: 2, row: 3, studentId: '2130643', studentIdKey: '2130643', studentName: 'Salman Noor' },
  ],
  duplicateIds: [],
};

function rosterWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  ws.addRow(['SL', 'STUDENT ID', 'STUDENT NAME']);
  ws.addRow([1, '1722112', 'Monem Tazwar']);
  ws.addRow([2, '2130643', 'Salman Noor']);
  return wb;
}

async function roundTrip(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  return back;
}

describe('sanitizeSheetName', () => {
  it('leaves an ordinary name alone', () => {
    expect(sanitizeSheetName('Quiz 1')).toEqual({ name: 'Quiz 1', changed: false, truncated: false });
  });

  it('strips every character ExcelJS itself rejects', () => {
    // Verified directly (step 12's own header note): addWorksheet throws
    // on any of these.
    const result = sanitizeSheetName('Quiz: 1/2*3?[4]\\5');
    expect(result.name).toBe('Quiz 1234\\5'.replace('\\5', '5')); // no illegal chars survive
    expect(/[*?:\\/[\]]/.test(result.name)).toBe(false);
    expect(result.changed).toBe(true);
  });

  it('strips a leading or trailing single quote', () => {
    expect(sanitizeSheetName("'Quiz 1'").name).toBe('Quiz 1');
  });

  it('truncates past 31 characters and reports it', () => {
    const long = 'A'.repeat(40);
    const result = sanitizeSheetName(long);
    expect(result.name).toHaveLength(31);
    expect(result.truncated).toBe(true);
    expect(result.changed).toBe(true);
  });

  it('re-strips a trailing quote exposed by truncation', () => {
    const long = 'A'.repeat(30) + "'" + 'B'.repeat(10);
    const result = sanitizeSheetName(long);
    expect(result.name.endsWith("'")).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeSheetName('  Quiz 1  ')).toEqual({ name: 'Quiz 1', changed: false, truncated: false });
  });
});

describe('findSheetCollision', () => {
  it('reports no collision against a fresh name', async () => {
    const wb = await roundTrip(rosterWorkbook());
    const collision = findSheetCollision(wb, 'Quiz 1', 'data');
    expect(collision).toEqual({ collides: false, isRosterSheet: false, suggestedRename: 'Quiz 1' });
  });

  it('detects a collision case-insensitively, matching ExcelJS\'s own rule', async () => {
    const wb = rosterWorkbook();
    wb.addWorksheet('Quiz 1');
    const back = await roundTrip(wb);
    const collision = findSheetCollision(back, 'QUIZ 1', 'data');
    expect(collision.collides).toBe(true);
    expect(collision.suggestedRename).toBe('QUIZ 1 (2)');
  });

  it('flags a collision with the class-list sheet itself as protected', async () => {
    const back = await roundTrip(rosterWorkbook());
    const collision = findSheetCollision(back, 'data', 'data');
    expect(collision.collides).toBe(true);
    expect(collision.isRosterSheet).toBe(true);
  });

  it('suggests a name that itself does not collide, even against several existing sheets', async () => {
    const wb = rosterWorkbook();
    wb.addWorksheet('Quiz 1');
    wb.addWorksheet('Quiz 1 (2)');
    const back = await roundTrip(wb);
    const collision = findSheetCollision(back, 'Quiz 1', 'data');
    expect(collision.suggestedRename).toBe('Quiz 1 (3)');
  });
});

describe('writeExamSheet', () => {
  it('writes a correctly-shaped sheet, blanks genuinely blank', async () => {
    const wb = await roundTrip(rosterWorkbook());
    writeExamSheet(wb, 'Quiz 1', false, result, config);
    const back = await roundTrip(wb);

    expect(back.worksheets.map((w) => w.name)).toEqual(['data', 'Quiz 1']);
    const ws = back.getWorksheet('Quiz 1')!;
    expect(ws.getRow(1).values).toEqual([
      undefined,
      'SL',
      'STUDENT ID',
      'STUDENT NAME',
      'Q1 (5)',
      'Q2 (5)',
      'Total (10)',
      'Serial',
    ]);
    expect(ws.getRow(1).font).toEqual({ bold: true });

    // Scanned roster student — full row. `.values` is typed as
    // `CellValue[] | Record<string, CellValue>` (ExcelJS supports both
    // keyed and positional access), so it's cast to the array form here —
    // this row was written positionally, so it always comes back as one.
    const rowValues = (row: ExcelJS.Row) => (row.values as ExcelJS.CellValue[]).slice(1);
    expect(rowValues(ws.getRow(2))).toEqual([1, '1722112', 'Monem Tazwar', 5, 4.5, 9.5, '1']);
    // Unscanned roster student — genuinely blank cells, not 0.
    const row3 = ws.getRow(2 + 1);
    expect(row3.getCell(6).value).toBeNull(); // Total
    expect(row3.getCell(4).value).toBeNull(); // Q1
    // Unmatched scan, appended below the roster block. `.values`'s sparse
    // array reports `undefined`, not `null`, for a cell explicitly set to
    // null (an ExcelJS quirk, not this code's) — the genuine blank-vs-zero
    // check above already goes through getCell directly for that reason.
    expect(rowValues(ws.getRow(4))).toEqual([undefined, '9999999', '', 5, 5, 10, '12']);
  });

  it('never touches the class-list sheet or any other pre-existing sheet', async () => {
    const wb = rosterWorkbook();
    wb.addWorksheet('Quiz 0').addRow(['already here']);
    const back = await roundTrip(wb);

    writeExamSheet(back, 'Quiz 1', false, result, config);
    const out = await roundTrip(back);

    expect(out.getWorksheet('data')!.rowCount).toBe(3);
    expect(out.getWorksheet('Quiz 0')!.getCell('A1').value).toBe('already here');
  });

  it('overwrites only the named sheet, leaving everything else intact', async () => {
    const wb = rosterWorkbook();
    const old = wb.addWorksheet('Quiz 1');
    old.addRow(['OLD DATA']);
    let back = await roundTrip(wb);

    writeExamSheet(back, 'Quiz 1', true, result, config);
    back = await roundTrip(back);

    expect(back.worksheets.map((w) => w.name)).toEqual(['data', 'Quiz 1']);
    expect(back.getWorksheet('Quiz 1')!.getCell('A1').value).toBe('SL'); // the new header, not "OLD DATA"
    expect(back.getWorksheet('data')!.rowCount).toBe(3);
  });

  it('is idempotent when re-run from the same original bytes: one sheet, not two', async () => {
    // The actual guarantee 12.8 asks for: exporting twice in one session
    // means loading fresh from the ORIGINAL bytes each time, not mutating
    // a workbook instance kept around between exports.
    const originalBytes = await rosterWorkbook().xlsx.writeBuffer();

    const firstExport = new ExcelJS.Workbook();
    await firstExport.xlsx.load(originalBytes);
    writeExamSheet(firstExport, 'Quiz 1', false, result, config);
    const firstOut = await firstExport.xlsx.writeBuffer();

    const secondExport = new ExcelJS.Workbook();
    await secondExport.xlsx.load(originalBytes); // fresh from the SAME original bytes
    writeExamSheet(secondExport, 'Quiz 1', false, result, config);
    const secondOut = await secondExport.xlsx.writeBuffer();

    for (const out of [firstOut, secondOut]) {
      const back = new ExcelJS.Workbook();
      await back.xlsx.load(out);
      expect(back.worksheets.filter((w) => w.name === 'Quiz 1')).toHaveLength(1);
    }
  });
});

describe('writeTotalsColumn', () => {
  it('adds a new column headed with the exam name AND its max mark, one total per roster student', async () => {
    const wb = await roundTrip(rosterWorkbook());
    writeTotalsColumn(wb, roster, 'Quiz 1', config.totalMax, result);
    const back = await roundTrip(wb);

    const ws = back.getWorksheet('data')!;
    expect(ws.getCell('D1').value).toBe('Quiz 1 (10)');
    expect(ws.getCell('D2').value).toBe(9.5); // Monem, row 2
    expect(ws.getCell('D3').value).toBeNull(); // Salman, unscanned — genuinely blank, not 0
  });

  it('never touches STUDENT ID/NAME or any other existing column', async () => {
    const wb = await roundTrip(rosterWorkbook());
    writeTotalsColumn(wb, roster, 'Quiz 1', config.totalMax, result);
    const back = await roundTrip(wb);
    const ws = back.getWorksheet('data')!;
    expect(ws.getCell('B2').value).toBe('1722112');
    expect(ws.getCell('C2').value).toBe('Monem Tazwar');
  });

  it('re-exporting the SAME quiz updates the column in place, not a second one', async () => {
    let wb = await roundTrip(rosterWorkbook());
    writeTotalsColumn(wb, roster, 'Quiz 1', config.totalMax, result);
    wb = await roundTrip(wb);

    const updated: ExamSheetResult = {
      ...result,
      rosterRows: [{ ...result.rosterRows[0], total: 15 }, result.rosterRows[1]],
    };
    writeTotalsColumn(wb, roster, 'Quiz 1', config.totalMax, updated);
    const back = await roundTrip(wb);

    const ws = back.getWorksheet('data')!;
    expect(ws.getRow(1).getCell(5).value).toBeNull(); // no second "Quiz 1 (10)" column at E
    expect(ws.getCell('D2').value).toBe(15); // updated in place
  });

  it('adds a fresh column when the exam name differs, never overwriting a differently-named one', async () => {
    let wb = await roundTrip(rosterWorkbook());
    writeTotalsColumn(wb, roster, 'Quiz 1', config.totalMax, result);
    wb = await roundTrip(wb);

    writeTotalsColumn(wb, roster, 'Quiz 2', config.totalMax, result);
    const back = await roundTrip(wb);
    const ws = back.getWorksheet('data')!;
    expect(ws.getCell('D1').value).toBe('Quiz 1 (10)');
    expect(ws.getCell('E1').value).toBe('Quiz 2 (10)');
  });

  it('adds a fresh column, rather than overwriting, when the SAME exam name has a different max', async () => {
    // A defensible edge case, not a bug: if "Quiz 1" now means something
    // different (a re-edited config), silently overwriting a column that
    // no longer displays the same total would be worse than a second one.
    let wb = await roundTrip(rosterWorkbook());
    writeTotalsColumn(wb, roster, 'Quiz 1', 10, result);
    wb = await roundTrip(wb);

    writeTotalsColumn(wb, roster, 'Quiz 1', 20, result);
    const back = await roundTrip(wb);
    const ws = back.getWorksheet('data')!;
    expect(ws.getCell('D1').value).toBe('Quiz 1 (10)');
    expect(ws.getCell('E1').value).toBe('Quiz 1 (20)');
  });

  it('never appends a new row for a student not on the roster', async () => {
    const wb = await roundTrip(rosterWorkbook());
    writeTotalsColumn(wb, roster, 'Quiz 1', config.totalMax, result);
    const back = await roundTrip(wb);
    // rosterWorkbook() has exactly 2 students (rows 2-3); the unmatched
    // "9999999" script from `result` must not have grown the class list.
    expect(back.getWorksheet('data')!.rowCount).toBe(3);
  });

  // The regression `roster.test.ts` guards at the parsing layer, proven
  // here at the point it would actually cause damage: a class list with a
  // gap must still get each total next to the RIGHT name, not shifted up
  // by however many blank rows came before it.
  it('writes to each student\'s real sheet row, surviving a gap earlier in the roster', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('data');
    ws.addRow(['SL', 'STUDENT ID', 'STUDENT NAME']);
    ws.addRow([1, '1722112', 'Monem Tazwar']); // row 2
    ws.addRow([null, '', '']); // row 3 — blank, a real gap
    ws.addRow([2, '2130643', 'Salman Noor']); // row 4, NOT row 3
    const gappyRoster: ParsedRoster = {
      sheetName: 'data',
      headerRow: 1,
      students: [
        { sl: 1, row: 2, studentId: '1722112', studentIdKey: '1722112', studentName: 'Monem Tazwar' },
        { sl: 2, row: 4, studentId: '2130643', studentIdKey: '2130643', studentName: 'Salman Noor' },
      ],
      duplicateIds: [],
    };

    const back0 = await roundTrip(wb);
    writeTotalsColumn(back0, gappyRoster, 'Quiz 1', config.totalMax, result);
    const back = await roundTrip(back0);

    expect(back.getWorksheet('data')!.getCell('C4').value).toBe('Salman Noor'); // sanity: still there
    expect(back.getWorksheet('data')!.getCell('D2').value).toBe(9.5); // Monem's own row
    expect(back.getWorksheet('data')!.getCell('D4').value).toBeNull(); // Salman's own row — blank, correctly
    expect(back.getWorksheet('data')!.getCell('D3').value).toBeNull(); // the gap row itself, untouched
  });
});
