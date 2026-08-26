import { describe, expect, it } from 'vitest';
import { validateConfig } from './validateConfig';

const base = {
  quizName: 'CSE211L Quiz 1',
  idDigits: 7,
  questionCount: 5,
  questionMaxes: [5, 5, 5, 5, 5],
};

describe('validateConfig', () => {
  it('accepts a well-formed config and computes totalMax as the sum', () => {
    const result = validateConfig(base);
    expect(result.valid).toBe(true);
    expect(result.config?.totalMax).toBe(25);
    expect(result.config?.questions).toEqual([
      { q: 1, max: 5 },
      { q: 2, max: 5 },
      { q: 3, max: 5 },
      { q: 4, max: 5 },
      { q: 5, max: 5 },
    ]);
  });

  it('sums uneven per-question maxima correctly, not just multiplies', () => {
    const result = validateConfig({ ...base, questionCount: 3, questionMaxes: [5, 10, 2.5] });
    expect(result.valid).toBe(true);
    expect(result.config?.totalMax).toBe(17.5);
  });

  it('rejects zero questions', () => {
    const result = validateConfig({ ...base, questionCount: 0, questionMaxes: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('at least 1'))).toBe(true);
  });

  it('rejects a negative question count', () => {
    const result = validateConfig({ ...base, questionCount: -1, questionMaxes: [] });
    expect(result.valid).toBe(false);
  });

  it('rejects non-numeric (NaN) maxima', () => {
    const result = validateConfig({ ...base, questionMaxes: [5, NaN, 5, 5, 5] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Q2'))).toBe(true);
  });

  it('rejects a zero or negative max on any question', () => {
    const result = validateConfig({ ...base, questionMaxes: [5, 0, 5, 5, -1] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Q2'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Q5'))).toBe(true);
  });

  it('rejects when questionCount and questionMaxes length disagree', () => {
    // question count drives the number of max inputs — a mismatch here
    // means the form's state got out of sync with itself
    const result = validateConfig({ ...base, questionCount: 5, questionMaxes: [5, 5, 5] });
    expect(result.valid).toBe(false);
  });

  it('rejects a blank quiz name', () => {
    const result = validateConfig({ ...base, quizName: '   ' });
    expect(result.valid).toBe(false);
  });

  it('rejects non-integer or zero idDigits', () => {
    expect(validateConfig({ ...base, idDigits: 7.5 }).valid).toBe(false);
    expect(validateConfig({ ...base, idDigits: 0 }).valid).toBe(false);
  });
});
