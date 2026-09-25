// Pure grouping/sorting/labelling logic for Section and Assessment (step.md
// step 13.3, plan.md §18). No IndexedDB here — same shape as resultsTable.ts and
// examSheet.ts, so this is unit-testable without a DOM or a fake database.
import type { Assessment, QuizConfig, Section } from './types';

// Semester is a picker now, not free text (revisiting plan.md §18's own
// "free text vs. a picker" open risk — decided in favour of a picker).
// Three terms, not four: this app's own pilot institution runs a
// trimester calendar (Spring/Summer/Autumn), never Winter.
export const SEMESTER_SEASONS = ['Spring', 'Summer', 'Autumn'] as const;
export type SemesterSeason = (typeof SEMESTER_SEASONS)[number];

// The one place "Season" + "Year" becomes the string actually stored as
// `Section.semester` — every other function in this module, and every
// comparison the purge (13.18) makes, operates on that plain string, not
// on the two picker fields separately.
export function formatSemesterLabel(season: SemesterSeason, year: number): string {
  return `${season} ${year}`;
}

const SEMESTER_LABEL_RE = /^(Spring|Summer|Autumn) (\d{4})$/;

// The inverse of formatSemesterLabel — used to pre-fill the picker when
// EDITING a section. Returns null for anything that doesn't match
// exactly (a 4-digit year, one of the three seasons, one space), which
// covers two real cases deliberately treated the same way: a section
// created before the picker existed (free text, e.g. "Fall 2026" or
// "F26"), and a genuinely malformed value. Either way SectionForm falls
// back to today's own season/year rather than leaving the picker in an
// invalid state — see that file's own comment on why that fallback is
// safe (nothing is silently overwritten until the instructor taps Save).
export function parseSemesterLabel(label: string): { season: SemesterSeason; year: number } | null {
  const match = SEMESTER_LABEL_RE.exec(label.trim());
  if (!match) return null;
  return { season: match[1] as SemesterSeason, year: Number(match[2]) };
}

// A reasonable default season for "right now," so a brand-new section's
// picker doesn't open on an arbitrary first option. Boundaries are a
// judgement call, not a rule the rest of the app depends on — getting
// this wrong costs the instructor one extra tap to correct it, nothing
// more, since nothing else reads the CURRENT season, only whichever one
// was actually picked and saved.
export function currentSemesterSeason(now: Date = new Date()): SemesterSeason {
  const month = now.getMonth(); // 0-11
  if (month <= 3) return 'Spring'; // Jan-Apr
  if (month <= 7) return 'Summer'; // May-Aug
  return 'Autumn'; // Sep-Dec
}

// "CSE203-2" — the one string every screen shows for a section. Course is
// deliberately not its own field or store (plan.md §18): this is the only
// place that combines courseCode and label for display, so nothing else
// has to remember the "-" convention.
export function sectionDisplayLabel(section: Pick<Section, 'courseCode' | 'label'>): string {
  return `${section.courseCode}-${section.label}`;
}

// step.md 13.3 — stops "CSE203" / "2" existing twice under the same
// semester. Compares case-insensitively (an instructor typing "cse203"
// then "CSE203" later is the same course) and trims whitespace; excludeId
// lets an edit-in-place check against every OTHER section without always
// colliding with itself.
export function isDuplicateSection(
  sections: Section[],
  semester: string,
  courseCode: string,
  label: string,
  excludeId?: string,
): boolean {
  const key = (s: string) => s.trim().toLowerCase();
  return sections.some(
    (s) =>
      s.id !== excludeId &&
      key(s.semester) === key(semester) &&
      key(s.courseCode) === key(courseCode) &&
      key(s.label) === key(label),
  );
}

export interface CourseGroup {
  courseCode: string;
  sections: Section[];
}

export interface SemesterGroup {
  semester: string;
  courses: CourseGroup[];
}

// Natural sort for a label like "1", "2", "10" — a plain string compare
// would put "10" before "2". Falls back to a plain locale compare for
// non-numeric labels, so this never throws on unexpected input.
function compareLabels(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return a.localeCompare(b);
}

