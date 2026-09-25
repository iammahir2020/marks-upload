// Create or edit a Section (step.md step 13.5, plan.md §18) — course code,
// label, semester, and student ID digit count. The durable thing: created
// once and reused by every quiz that section sits, unlike the old
// Setup.tsx form which re-asked all of this every single quiz.
//
// The class-list workbook upload below is step.md 13.9 (Phase B), built
// alongside 13.5 rather than after it — landing Phase A alone would have
// meant no way to attach a roster at all until a second pass, a real
// regression against what step 12 already shipped. The upload/parse/
// confirm-card/picker logic is a straight port of Setup.tsx's own
// workbook-mode UI (step.md 12.1-12.4), unchanged in behaviour: it's a
// relocation onto the SECTION, not a rewrite, the same way step 2r.0
// moved the recognizers without touching their logic.
import { useEffect, useMemo, useState } from 'react';
import { getAllSections } from './db';
import {
  analyzeWorkbook,
  isRosterError,
  parseRosterSheet,
  type ParsedRoster,
  type RosterAnalysis,
  type RosterError,
} from './roster';
import {
  currentSemesterSeason,
  formatSemesterLabel,
  isDuplicateSection,
  parseSemesterLabel,
  SEMESTER_SEASONS,
  type SemesterSeason,
} from './sections';
import type { Section } from './types';
import { MAX_ID_DIGITS } from './validateConfig';
import type { Workbook } from 'exceljs';

const ROSTER_PREVIEW_COUNT = 3;

// Same NumField pattern as the old Setup.tsx (and now AssessmentForm) —
// see that file's own comment on why Number('') must not be the coercion.
type NumField = number | '';
function toNumField(raw: string): NumField {
  return raw === '' ? '' : Number(raw);
}
function asNumber(value: NumField): number {
  return value === '' ? NaN : value;
}

interface WorkbookState {
  fileName: string;
  workbookBytes: ArrayBuffer;
  workbook: Workbook;
  analysis: RosterAnalysis;
  chosenSheetName: string | null;
}

interface SectionFormProps {
  // null/undefined = creating a new section. A real Section = editing it
  // in place, form pre-filled from its current values.
  editing?: Section | null;
  onSave: (section: Section) => void;
  onCancel: () => void;
}

// Pre-fills the picker from an existing section's semester, when it
// parses. `null` covers two real cases identically: a section created
// before the picker existed (free text — "Fall 2026", "F26"), and a
// genuinely malformed value. Either way, falling back to today's own
// season/year is safe — nothing is overwritten until Save is tapped, and
// the instructor sees exactly what they're about to save, same as any
// other field.
function initialSeason(editing: Section | null): SemesterSeason {
  return (editing && parseSemesterLabel(editing.semester)?.season) ?? currentSemesterSeason();
}
function initialYear(editing: Section | null): number {
  return (editing && parseSemesterLabel(editing.semester)?.year) ?? new Date().getFullYear();
}

