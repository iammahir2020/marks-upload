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