// Semester -> course -> sections, each level sorted for display. Semester
// order is deliberately insertion order (first section seen for that
// semester wins its position), NOT a "current semester first" rule —
// that needs a real notion of "current" and is step.md 13.17's job
// (Phase D), not this pure grouping function's. In practice this still
// tends to show the semester being actively used first, since that's
// usually the one sections keep getting added to.
export function groupSections(sections: Section[]): SemesterGroup[] {
  const bySemester = new Map<string, Map<string, Section[]>>();
  for (const section of sections) {
    if (!bySemester.has(section.semester)) bySemester.set(section.semester, new Map());
    const byCourse = bySemester.get(section.semester)!;
    if (!byCourse.has(section.courseCode)) byCourse.set(section.courseCode, []);
    byCourse.get(section.courseCode)!.push(section);
  }

  return [...bySemester.entries()].map(([semester, byCourse]) => ({
    semester,
    courses: [...byCourse.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([courseCode, courseSections]) => ({
        courseCode,
        sections: [...courseSections].sort((a, b) => compareLabels(a.label, b.label)),
      })),
  }));
}

// Every assessment that belongs to one section, newest first — the one an
// instructor is most likely resuming is usually the one just created.
export function assessmentsForSection(assessments: Assessment[], sectionId: string): Assessment[] {
  return assessments
    .filter((a) => a.sectionId === sectionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Combines an Assessment with its owning Section into the QuizConfig shape
// every scan-loop screen (Scan/Review/Results) already takes — idDigits is
// deliberately read from the SECTION here, never copied onto the
// Assessment itself (plan.md §18), so it can't drift between the two.
export function assessmentConfig(assessment: Assessment, section: Section): QuizConfig {
  return {
    quizName: assessment.quizName,
    idDigits: section.idDigits,
    questions: assessment.questions,
    totalMax: assessment.totalMax,
    // Step 16 — only ever present as `false`. A quiz with a Serial box
    // (every quiz saved before step 16 included) produces exactly the
    // config object it always did, and the backend reads an absent field
    // as true.
    ...(hasSerialBox(assessment) ? {} : { hasSerial: false }),
  };
}

// Step 16 (plan.md §21) — the ONE place "does this quiz's paper have a
// Serial box" is decided. Anything but an explicit false is yes, which is
// what keeps every pre-step-16 assessment on today's behaviour.
export function hasSerialBox(assessment: Pick<Assessment, 'hasSerial'> | Pick<QuizConfig, 'hasSerial'>): boolean {
  return assessment.hasSerial !== false;
}

// Step 16 — what a NEW assessment's "Serial box on paper" toggle starts
// at: whatever the section's most recently created quiz used, since a
// course tends to keep one paper layout. Yes when there is none.
export function defaultHasSerial(sectionAssessments: Assessment[]): boolean {
  if (sectionAssessments.length === 0) return true;
  const latest = sectionAssessments.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  return hasSerialBox(latest);
}

// Step.md 13.14 (Phase C) — "opening an assessment last touched before
// today asks first." `lastActivityAt` is DERIVED (the latest capturedAt
// among an assessment's own records, computed by Library.tsx from data it
// already has to show scanned counts) rather than a stored field — there
// is nothing to keep in sync, and no migration needed for assessments
// that existed before this landed.
//
// `null` means never scanned at all (a brand-new assessment) — that is
// never a case worth confirming, since there's nothing to lose by opening
// it. Compared by LOCAL calendar day, not a 24-hour window: an assessment
// scanned at 11pm and reopened at 7am the next morning is a genuinely
// different session, even though less than 24 hours have passed.
export function needsResumeConfirmation(lastActivityAt: string | null, now: Date = new Date()): boolean {
  if (lastActivityAt === null) return false;
  const last = new Date(lastActivityAt);
  return last.toDateString() !== now.toDateString();
}

// The latest capturedAt among a list of records, or null for an empty
// list — pulled out as its own function so Library.tsx's per-assessment
// derivation and this module's own tests can share one definition of
// "when was this assessment last touched."
export function lastActivityAt(capturedAtValues: string[]): string | null {
  if (capturedAtValues.length === 0) return null;
  return capturedAtValues.reduce((latest, v) => (v > latest ? v : latest));
}

// Step.md 13.18 — every semester OTHER than the one just created, exact
// string match rather than case/whitespace-normalized. Deliberately: a
// normalized match would silently fold "Fall 2026" and "fall 2026"
// together, hiding EXACTLY the label-drift plan.md §18 names as an open
// risk. Treating them as distinct candidates surfaces the drift as two
// small purge offers instead of masking it as one.
export function otherSemesters(sections: Section[], currentSemester: string): string[] {
  return [...new Set(sections.map((s) => s.semester))].filter((s) => s !== currentSemester);
}

// True when deleting this assessment would cost real, unrecovered student
// data — never exported AND holding at least one record. Deliberately
// narrower than "exportedAt === null" alone (issues.md N36): a brand-new
// assessment created by mistake is ALSO never exported, and there is
// nothing to lose deleting an empty one.
//
// What callers DO with it differs, on purpose. The semester purge blocks
// on it outright: that is offered unprompted and takes every section at
// once. Deleting one section or one quiz only WARNS (step 15 follow-up,
// 2026-09-24, at the user's request): it is a deliberate act on a named
// item, already behind a typed-name confirm, and the block made a
// deliberate delete of scanned-but-unwanted work impossible without a
// pointless export first.
function hasUnexportedWork(assessment: Assessment, recordCounts: Record<string, number>): boolean {
  return assessment.exportedAt === null && (recordCounts[assessment.id] ?? 0) > 0;
}

export interface PurgePreview {
  semester: string;
  sections: Section[];
  assessmentCount: number;
  recordCount: number;
  // step.md 13.19 — any assessment that would lose real, unexported
  // records. A non-empty list here BLOCKS the purge outright; nothing
  // about this preview decides that on its own, the caller does
  // (Library.tsx), the same separation Results.tsx already keeps
  // between computing a duplicate list and deciding to block on it.
  blockedBy: { section: Section; assessment: Assessment }[];
}

// Everything one semester's purge needs to show or block on, computed
// fresh each time rather than cached — the same "derive, don't store"
// discipline the sum check and lastActivityAt already follow.
export function purgePreview(
  semester: string,
  sections: Section[],
  assessments: Assessment[],
  recordCounts: Record<string, number>,
): PurgePreview {
  const semesterSections = sections.filter((s) => s.semester === semester);
  const sectionIds = new Set(semesterSections.map((s) => s.id));
  const semesterAssessments = assessments.filter((a) => sectionIds.has(a.sectionId));
  const recordCount = semesterAssessments.reduce((sum, a) => sum + (recordCounts[a.id] ?? 0), 0);
  const blockedBy = semesterAssessments
    .filter((a) => hasUnexportedWork(a, recordCounts))
    .map((a) => ({ section: semesterSections.find((s) => s.id === a.sectionId)!, assessment: a }));

  return {
    semester,
    sections: semesterSections,
    assessmentCount: semesterAssessments.length,
    recordCount,
    blockedBy,
  };
}

export interface SectionDeletePreview {
  section: Section;
  assessmentCount: number;
  recordCount: number;
  // Assessments whose records were never exported. Shown as a WARNING in
  // the confirm, not a block (see hasUnexportedWork) — deleting
  // unrecovered work *silently* is the outcome this still prevents.
  unexported: Assessment[];
}

// The single-section counterpart to purgePreview, for "delete this one
// section" (a mis-created section, or one no longer needed) rather than
// "purge a whole semester." Reuses the same unexported-work check, but to
// warn rather than block — see hasUnexportedWork.
export function sectionDeletePreview(
  section: Section,
  assessments: Assessment[],
  recordCounts: Record<string, number>,
): SectionDeletePreview {
  const sectionAssessments = assessments.filter((a) => a.sectionId === section.id);
  const recordCount = sectionAssessments.reduce((sum, a) => sum + (recordCounts[a.id] ?? 0), 0);
  const unexported = sectionAssessments.filter((a) => hasUnexportedWork(a, recordCounts));

  return {
    section,
    assessmentCount: sectionAssessments.length,
    recordCount,
    unexported,
  };
}

export interface AssessmentDeletePreview {
  assessment: Assessment;
  recordCount: number;
  // True exactly when this assessment holds real, unexported records —
  // a warning in the confirm, never a block (see hasUnexportedWork).
  unexported: boolean;
}

// The single-assessment counterpart to sectionDeletePreview, for "delete
// this one quiz" (step.md 13.24) rather than the whole section it lives
// in. No section/course context needed here — Library.tsx already knows
// which section it's deleting from, this only needs to answer whether
// THIS assessment is safe to remove.
export function assessmentDeletePreview(
  assessment: Assessment,
  recordCounts: Record<string, number>,
): AssessmentDeletePreview {
  const recordCount = recordCounts[assessment.id] ?? 0;
  return {
    assessment,
    recordCount,
    unexported: hasUnexportedWork(assessment, recordCounts),
  };
}
