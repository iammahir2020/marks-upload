// Pure logic for the Results screen (step.md step 9.1/9.2). Kept
// dependency-free and separate from the component so sorting and the
// unverified-record rule can be unit-tested without a DOM, matching this
// project's established pattern (validateMarks.ts, validateConfig.ts).
import { isCompleteId, normalizeSerial } from './validateMarks';
import type { StudentRecord } from './types';

// Missing or unparseable sorts last — matches plan.md §11's own Results
// mockup, where the one no-serial row sits at the bottom of the table.
function serialSortKey(serial: string | null): number {
  const normalized = normalizeSerial(serial);
  if (normalized === null) return Infinity;
  const n = Number(normalized);
  return Number.isNaN(n) ? Infinity : n;
}

function idSortKey(studentId: string | null): number {
  if (studentId === null) return Infinity;
  const n = Number(studentId);
  return Number.isNaN(n) ? Infinity : n;
}

// Sorted by serial then student ID (step 9.1) — a fresh array, never
// mutates the input.
export function sortRecords(records: StudentRecord[]): StudentRecord[] {
  return [...records].sort((a, b) => {
    const bySerial = serialSortKey(a.serial) - serialSortKey(b.serial);
    if (bySerial !== 0) return bySerial;
    return idSortKey(a.studentId) - idSortKey(b.studentId);
  });
}

// A record with only one of studentId/serial is valid to save (plan.md
// §10) but unverified — flag it, and say which field is missing, the
// same way plan.md §11's own mockup labels a no-serial row (step 9.2).
// A record can't legitimately have *both* missing (blocked at save time),
// so that combination returns null rather than a reason.
// `idDigits` is optional so existing callers and tests keep working; pass it
// to also catch a PARTIAL id (issues.md N5). Review now blocks a partial id
// at save, so this only surfaces records written before that check existed —
// but those are exactly the ones nothing else would ever flag, and they
// export as a literal "12?4567" into the gradebook.
export function unverifiedReason(record: StudentRecord, idDigits?: number): string | null {
  if (!record.serial && !record.studentId) return null;
  if (!record.serial) return 'no serial';
  if (!record.studentId) return 'no ID';
  if (idDigits !== undefined && !isCompleteId(record.studentId, idDigits)) return 'ID incomplete';
  return null;
}