export default function SectionForm({ editing = null, onSave, onCancel }: SectionFormProps) {
  const [courseCode, setCourseCode] = useState(editing?.courseCode ?? '');
  const [label, setLabel] = useState(editing?.label ?? '');
  // Step.md 13.18 / plan.md §18 — a picker, not free text: season is a
  // fixed choice (SEMESTER_SEASONS) rather than a string, so it can never
  // be empty or mis-typed. Year still uses NumField (the same cleared-
  // field pattern idDigits below already uses) since it's a real number
  // input the instructor can clear.
  const [season, setSeason] = useState<SemesterSeason>(initialSeason(editing));
  const [year, setYear] = useState<NumField>(initialYear(editing));
  // Step 16 (plan.md §21) — no longer editable: this is an IUB-only tool
  // and IUB student IDs are always 7 digits, so the input below is
  // commented out. The value itself is unchanged — a new section still
  // gets 7, an existing section keeps what it has — and Section.idDigits
  // stays, since detection, the roster parser and the recognizer all read
  // it. Restore the setter and the input together to bring it back.
  const [idDigits] = useState<NumField>(editing?.idDigits ?? 7);
  const [errors, setErrors] = useState<string[]>([]);

  // Self-fetched (same pattern the old Setup.tsx used for its own initial
  // load) rather than handed down from App.tsx, so this stays a
  // self-contained screen: every OTHER section, for the duplicate-
  // course/label check below — the one being edited (if any) excludes
  // itself via `editing.id`.
  const [existingSections, setExistingSections] = useState<Section[] | null>(null);
  useEffect(() => {
    getAllSections().then(setExistingSections);
  }, []);

  // Phase B — starts from whatever the section already has (editing an
  // existing one that already carries a roster), null for a brand-new
  // section or one that never had a workbook attached.
  const [existingWorkbook, setExistingWorkbook] = useState(editing?.workbook ?? null);
  const [existingRoster, setExistingRoster] = useState<ParsedRoster | null>(editing?.roster ?? null);
  const [loadingWorkbook, setLoadingWorkbook] = useState(false);
  const [workbookError, setWorkbookError] = useState<string | null>(null);
  const [workbookState, setWorkbookState] = useState<WorkbookState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  const effectiveSheetName = workbookState
    ? (workbookState.chosenSheetName ?? workbookState.analysis.chosenSheetName)
    : null;

  // Re-parsed on every idDigits edit, matching Setup.tsx's original
  // reasoning exactly: normalizeIdForMatch depends on idDigits, and
  // re-running it against the already-loaded workbook is cheap.
  const parsedRoster: ParsedRoster | RosterError | null = useMemo(() => {
    if (!workbookState || !effectiveSheetName) return null;
    return parseRosterSheet(workbookState.workbook, effectiveSheetName, idDigits === '' ? 0 : idDigits);
  }, [workbookState, effectiveSheetName, idDigits]);

  async function handleWorkbookFile(file: File) {
    setWorkbookError(null);
    setWorkbookState(null);
    setPickerOpen(false);
    setLoadingWorkbook(true);
    try {
      const buffer = await file.arrayBuffer();
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const analysis = analyzeWorkbook(workbook);
      if (analysis.candidates.length === 0) {
        setWorkbookError(
          'No sheet in this file has both a STUDENT ID and a STUDENT NAME column — is this the right file?',
        );
        return;
      }

      setWorkbookState({ fileName: file.name, workbookBytes: buffer, workbook, analysis, chosenSheetName: null });
      setPickerOpen(analysis.ambiguous);
    } catch {
      setWorkbookError("Couldn't read this file — is it a valid .xlsx workbook?");
    } finally {
      setLoadingWorkbook(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Blocks the submit outright rather than silently skipping the
    // duplicate check — existingSections is only null for the brief
    // window before the mount fetch resolves (fake-slow storage, or a
    // very fast tap), and letting a submit through then would mean the
    // check ran against an empty list.
    if (existingSections === null) return;
    const errs: string[] = [];

    const trimmedCourse = courseCode.trim();
    const trimmedLabel = label.trim();
    // Season is always a valid choice (a fixed set, never empty); year is
    // the one part of the picker that can be cleared like any other
    // NumField. A real year, not "the current one" as a silent fallback —
    // an emptied box has to fail validation the same way idDigits does,
    // not quietly save today's year the instructor never chose.
    const numericYear = asNumber(year);
    const validYear = Number.isInteger(numericYear) && numericYear >= 2000 && numericYear <= 2100;
    if (!validYear) errs.push('Year must be a 4-digit year.');
    const trimmedSemester = validYear ? formatSemesterLabel(season, numericYear) : '';

    if (!trimmedCourse) errs.push('Course code is required.');
    if (!trimmedLabel) errs.push('Section label is required.');
    const numericIdDigits = asNumber(idDigits);
    if (!Number.isInteger(numericIdDigits) || numericIdDigits < 1 || numericIdDigits > MAX_ID_DIGITS) {
      errs.push(`Student ID digits must be a whole number from 1 to ${MAX_ID_DIGITS}.`);
    }
    if (
      trimmedCourse &&
      trimmedLabel &&
      trimmedSemester &&
      isDuplicateSection(existingSections, trimmedSemester, trimmedCourse, trimmedLabel, editing?.id)
    ) {
      errs.push(`${trimmedCourse}-${trimmedLabel} already exists for ${trimmedSemester}.`);
    }
    if (workbookState && (!effectiveSheetName || !parsedRoster)) {
      errs.push('Choose which sheet is your class list, or remove the file.');
    }
    if (workbookState && parsedRoster && isRosterError(parsedRoster)) {
      errs.push(parsedRoster.message);
    }

    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors([]);

    // A fresh upload replaces whatever the section had; otherwise keep
    // what was already there (editing a section without touching its
    // roster must not silently drop it).
    const roster =
      workbookState && parsedRoster && !isRosterError(parsedRoster) ? parsedRoster : existingRoster ?? undefined;
    const workbook =
      workbookState && parsedRoster && !isRosterError(parsedRoster)
        ? {
            fileName: workbookState.fileName,
            bytes: workbookState.workbookBytes,
            capturedAt: new Date().toISOString(),
            source: 'uploaded' as const,
          }
        : (existingWorkbook ?? undefined);

    onSave({
      id: editing?.id ?? crypto.randomUUID(),
      courseCode: trimmedCourse,
      label: trimmedLabel,
      semester: trimmedSemester,
      idDigits: numericIdDigits,
      ...(roster ? { roster } : {}),
      ...(workbook ? { workbook } : {}),
    });
  }

  function removeExistingWorkbook() {
    setExistingWorkbook(null);
    setExistingRoster(null);
  }

  return (
    <div className="page">
      <div className="app-header">
        <div>
          <span className="eyebrow">Script Mark Scanner</span>
          <h1>{editing ? `Edit ${editing.courseCode}-${editing.label}` : 'New section'}</h1>
        </div>
      </div>

      <form className="card stack" onSubmit={handleSubmit}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: 1, minWidth: 120 }}>
            <label className="field-label" htmlFor="courseCode">
              Course code
            </label>
            <input
              id="courseCode"
              className="input"
              value={courseCode}
              onChange={(e) => setCourseCode(e.target.value)}
              placeholder="CSE203"
              autoComplete="off"
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 100 }}>
            <label className="field-label" htmlFor="sectionLabel">
              Section
            </label>
            <input
              id="sectionLabel"
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="1"
              autoComplete="off"
            />
          </div>
        </div>

        {/* Plan.md §18's own "free text vs. a picker" open risk, resolved
            in favour of a picker: season is a fixed choice, never typed,
            so "Fall 2026" and "fall 2026" can no longer both exist — the
            exact-string comparison step.md 13.18's purge already relies
            on stays meaningful without needing any normalization. */}
        <div className="field">
          <span className="field-label">Semester</span>
          <div className="row" style={{ flexWrap: 'wrap' }} aria-label="Semester season">
            {SEMESTER_SEASONS.map((s) => (
              <button
                key={s}
                type="button"
                className={`btn btn-sm ${season === s ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={season === s}
                onClick={() => setSeason(s)}
              >
                {s}
              </button>
            ))}
            <input
              id="semesterYear"
              className="input"
              type="number"
              inputMode="numeric"
              value={year}
              onChange={(e) => setYear(toNumField(e.target.value))}
              aria-label="Semester year"
              style={{ width: '6rem' }}
            />
          </div>
        </div>

        {/* Step 16 — hidden, not deleted; see the idDigits state above.
        <div className="field">
          <label className="field-label" htmlFor="sectionIdDigits">
            Student ID digits
          </label>
          <input
            id="sectionIdDigits"
            className="input"
            type="number"
            inputMode="numeric"
            value={idDigits}
            onChange={(e) => setIdDigits(toNumField(e.target.value))}
          />
          <span className="field-hint">Same for every quiz in this section.</span>
        </div>
        */}

        {/* Phase B (step.md 13.9) — optional. Not gated behind a mode
            toggle the way Setup.tsx's used to be: a section either has a
            class list attached or it doesn't, and Results decides what to
            show from that alone. */}
        <div className="field">
          <span className="field-label">Class-list workbook (optional)</span>
          <span className="field-hint">
            Attach your own class marksheet once — every quiz in this section reuses it, and
            results can be written back into it as a new sheet, alongside the plain download.
          </span>

          {existingWorkbook && !workbookState && (
            <div className="card stack-sm" style={{ padding: 12 }}>
              <div className="row-between">
                <span>
                  Currently: <strong>{existingWorkbook.fileName}</strong>
                  {existingRoster && (
                    <>
                      {' — '}
                      {existingRoster.students.length}{' '}
                      {existingRoster.students.length === 1 ? 'student' : 'students'}
                    </>
                  )}
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={removeExistingWorkbook}>
                  Remove
                </button>
              </div>
            </div>
          )}

          <input
            id="rosterFile"
            className="input"
            type="file"
            accept=".xlsx"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setSelectedFileName(file.name);
                void handleWorkbookFile(file);
              }
              e.target.value = '';
            }}
          />

          {selectedFileName && <span className="text-sm muted">Selected: {selectedFileName}</span>}
          {loadingWorkbook && <span className="text-sm muted">Reading{'…'}</span>}

          {workbookError && (
            <p role="alert" className="error-text">
              {workbookError}
            </p>
          )}

          {workbookState && parsedRoster && !isRosterError(parsedRoster) && (
            <div className="card stack-sm" style={{ padding: 12 }}>
              <div className="row-between">
                <span>
                  Class list: <strong>{parsedRoster.sheetName}</strong> &mdash;{' '}
                  {parsedRoster.students.length} {parsedRoster.students.length === 1 ? 'student' : 'students'}
                </span>
                {workbookState.analysis.candidates.length > 1 && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPickerOpen((v) => !v)}>
                    Change
                  </button>
                )}
              </div>

              {parsedRoster.students.length > 0 && (
                <span className="text-sm muted">
                  e.g.{' '}
                  {parsedRoster.students
                    .slice(0, ROSTER_PREVIEW_COUNT)
                    .map((s) => s.studentName || s.studentId)
                    .join(', ')}
                </span>
              )}

              {parsedRoster.duplicateIds.length > 0 && (
                <div className="banner banner-warning" role="alert" style={{ padding: 10 }}>
                  {parsedRoster.duplicateIds.length === 1
                    ? `One student ID appears more than once in this roster: ${parsedRoster.duplicateIds[0]}.`
                    : `${parsedRoster.duplicateIds.length} student IDs appear more than once in this roster: ${parsedRoster.duplicateIds.join(', ')}.`}
                </div>
              )}

              {pickerOpen && (
                <div className="stack-sm">
                  <span className="text-sm muted">
                    {workbookState.analysis.ambiguous
                      ? 'More than one sheet here looks like a class list — pick the right one:'
                      : 'Use a different sheet as the class list:'}
                  </span>
                  {workbookState.analysis.candidates.map((c) => (
                    <button
                      key={c.sheetName}
                      type="button"
                      className={`btn btn-sm ${c.sheetName === effectiveSheetName ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => {
                        setWorkbookState((s) => (s ? { ...s, chosenSheetName: c.sheetName } : s));
                        setPickerOpen(false);
                      }}
                    >
                      {c.sheetName} &mdash; {c.studentCount} {c.studentCount === 1 ? 'student' : 'students'}
                      {c.looksLikeExamSheet ? ' (looks like a previous exam sheet)' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {workbookState && parsedRoster && isRosterError(parsedRoster) && (
            <p role="alert" className="error-text">
              {parsedRoster.message}
            </p>
          )}
        </div>

        {errors.length > 0 && (
          <div className="banner banner-danger">
            {errors.map((err) => (
              <span key={err}>{err}</span>
            ))}
          </div>
        )}

        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary flex-1" disabled={existingSections === null}>
            {editing ? 'Save' : 'Create section'}
          </button>
        </div>
      </form>
    </div>
  );
}
