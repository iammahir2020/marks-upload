import { describe, expect, it } from 'vitest';
import { crossCheck, isLegalValue, normalizeSerial, sumCheck } from './validateMarks';
import type { StudentRecord } from './types';

function record(overrides: Partial<StudentRecord>): StudentRecord {
  return {
    id: 'existing-1',
    studentId: '1912345',
    serial: '7',
    questions: [],
    total: null,
    confirmed: true,
    capturedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeSerial', () => {
  it('strips leading zeros so 2, 02, 002 compare equal', () => {
    expect(normalizeSerial('2')).toBe('2');
    expect(normalizeSerial('02')).toBe('2');
    expect(normalizeSerial('002')).toBe('2');
  });

  it('treats an all-zero serial as "0", not empty', () => {
    expect(normalizeSerial('0')).toBe('0');
    expect(normalizeSerial('000')).toBe('0');
  });

  it('treats blank/whitespace as null', () => {
    expect(normalizeSerial('')).toBeNull();
    expect(normalizeSerial('   ')).toBeNull();
  });

  it('passes through null', () => {
    expect(normalizeSerial(null)).toBeNull();
  });
});

describe('isLegalValue', () => {
  it('accepts every half-mark step within range', () => {
    for (let v = 0; v <= 5; v += 0.5) {
      expect(isLegalValue(v, 5)).toBe(true);
    }
  });

  it('rejects a non-half-mark step (4.25)', () => {
    expect(isLegalValue(4.25, 5)).toBe(false);
  });

  it('rejects a negative value (-1)', () => {
    expect(isLegalValue(-1, 5)).toBe(false);
  });

  it('rejects a value above max (5.5 on a 5-mark question)', () => {
    expect(isLegalValue(5.5, 5)).toBe(false);
  });
});

describe('sumCheck', () => {
  it('matches when questions sum to the printed total, half marks included', () => {
    const result = sumCheck(
      [
        { q: 1, value: 3 },
        { q: 2, value: 2.5 },
        { q: 3, value: 1 },
        { q: 4, value: 0 },
        { q: 5, value: 4.5 },
      ],
      11,
    );
    expect(result.computedSum).toBe(11);
    expect(result.matches).toBe(true);
  });

  it('flags a mismatch — the case the check exists for', () => {
    const result = sumCheck(
      [
        { q: 1, value: 4.5 },
        { q: 2, value: 5 },
      ],
      9,
    );
    expect(result.computedSum).toBe(9.5);
    expect(result.matches).toBe(false);
  });

  it('treats an unfilled total as a non-match rather than throwing', () => {
    const result = sumCheck([{ q: 1, value: 3 }], null);
    expect(result.matches).toBe(false);
  });

  it('treats a blank (unread) question as 0 in the sum', () => {
    const result = sumCheck(
      [
        { q: 1, value: null },
        { q: 2, value: 5 },
      ],
      5,
    );
    expect(result.computedSum).toBe(5);
    expect(result.matches).toBe(true);
  });
});

// plan.md §10's identity cross-check table, run as the parameterized test
// step.md's step 7 Test section calls for — all five rows.
describe('crossCheck — plan.md §10 table', () => {
  it('same serial, same ID: blocks as a duplicate', () => {
    const existing = record({ serial: '07', studentId: '1912345' });
    const result = crossCheck({ serial: '7', studentId: '1912345' }, [existing]);
    expect(result.action).toBe('block');
    expect(result.conflicts).toEqual([{ reason: 'duplicate', record: existing }]);
  });

  it('same serial, different ID: warns and surfaces both records', () => {
    const existing = record({ serial: '07', studentId: '1912345' });
    const result = crossCheck({ serial: '7', studentId: '1999999' }, [existing]);
    expect(result.action).toBe('warn');
    expect(result.conflicts).toEqual([{ reason: 'serial-mismatch', record: existing }]);
  });

  it('same ID, different serial: warns and surfaces both records', () => {
    const existing = record({ serial: '07', studentId: '1912345' });
    const result = crossCheck({ serial: '9', studentId: '1912345' }, [existing]);
    expect(result.action).toBe('warn');
    expect(result.conflicts).toEqual([{ reason: 'id-mismatch', record: existing }]);
  });

  it('both fields empty: blocks until one is entered', () => {
    const result = crossCheck({ serial: null, studentId: null }, []);
    expect(result.action).toBe('block');
    expect(result.conflicts).toEqual([]);
  });

  it('only one field filled: allows, marked unverified', () => {
    const result = crossCheck({ serial: '12', studentId: null }, []);
    expect(result.action).toBe('allow');
    expect(result.unverified).toBe(true);
  });

  it('both fields filled with no conflicts: allows, verified', () => {
    const result = crossCheck({ serial: '12', studentId: '1900001' }, []);
    expect(result.action).toBe('allow');
    expect(result.unverified).toBe(false);
  });
});
