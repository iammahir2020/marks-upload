// Exam-sheet row building (step.md step 12.5, plan.md §17). Pure —
// operates on plain data only (no ExcelJS at all), matching this project's
// established pattern (validateMarks.ts, resultsTable.ts, roster.ts). The
// ExcelJS-touching side — sanitising a sheet name, resolving a name
// collision, and actually writing the rows into a workbook — is
// `workbookExport.ts`; kept separate so the matching rule here is testable
// with plain objects and nothing else.
import { normalizeIdForMatch, type ParsedRoster, type RosterStudent } from './roster';
import type { QuizConfig, StudentRecord } from './types';

export interface ExamSheetRow {
  sl: string | number | null;
  studentId: string;
  studentName: string;
  // Aligned to config.questions' own order — index i is config.questions[i].
  questions: (number | null)[];
  total: number | null;
  serial: string | null;
}

export interface DuplicateMatch {
  studentIdKey: string;
  studentId: string; // the roster's own verbatim id, for display
  studentName: string;
  records: StudentRecord[]; // 2+ confirmed records that all matched this one roster student
}

export interface ExamSheetResult {
  // One row per roster student, in roster order — a student with no
  // matching scan gets blank mark cells (plan.md §17, never `0`).
  rosterRows: ExamSheetRow[];
  // A scanned script matching no roster student, appended below the
  // roster block rather than dropped (the contract's own words).
  unmatchedRows: ExamSheetRow[];
  // Roster students matched by NO confirmed record at all — step.md
  // 12.12's pre-export coverage list. Distinct from a roster row whose
  // marks are merely blank, which could also mean a scanned script was
  // matched but every mark itself came back unreadable; this is
  // specifically "nobody scanned this person" rather than "everyone did,
  // some marks are missing."
  missingStudents: RosterStudent[];
  // Roster students matched by more than one confirmed record. Step.md
  // 12.12 blocks the round-trip export on this — the caller decides that,
  // not this function; `rosterRows` above still picks the most recently
  // confirmed record for that student's own row regardless, since a row
  // has to contain SOMETHING even while the caller is refusing to export it.
  duplicates: DuplicateMatch[];
}

function questionValuesFor(record: StudentRecord | undefined, config: QuizConfig): (number | null)[] {
  return config.questions.map((qc) => record?.questions.find((q) => q.q === qc.q)?.value ?? null);
}

// Matching is on student ID only (plan.md §17 — SL is read through but
// never checked; a per-quiz roster's SL correspondence to what a student
// actually writes in the serial box can't be assumed workbook to
// workbook). The SAME normalization roster.ts uses for its own duplicate
// check is reused here rather than reimplemented, so a record's ID and a
// roster's ID agree on what "the same ID" means.
export function buildExamSheet(
  roster: ParsedRoster,
  records: StudentRecord[],
  config: QuizConfig,
): ExamSheetResult {
  const rosterKeys = new Set(roster.students.map((s) => s.studentIdKey));
  const byKey = new Map<string, StudentRecord[]>();
  const unmatchedRows: ExamSheetRow[] = [];

  for (const record of records) {
    const key = record.studentId ? normalizeIdForMatch(record.studentId, config.idDigits) : null;
    if (key && rosterKeys.has(key)) {
      const group = byKey.get(key) ?? [];
      group.push(record);
      byKey.set(key, group);
    } else {
      // No studentId at all (identified by serial only), or an ID that
      // matches nobody on the roster — surfaced, never dropped.
      unmatchedRows.push({
        sl: null,
        studentId: record.studentId ?? '',
        studentName: '',
        questions: questionValuesFor(record, config),
        total: record.total,
        serial: record.serial,
      });
    }
  }

  const duplicates: DuplicateMatch[] = [];
  const missingStudents: RosterStudent[] = [];
  const rosterRows: ExamSheetRow[] = roster.students.map((student) => {
    const matches = byKey.get(student.studentIdKey) ?? [];
    if (matches.length === 0) {
      missingStudents.push(student);
    } else if (matches.length > 1) {
      duplicates.push({
        studentIdKey: student.studentIdKey,
        studentId: student.studentId,
        studentName: student.studentName,
        records: matches,
      });
    }
    // A roster student with no matching scan gets `chosen: undefined`, and
    // questionValuesFor/`?? null` below take care of making every one of
    // their mark cells genuinely blank — the same helper used for a
    // student who WAS scanned, so "blank" isn't a separately-maintained
    // special case that could drift from the normal shape.
    const chosen =
      matches.length > 0
        ? matches.reduce((a, b) => (a.capturedAt > b.capturedAt ? a : b))
        : undefined;

    return {
      sl: student.sl,
      studentId: student.studentId,
      studentName: student.studentName,
      questions: questionValuesFor(chosen, config),
      total: chosen?.total ?? null,
      serial: chosen?.serial ?? null,
    };
  });

  return { rosterRows, unmatchedRows, duplicates, missingStudents };
}
