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

// --- Regression tests for the 2026-08-31 audit fixes (issues.md #1 / N19) --

describe('validateConfig — upper bounds', () => {
  const base = { quizName: 'Q', idDigits: 7, questionCount: 2, questionMaxes: [5, 5] };

  it('rejects a question count beyond what a printed grid can hold', () => {
    const result = validateConfig({
      ...base,
      questionCount: 99999999999,
      questionMaxes: [5, 5],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/30 or fewer/);
  });

  it('rejects a non-integer question count with a message, not a crash', () => {
    // Setup.tsx used to feed this straight into `array.length = 5.5`, which
    // throws RangeError and took down the first screen of the app.
    const result = validateConfig({ ...base, questionCount: 5.5 });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/whole number/);
  });

  it('rejects an absurd idDigits', () => {
    expect(validateConfig({ ...base, idDigits: 100000 }).valid).toBe(false);
  });

  it('rejects a per-question max large enough to be an attack rather than a quiz', () => {
    // The client half of issues.md N2: legal_values() on the backend
    // materialises 2*max+1 entries. Bounding it here does not fix the
    // backend, which still needs its own bound.
    const result = validateConfig({ ...base, questionMaxes: [1e9, 5] });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/100 or less/);
  });

  it('still accepts an ordinary quiz', () => {
    expect(validateConfig(base).valid).toBe(true);
  });
});
