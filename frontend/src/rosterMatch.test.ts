import { describe, expect, it } from 'vitest';
import { matchAgainstRoster, suggestRosterCandidate } from './rosterMatch';
import type { ParsedRoster } from './roster';

const roster: ParsedRoster = {
  sheetName: 'data',
  headerRow: 1,
  students: [
    { sl: 1, row: 1 + 1, studentId: '1722112', studentIdKey: '1722112', studentName: 'Monem Tazwar' },
    { sl: 2, row: 2 + 1, studentId: '2130643', studentIdKey: '2130643', studentName: 'Salman Noor' },
  ],
  duplicateIds: [],
};

describe('matchAgainstRoster', () => {
  it('reports no-roster when nothing is attached', () => {
    expect(matchAgainstRoster('1722112', 7, null)).toEqual({ status: 'no-roster' });
  });

  it('reports blank for an empty or whitespace-only id', () => {
    expect(matchAgainstRoster('', 7, roster)).toEqual({ status: 'blank' });
    expect(matchAgainstRoster('   ', 7, roster)).toEqual({ status: 'blank' });
    expect(matchAgainstRoster(null, 7, roster)).toEqual({ status: 'blank' });
  });

  it('matches a roster student exactly', () => {
    const result = matchAgainstRoster('1722112', 7, roster);
    expect(result).toEqual({ status: 'matched', student: roster.students[0] });
  });

  it('matches through the same leading-zero recovery roster parsing uses', () => {
    const paddedRoster: ParsedRoster = {
      ...roster,
      students: [{ sl: 1, row: 1 + 1, studentId: '212345', studentIdKey: '0212345', studentName: 'Someone' }],
    };
    expect(matchAgainstRoster('0212345', 7, paddedRoster)).toEqual({
      status: 'matched',
      student: paddedRoster.students[0],
    });
  });

  it('reports not-on-list with no suggestion when nothing is close', () => {
    const result = matchAgainstRoster('9999999', 7, roster);
    expect(result).toEqual({ status: 'not-on-list', suggestion: null });
  });

  it('never treats a partial read ("?" present) as an exact match', () => {
    // Even one that LOOKS like it could resolve to a real student once
    // completed must not be silently accepted as that student.
    const result = matchAgainstRoster('172211?', 7, roster);
    expect(result.status).toBe('not-on-list');
  });

  it('suggests the unique roster student one digit away from a full misread', () => {
    // 1722112 misread as 1722192 (one substituted digit)
    const result = matchAgainstRoster('1722192', 7, roster);
    expect(result).toEqual({
      status: 'not-on-list',
      suggestion: roster.students[0],
    });
  });

  it('offers no suggestion when two roster students are each one digit away', () => {
    const twoClose: ParsedRoster = {
      ...roster,
      students: [
        { sl: 1, row: 1 + 1, studentId: '1111111', studentIdKey: '1111111', studentName: 'A' },
        { sl: 2, row: 2 + 1, studentId: '1111112', studentIdKey: '1111112', studentName: 'B' },
      ],
    };
    // 1111110 is one digit away from BOTH — genuinely ambiguous, no guess.
    const result = matchAgainstRoster('1111110', 7, twoClose);
    expect(result).toEqual({ status: 'not-on-list', suggestion: null });
  });

  it('suggests the unique roster student consistent with a partial read', () => {
    // 3rd digit unread; every other digit narrows it to exactly one student.
    const result = matchAgainstRoster('17221?2', 7, roster);
    expect(result).toEqual({ status: 'not-on-list', suggestion: roster.students[0] });
  });

  it('offers no suggestion when a partial read is consistent with more than one student', () => {
    const ambiguous: ParsedRoster = {
      ...roster,
      students: [
        { sl: 1, row: 1 + 1, studentId: '1000001', studentIdKey: '1000001', studentName: 'A' },
        { sl: 2, row: 2 + 1, studentId: '1000002', studentIdKey: '1000002', studentName: 'B' },
      ],
    };
    const result = matchAgainstRoster('100000?', 7, ambiguous);
    expect(result).toEqual({ status: 'not-on-list', suggestion: null });
  });

  it('offers no suggestion for an id of the wrong length', () => {
    expect(suggestRosterCandidate('172211', 7, roster)).toBeNull(); // 6 digits, not 7
    expect(suggestRosterCandidate('17221123', 7, roster)).toBeNull(); // 8 digits, not 7
  });

  it('offers no suggestion for garbage that is not digits or "?"', () => {
    expect(suggestRosterCandidate('abcdefg', 7, roster)).toBeNull();
  });
});
