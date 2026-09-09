// Matches backend/app/models.py's QuizConfig and plan.md §8 exactly.

import type { ParsedRoster } from './roster';

export interface QuestionConfig {
  q: number;
  max: number;
}

export interface QuizConfig {
  quizName: string;
  idDigits: number;
  questions: QuestionConfig[];
  totalMax: number;
}

export interface QuestionValue {
  q: number;
  value: number | null;
}

// Step.md step 13 (plan.md §18) — the durable, semester-long thing: one
// per real class section, created once and reused by every quiz that
// section sits. Course is deliberately NOT its own field or store — it's
// `courseCode`, grouped in the UI (sections.ts) — and idDigits lives here
// rather than on Assessment because it's an institutional fact, not a
// per-quiz one.
export interface Section {
  id: string;
  courseCode: string; // "CSE203"
  label: string; // "1", "2" — combined with courseCode for display ("CSE203-2")
  semester: string; // "Fall 2026" — free text; see plan.md §18's open risk on drift
  idDigits: number;
  // Phase B (step.md 13.9) fields. Optional from the start, not added
  // later, so the v4->v5 migration (13.2) can fold an existing session's
  // roster straight into a Section the moment it's created, before any
  // Phase-A-only UI exists that could otherwise produce one.
  roster?: ParsedRoster;
  workbook?: {
    fileName: string;
    bytes: ArrayBuffer;
    // When these bytes were captured — either "uploaded" (a fresh pick)
    // or "exported" (this app's own last write, re-cached per 13.12).
    // Read by the provenance line on a workbook export (13.11); staleness
    // is made VISIBLE with this, never assumed away (plan.md §18).
    capturedAt: string;
    source: 'uploaded' | 'exported';
  };
}

// One quiz's config plus its export state — everything that used to live
// in the single-value `config` store, now scoped to a Section and kept
// once the quiz is created rather than overwritten by the next one.
// `QuizConfig`'s own fields survive unchanged inside this (quizName,
// questions, totalMax) — idDigits is deliberately NOT duplicated here,
// it's read from the owning Section at use time (plan.md §18), so it
// can't drift between the two.
export interface Assessment {
  id: string;
  sectionId: string;
  quizName: string;
  questions: QuestionConfig[];
  totalMax: number;
  createdAt: string;
  // null until the first successful export (either path — plain download
  // or the workbook write). Stamped, never cleared, so the step-13 purge
  // (13.19) can refuse to delete an assessment nobody has ever filed.
  exportedAt: string | null;
}

export interface StudentRecord {
  id: string; // client-generated uuid
  // Step.md step 13 — every record belongs to exactly one Assessment now.
  // Never optional: a record with nowhere to be scoped is unreachable from
  // every screen that reads by assessment (Scan's count, Results' table).
  assessmentId: string;
  studentId: string | null;
  serial: string | null; // normalized: leading zeros stripped
  questions: QuestionValue[];
  total: number | null;
  confirmed: boolean;
  capturedAt: string;
}
