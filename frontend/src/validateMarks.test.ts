import { describe, expect, it } from 'vitest';
import {
  crossCheck,
  isCompleteId,
  isValidSerial,
  isLegalValue,
  normalizeSerial,
  parseMarkField,
  sumCheck,
} from './validateMarks';
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

// --- Regression tests for the 2026-08-31 audit fixes -----------------------

describe('parseMarkField — issues.md #4 / N6', () => {
  it('rejects text that Number() turns into NaN', () => {
    // The actual failure: the Total input has no `type`, so "abc" is
    // typeable; Number("abc") is NaN; and IndexedDB's structured clone
    // preserves NaN faithfully, so it really was written to a
    // confirmed:true record and really did reach the Excel export.
    expect(parseMarkField('abc', 5)).toEqual({
      value: null,
      error: 'Must be a multiple of 0.5 between 0 and 5.',
    });
  });

  it('rejects a value that overflows to Infinity rather than storing it', () => {
    expect(parseMarkField('1e999', 5).value).toBeNull();
    expect(parseMarkField('1e999', 5).error).not.toBeNull();
  });

  it('treats blank as "not filled in", never as zero', () => {
    // Exporting a blank as 0 is named in step.md step 9 as the worst
    // possible failure — it reads as a real mark of zero.
    expect(parseMarkField('', 5)).toEqual({ value: null, error: null });
    expect(parseMarkField('   ', 5)).toEqual({ value: null, error: null });
  });

  it('accepts legal half marks and rejects illegal ones', () => {
    expect(parseMarkField('4.5', 5).value).toBe(4.5);
    expect(parseMarkField('4.25', 5).value).toBeNull();
    expect(parseMarkField('7', 5).value).toBeNull();
    expect(parseMarkField('-1', 5).value).toBeNull();
  });
});

describe('isCompleteId — issues.md N5', () => {
  it('rejects an ID still carrying an unread position', () => {
    // Both recognizers return "?" for a position they could not read, by
    // contract. Nothing stopped "12?4567" being confirmed and exported.
    expect(isCompleteId('12?4567', 7)).toBe(false);
  });

  it('rejects a partially retyped ID of the wrong length', () => {
    expect(isCompleteId('19123', 7)).toBe(false);
    expect(isCompleteId('191234567', 7)).toBe(false);
  });

  it('accepts a complete numeric ID, trimmed', () => {
    expect(isCompleteId('1912345', 7)).toBe(true);
    expect(isCompleteId('  1912345  ', 7)).toBe(true);
  });

  it('treats an absent ID as incomplete, not as valid', () => {
    // The caller decides what to do about it: an absent ID is a legitimate
    // unverified save (plan.md §10), a partial one is not.
    expect(isCompleteId(null, 7)).toBe(false);
  });
});

describe('isValidSerial — issues.md N21', () => {
  it('rejects anything that is not a number', () => {
    // The one identity field nothing validated on EITHER side of the wire.
    // results.ts sorts by Number(serial), so a non-numeric serial has no
    // defined place in the exported table.
    for (const bad of ['abc', '7a', '1.5', '-1', '', '   ', '../x']) {
      expect(isValidSerial(bad)).toBe(false);
    }
  });

  it('rejects a serial longer than any real class', () => {
    expect(isValidSerial('9999')).toBe(true);
    expect(isValidSerial('10000')).toBe(false);
  });

  it('keeps leading zeros — "07" is what is on the paper', () => {
    expect(isValidSerial('07')).toBe(true);
  });

  it('treats an absent serial as invalid, leaving the caller to decide', () => {
    // An absent serial is a legitimate unverified save; a malformed one is
    // not. Same shape as isCompleteId.
    expect(isValidSerial(null)).toBe(false);
  });
});
