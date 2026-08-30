import { describe, expect, it } from 'vitest';
import { sortRecords, unverifiedReason } from './results';
import type { StudentRecord } from './types';

function record(overrides: Partial<StudentRecord>): StudentRecord {
  return {
    id: crypto.randomUUID(),
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
