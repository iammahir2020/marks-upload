// Pure validation logic for the Review screen (step.md step 7): the sum
// check, the legal-value check, serial normalization, and the identity
// cross-check from plan.md §10. Kept dependency-free so the cross-check
// table can run as a parameterized unit test with no DOM (step 7's Test
// section calls this "the heart of the suite").
import type { QuestionValue, StudentRecord } from './types';

// "2", "02", "002" must compare equal (plan.md §10).
export function normalizeSerial(serial: string | null): string | null {
  if (serial === null) return null;
  const trimmed = serial.trim();
  if (trimmed === '') return null;
  const stripped = trimmed.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped; // an all-zero serial is "0", not empty
}

// A question value must be a multiple of 0.5 within 0..max — enforced here
// on manual edit so a typo during correction can't slip through (plan.md
// §10), mirroring the same check the backend already runs on Gemini output.
export function isLegalValue(value: number, max: number): boolean {
  if (!Number.isFinite(value) || value < 0 || value > max) return false;
  const doubled = value * 2;
  return Math.abs(doubled - Math.round(doubled)) < 1e-9;
}

// One parse rule for every editable mark-or-total field, shared by the two
// screens that edit them (issues.md #4 / N6).
//
// Both screens previously validated the per-question inputs and left Total
// unchecked, so `Number("abc")` -> NaN was written to a `confirmed: true`
// record — IndexedDB uses structured clone, which preserves NaN faithfully,
// so it really was stored and really did reach the export. Two components
// applying "the same" rule by each writing it out is how they drifted apart
// in the first place, hence one function rather than two copies.
//
// A blank field is valid and means "not filled in" — flag, never guess. It
// is the caller's job to know that a blank Total simply fails the sum check
// rather than blocking the save.
export interface FieldParse {
  value: number | null;
  error: string | null;
}

export function parseMarkField(raw: string, max: number): FieldParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, error: null };
  const value = Number(trimmed);
  // Number("") is 0 and Number(" ") is 0, which is why the blank check is
  // first; Number("abc") is NaN and Number("1e999") is Infinity, which is
  // why this tests isFinite rather than just !isNaN.
  if (!Number.isFinite(value) || !isLegalValue(value, max)) {
    return { value: null, error: `Must be a multiple of 0.5 between 0 and ${max}.` };
  }
  return { value, error: null };
}

// A student ID is either absent (valid but unverified — plan.md §10) or a
// complete run of exactly `idDigits` digits. Anything else is a partial
// read the instructor has not finished correcting.
//
// The case this exists for: both recognizers return "?" for a position they
// could not read, by contract, so a flagged scan pre-fills the field with
// something like "12?4567". Nothing stopped that being confirmed and
// exported verbatim (issues.md N5).
// A serial identifies a script's position in the pile. 1..9999 is far more
// than any real class, and `results.ts` sorts by `Number(serial)`, so a
// non-numeric one has no defined place in the exported table.
//
// The other half of issues.md N21: `marks.py`'s `validate_serial` applies
// the identical rule to what a recognizer returns, and this applies it to
// what the instructor types. Previously neither side checked, so a serial
// was the one identity field nothing validated anywhere. Keep the two in
// step — same length, same digits-only rule.
export const MAX_SERIAL_DIGITS = 4;

export function isValidSerial(serial: string | null): boolean {
  if (serial === null) return false;
  const trimmed = serial.trim();
  return (
    trimmed.length > 0 && trimmed.length <= MAX_SERIAL_DIGITS && /^[0-9]+$/.test(trimmed)
  );
}

export function isCompleteId(studentId: string | null, idDigits: number): boolean {
  if (studentId === null) return false;
  const trimmed = studentId.trim();
  return trimmed.length === idDigits && /^[0-9]+$/.test(trimmed);
}

export interface SumCheckResult {
  computedSum: number;
  matches: boolean;
}

// Derived on every render, never stored — a stored pass/fail flag would go
// stale behind an edit (CLAUDE.md "Derive, don't store, the sum check").
export function sumCheck(questions: QuestionValue[], total: number | null): SumCheckResult {
  const computedSum = questions.reduce((sum, q) => sum + (q.value ?? 0), 0);
  return {
    computedSum,
    matches: total !== null && Math.abs(computedSum - total) < 1e-9,
  };
}

export interface CrossCheckConflict {
  reason: 'duplicate' | 'serial-mismatch' | 'id-mismatch';
  record: StudentRecord;
}

export interface CrossCheckResult {
  action: 'block' | 'warn' | 'allow';
  unverified: boolean;
  conflicts: CrossCheckConflict[];
}

// Implements plan.md §10's identity cross-check table exactly. Callers pass
// only the records already known to share this candidate's serial or
// student ID (db.ts's by-serial/by-studentId indexes) — this function does
// the comparing, not the fetching.
export function crossCheck(
  candidate: { studentId: string | null; serial: string | null },
  existingRecords: StudentRecord[],
): CrossCheckResult {
  const candidateSerial = normalizeSerial(candidate.serial);
  const candidateId = candidate.studentId?.trim() || null;

  if (!candidateSerial && !candidateId) {
    return { action: 'block', unverified: false, conflicts: [] };
  }

  const conflicts: CrossCheckConflict[] = [];
  for (const existing of existingRecords) {
    const existingSerial = normalizeSerial(existing.serial);
    const sameSerial = candidateSerial !== null && existingSerial === candidateSerial;
    const sameId = candidateId !== null && existing.studentId === candidateId;

    if (sameSerial && sameId) {
      conflicts.push({ reason: 'duplicate', record: existing });
    } else if (sameSerial) {
      conflicts.push({ reason: 'serial-mismatch', record: existing });
    } else if (sameId) {
      conflicts.push({ reason: 'id-mismatch', record: existing });
    }
  }

  if (conflicts.some((c) => c.reason === 'duplicate')) {
    return { action: 'block', unverified: false, conflicts };
  }
  if (conflicts.length > 0) {
    return { action: 'warn', unverified: false, conflicts };
  }

  return { action: 'allow', unverified: !candidateSerial || !candidateId, conflicts: [] };
}
