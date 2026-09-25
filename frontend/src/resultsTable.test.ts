import { describe, expect, it } from 'vitest';
import { sortRecords, unverifiedReason } from './resultsTable';
import type { ParsedRoster } from './roster';
import type { StudentRecord } from './types';

function record(overrides: Partial<StudentRecord>): StudentRecord {
  return {
    id: crypto.randomUUID(),
    assessmentId: 'test-assessment',
    studentId: null,
    serial: null,
    questions: [],
    total: null,
    confirmed: true,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('sortRecords', () => {
  it('sorts by serial ascending', () => {
    const a = record({ serial: '3' });
    const b = record({ serial: '1' });
    const c = record({ serial: '2' });
    expect(sortRecords([a, b, c])).toEqual([b, c, a]);
  });

  it('compares serials numerically, ignoring leading zeros', () => {
    const a = record({ serial: '10' });
    const b = record({ serial: '02' }); // 2, not "02" string-sorted after "10"
    expect(sortRecords([a, b])).toEqual([b, a]);
  });

  it('breaks ties by student ID', () => {
    const a = record({ serial: '1', studentId: '1912350' });
    const b = record({ serial: '1', studentId: '1912301' });
    expect(sortRecords([a, b])).toEqual([b, a]);
  });

  it('sorts a missing serial to the end, matching plan.md §11\'s own mockup', () => {
    const withSerial = record({ serial: '1', studentId: '1912301' });
    const noSerial = record({ serial: null, studentId: '1912377' });
    expect(sortRecords([noSerial, withSerial])).toEqual([withSerial, noSerial]);
  });

  it('does not mutate the input array', () => {
    const a = record({ serial: '2' });
    const b = record({ serial: '1' });
    const input = [a, b];
    sortRecords(input);
    expect(input).toEqual([a, b]);
  });
});

describe('unverifiedReason', () => {
  it('flags a record with no serial', () => {
    const r = record({ serial: null, studentId: '1912377' });
    expect(unverifiedReason(r)).toBe('no serial');
  });

  it('flags a record with no student ID', () => {
    const r = record({ serial: '5', studentId: null });
    expect(unverifiedReason(r)).toBe('no ID');
  });

  it('does not flag a record with both fields present', () => {
    const r = record({ serial: '5', studentId: '1912377' });
    expect(unverifiedReason(r)).toBeNull();
  });
});

// Step 16 (plan.md §21) — no Serial box: an ID is verified by the class list.
describe('unverifiedReason — no Serial box (step 16)', () => {
  const roster: ParsedRoster = {
    sheetName: 'data',
    headerRow: 1,
    students: [{ sl: 1, row: 2, studentId: '1912345', studentIdKey: '1912345', studentName: 'Monem Tazwar' }],
    duplicateIds: [],
  };

  it('is verified when the ID is on the class list, with no serial at all', () => {
    expect(unverifiedReason(record({ studentId: '1912345' }), 7, { roster })).toBeNull();
  });

  it('flags an ID that is not on the class list', () => {
    expect(unverifiedReason(record({ studentId: '1999999' }), 7, { roster })).toBe('not on list');
  });

  it('flags every record when there is no class list, since nothing verified it', () => {
    expect(unverifiedReason(record({ studentId: '1912345' }), 7, { roster: null })).toBe('no list');
  });

  it('still flags a missing or partial ID first', () => {
    expect(unverifiedReason(record({ studentId: null }), 7, { roster })).toBe('no ID');
    expect(unverifiedReason(record({ studentId: '19?2345' }), 7, { roster })).toBe('ID incomplete');
  });

  it('keeps the Serial-box rule unchanged when the option is absent', () => {
    expect(unverifiedReason(record({ studentId: '1912345' }), 7)).toBe('no serial');
  });
});
