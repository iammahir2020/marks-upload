import { describe, expect, it } from 'vitest';
import { buildExamSheet } from './examSheet';
import type { ParsedRoster } from './roster';
import type { QuizConfig, StudentRecord } from './types';

const config: QuizConfig = {
  quizName: 'Quiz 1',
  idDigits: 7,
  questions: [
    { q: 1, max: 5 },
    { q: 2, max: 5 },
  ],
  totalMax: 10,
};

const roster: ParsedRoster = {
  sheetName: 'data',
  headerRow: 1,
  students: [
    { sl: 1, row: 1 + 1, studentId: '1722112', studentIdKey: '1722112', studentName: 'Monem Tazwar' },
    { sl: 2, row: 2 + 1, studentId: '2130643', studentIdKey: '2130643', studentName: 'Salman Noor' },
  ],
  duplicateIds: [],
};

function record(overrides: Partial<StudentRecord>): StudentRecord {
  return {
    id: crypto.randomUUID(),
    studentId: '1722112',
    serial: '1',
    questions: [
      { q: 1, value: 5 },
      { q: 2, value: 4.5 },
    ],
    total: 9.5,
    confirmed: true,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildExamSheet', () => {
  it('gives a scanned roster student their full row, in roster order', () => {
    const result = buildExamSheet(roster, [record({})], config);
    expect(result.rosterRows).toEqual([
      {
        sl: 1,
        studentId: '1722112',
        studentName: 'Monem Tazwar',
        questions: [5, 4.5],
        total: 9.5,
        serial: '1',
      },
      {
        sl: 2,
        studentId: '2130643',
        studentName: 'Salman Noor',
        questions: [null, null],
        total: null,
        serial: null,
      },
    ]);
  });

  it('never writes 0 for an unscanned student — genuinely null', () => {
    const result = buildExamSheet(roster, [], config);
    for (const row of result.rosterRows) {
      expect(row.total).toBeNull();
      expect(row.questions).toEqual([null, null]);
    }
  });

  it('appends a scanned script matching no roster student, never dropping it', () => {
    const stray = record({ studentId: '9999999' });
    const result = buildExamSheet(roster, [stray], config);
    expect(result.unmatchedRows).toHaveLength(1);
    expect(result.unmatchedRows[0].studentId).toBe('9999999');
    expect(result.rosterRows.every((r) => r.total === null)).toBe(true);
  });

  it('treats a record with no studentId at all as unmatched (matching is on ID only)', () => {
    const serialOnly = record({ studentId: null, serial: '3' });
    const result = buildExamSheet(roster, [serialOnly], config);
    expect(result.unmatchedRows).toHaveLength(1);
    expect(result.unmatchedRows[0].studentId).toBe('');
    expect(result.unmatchedRows[0].serial).toBe('3');
  });

  it('matches a short numeric id against a roster id via the same normalization roster.ts uses', () => {
    // A record's studentId came back as "212345" (six digits) and the
    // roster's own key for that student is "0212345" (seven, left-padded)
    // — the same recovery reproduced in roster.test.ts against Excel's own
    // numeric-storage behavior.
    const paddedRoster: ParsedRoster = {
      ...roster,
      students: [{ sl: 3, row: 3 + 1, studentId: '212345', studentIdKey: '0212345', studentName: 'Someone' }],
    };
    const result = buildExamSheet(paddedRoster, [record({ studentId: '212345' })], config);
    expect(result.rosterRows[0].total).toBe(9.5);
    expect(result.unmatchedRows).toHaveLength(0);
  });

  it('flags a roster student matched by more than one record, without dropping either', () => {
    const first = record({ capturedAt: '2026-01-01T00:00:00.000Z', total: 5 });
    const second = record({ capturedAt: '2026-01-02T00:00:00.000Z', total: 9.5 });
    const result = buildExamSheet(roster, [first, second], config);

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].studentIdKey).toBe('1722112');
    expect(result.duplicates[0].records).toHaveLength(2);
    // The row itself still has to contain SOMETHING for the sheet — the
    // most recently confirmed record wins for content, but Phase D (not
    // this function) is what actually blocks the export over this.
    expect(result.rosterRows[0].total).toBe(9.5);
  });

  it('carries the total and serial through untouched, verbatim', () => {
    const result = buildExamSheet(roster, [record({ serial: '007', total: 9.5 })], config);
    expect(result.rosterRows[0].serial).toBe('007');
  });

  // Step.md 12.12 — pre-export coverage: who on the roster has NO matching
  // record at all, as distinct from "matched but blank."
  it('lists a roster student with no matching record as missing', () => {
    const result = buildExamSheet(roster, [record({})], config); // only 1722112 scanned
    expect(result.missingStudents).toEqual([roster.students[1]]); // 2130643, Salman Noor
  });

  it('lists nobody as missing once every roster student has a match', () => {
    const result = buildExamSheet(
      roster,
      [record({ studentId: '1722112' }), record({ studentId: '2130643' })],
      config,
    );
    expect(result.missingStudents).toEqual([]);
  });

  it('does not count a duplicated student as missing', () => {
    const result = buildExamSheet(roster, [record({}), record({})], config); // both scan 1722112
    expect(result.missingStudents).toEqual([roster.students[1]]);
    expect(result.duplicates).toHaveLength(1);
  });
});
