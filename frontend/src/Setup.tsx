// Setup screen (plan.md §11, step.md step 5.3): quiz name, ID digits,
// question count, per-question max. Persists QuizConfig on submit and
// reloads it on start (step 5.4).
//
// Step.md step 12.1/12.3/12.4 (plan.md §17) added an optional second mode
// here: instead of the plain download, the instructor can upload their own
// class-list workbook. ExcelJS is dynamic-imported only when a file is
// actually chosen (below) — Setup is the app's first, always-visited
// screen, and the plain-download path (still the default) must not pay for
// a library it never uses, the same reasoning App.tsx already applies to
// lazy-loading the Results screen.
import { useEffect, useMemo, useState } from 'react';
import {
  clearRosterUpload,
  getAllRecords,
  loadConfig,
  loadRosterUpload,
  resetAll,
  saveConfig,
  saveRosterUpload,
} from './db';
import {
  analyzeWorkbook,
  isRosterError,
  parseRosterSheet,
  type ParsedRoster,
  type RosterAnalysis,
  type RosterError,
  type RosterUpload,
} from './roster';
import type { QuizConfig } from './types';
import { MAX_QUESTIONS, validateConfig } from './validateConfig';
import type { Workbook } from 'exceljs';

// How many names to show as a sanity-check preview once a roster parses —
// not the whole class (a large section makes that a wall of text), just
// enough for "yes, that's the right file." Held only in this component's
// own state while Setup is mounted; nothing here is written to IndexedDB
// yet (step.md 12.14, Phase D, adds that).
const ROSTER_PREVIEW_COUNT = 3;

type SetupMode = 'plain' | 'workbook';

interface WorkbookState {
  fileName: string;
  // The raw upload, kept alongside the parsed `workbook` instance — Phase B
  // (step.md 12.8) needs the ORIGINAL bytes, untouched, so every export
  // this session can reload fresh from them rather than building on top of
  // whatever the previous export already wrote.
  workbookBytes: ArrayBuffer;
  workbook: Workbook;
  analysis: RosterAnalysis;
  // An explicit pick made via "Change" — null means "use the analysis's
  // own best guess," which is what the confirm step shows by default.
  chosenSheetName: string | null;
}

interface SetupProps {
  // `rosterUpload` is null in plain mode. In workbook mode it's either the
  // upload just made in this form, or (via the saved-config quick-start
  // button below) whatever step 12.14 restored from IndexedDB — a mid-
  // session refresh doesn't fall back to plain mode any more.
  onStart: (config: QuizConfig, rosterUpload: RosterUpload | null) => void;
  // Jump straight to the results table for records saved earlier. Setup
  // owns the entry point because this is where someone lands after
  // closing the app mid-session — the records are the thing they will
  // worry about first, so they are surfaced before anything else. Also
  // carries whatever roster step 12.14 restored, for the same reason.
  onViewResults: (config: QuizConfig, rosterUpload: RosterUpload | null) => void;
}

const HOW_IT_WORKS = [
  {
    title: 'Set up the quiz once',
    detail: 'Tell it how many digits the student ID has, how many questions, and each question’s max mark.',
  },
  {
    title: 'Photograph each script',
    detail: 'Frame the marks grid at the top of the script and capture — the camera stays ready for the next one immediately.',
  },
  {
    title: 'Confirm what it read',
    detail: 'Each capture opens for review automatically. Fix anything wrong or left blank, then confirm.',
  },
  {
    title: 'Export when the class is done',
    detail: 'Every confirmed script is saved on this device. Download the whole session as one Excel file whenever you’re ready.',
  },
];

export default function Setup({ onStart, onViewResults }: SetupProps) {
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<QuizConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const [quizName, setQuizName] = useState('');
  const [idDigits, setIdDigits] = useState(7);
  const [questionCount, setQuestionCount] = useState(5);
  const [questionMaxes, setQuestionMaxes] = useState<number[]>([5, 5, 5, 5, 5]);
  const [errors, setErrors] = useState<string[]>([]);

  // Step.md step 12.1 — the mode choice. Not persisted (step.md's own
  // phasing: 12.14, IndexedDB storage, is a later phase), so it resets to
  // 'plain' on every fresh load — the same "fresh upload per quiz" rule
  // the roster upload itself follows, just applied to the mode too.
  const [mode, setMode] = useState<SetupMode>('plain');
  const [loadingWorkbook, setLoadingWorkbook] = useState(false);
  const [workbookError, setWorkbookError] = useState<string | null>(null);
  const [workbookState, setWorkbookState] = useState<WorkbookState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Set the instant a file is chosen, independently of the native <input>'s
  // own displayed filename — that gets deliberately cleared right after
  // (see the file input's onChange below), so relying on the input's own
  // text would show "No file chosen" even after a successful upload.
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  // Step 12.14 — restored on mount so a mid-session refresh doesn't lose
  // the roster: only ever handed to the SAVED-CONFIG quick-start below
  // (resuming this exact session), never pre-filled into the form — 12.1's
  // "fresh upload per quiz" still governs starting or editing a quiz.
  const [persistedRosterUpload, setPersistedRosterUpload] = useState<RosterUpload | null>(null);

  useEffect(() => {
    // Records, config and any persisted roster are read together: a
    // half-finished session is all three, and showing one without the
    // others would be misleading (or, for the roster, would silently
    // resume in plain mode after a refresh that a workbook was ever
    // attached at all).
    Promise.all([loadConfig(), getAllRecords(), loadRosterUpload()]).then(([config, records, upload]) => {
      if (config) {
        setSaved(config);
        setQuizName(config.quizName);
        setIdDigits(config.idDigits);
        setQuestionCount(config.questions.length);
        setQuestionMaxes(config.questions.map((q) => q.max));
      }
      if (upload) setPersistedRosterUpload(upload);
      setSavedCount(records.length);
      setLoaded(true);
    });
  }, []);

  async function handleReset() {
    await resetAll();
    setConfirmingReset(false);
    setSavedCount(0);
    setSaved(null);
    setEditing(false);
    // Back to an empty form, not to a form still holding the old quiz's
    // values — "start fresh" has to mean it.
    setQuizName('');
    setIdDigits(7);
    setQuestionCount(5);
    setQuestionMaxes([5, 5, 5, 5, 5]);
    setErrors([]);
    resetWorkbookState();
    setPersistedRosterUpload(null); // resetAll() already cleared the DB store; this clears the mirror in memory
  }

  // One place to clear every piece of upload state, so "Reset everything"
  // and picking a new file (replacing whatever was already loaded) can't
  // drift apart and leave a stale error or a stale confirm card visible.
  function resetWorkbookState() {
    setMode('plain');
    setWorkbookError(null);
    setWorkbookState(null);
    setPickerOpen(false);
    setSelectedFileName(null);
  }

  // Step.md 12.3's "prefer, then confirm" pick, re-derived rather than
  // stored: an explicit "Change" selection wins, otherwise whatever
  // analyzeWorkbook already decided.
  const effectiveSheetName = workbookState
    ? (workbookState.chosenSheetName ?? workbookState.analysis.chosenSheetName)
    : null;

  // Re-parsed on every idDigits edit, not just once at upload — the roster
  // ID normalization (roster.ts's normalizeIdForMatch) depends on idDigits,
  // and re-running it against the already-loaded workbook is cheap. Without
  // this, changing "Student ID digits" after uploading would silently leave
  // matching keys computed against a stale digit count.
  const parsedRoster: ParsedRoster | RosterError | null = useMemo(() => {
    if (!workbookState || !effectiveSheetName) return null;
    return parseRosterSheet(workbookState.workbook, effectiveSheetName, idDigits);
  }, [workbookState, effectiveSheetName, idDigits]);

  // Step.md 12.4's validation/error states, gathered in one place so
  // handleSubmit and the disabled-state of the submit button can't
  // disagree about what counts as "not ready yet."
  function workbookModeErrors(): string[] {
    if (mode !== 'workbook') return [];
    if (workbookError) return [workbookError];
    if (loadingWorkbook) return ['Reading your workbook…'];
    if (!workbookState) {
      return ['Upload your class marksheet, or switch to a plain download.'];
    }
    if (!effectiveSheetName || !parsedRoster) {
      return ['Choose which sheet is your class list.'];
    }
    if (isRosterError(parsedRoster)) return [parsedRoster.message];
    return [];
  }

  async function handleWorkbookFile(file: File) {
    setWorkbookError(null);
    setWorkbookState(null);
    setPickerOpen(false);
    setLoadingWorkbook(true);
    try {
      const buffer = await file.arrayBuffer();
      // Dynamic import — see the file-header comment on why this must not
      // load eagerly with the rest of Setup.
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const analysis = analyzeWorkbook(workbook);
      if (analysis.candidates.length === 0) {
        // step.md 12.4 "no candidate sheet" — named specifically, not a
        // generic failure, so the instructor knows what to check.
        setWorkbookError(
          'No sheet in this file has both a STUDENT ID and a STUDENT NAME column — is this the right file?',
        );
        return;
      }

      setWorkbookState({ fileName: file.name, workbookBytes: buffer, workbook, analysis, chosenSheetName: null });
      // Ambiguous means the pick is a guess (several roster-shaped sheets,
      // none of them first) — open the picker immediately rather than
      // making the instructor notice a small "Change" link on their own.
      setPickerOpen(analysis.ambiguous);
    } catch {
      // step.md 12.4's corrupt/non-xlsx case — ExcelJS throws on a file it
      // can't parse at all; caught here rather than left as an unhandled
      // rejection that would otherwise just freeze the upload UI silently.
      setWorkbookError("Couldn't read this file — is it a valid .xlsx workbook?");
    } finally {
      setLoadingWorkbook(false);
    }
  }

  function handleQuestionCountChange(next: number) {
    // The typed value is always kept, so the field stays editable and
    // validateConfig gets to report a real error on submit. What is guarded
    // is the ARRAY resize below, which is the part that could not survive a
    // bad number (issues.md #1):
    //
    //   - `copy.length = 5.5` throws RangeError: Invalid array length, per
    //     spec. So does NaN. That crashed the whole Setup screen — the first
    //     screen of the app — before validateConfig ever ran.
    //   - `while (copy.length < next) copy.push(5)` with next = 99999999999,
    //     which <input type="number"> accepts happily, pushes ~10^11 entries
    //     and hangs the tab before the length assignment is even reached.
    //
    // Anything outside the bounds leaves questionMaxes exactly as it was;
    // submitting then fails validation with a message instead of a crash.
    setQuestionCount(next);
    if (!Number.isInteger(next) || next < 1 || next > MAX_QUESTIONS) return;
    setQuestionMaxes((prev) => {
      const copy = [...prev];
      while (copy.length < next) copy.push(5);
      copy.length = next;
      return copy;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = validateConfig({ quizName, idDigits, questionCount, questionMaxes });
    const wbErrors = workbookModeErrors();
    if (!result.valid || wbErrors.length > 0) {
      setErrors([...(result.valid ? [] : result.errors), ...wbErrors]);
      return;
    }
    if (!result.config) return;
    setErrors([]);
    await saveConfig(result.config);
    setSaved(result.config);
    setEditing(false);
    // step.md Phase B — handed up through App.tsx to Results, which does
    // the actual writing/export (12.5-12.8). In plain mode this is null,
    // and Results' existing "Download Excel" path is untouched.
    const rosterUpload: RosterUpload | null =
      mode === 'workbook' && workbookState && parsedRoster && !isRosterError(parsedRoster)
        ? { fileName: workbookState.fileName, workbookBytes: workbookState.workbookBytes, roster: parsedRoster }
        : null;
    // Step 12.14 — persisted alongside config, at the same moment, so a
    // mid-session refresh can restore both together via the saved-config
    // quick-start path above. Explicitly CLEARED rather than merely
    // skipped in plain mode — otherwise a previous quiz's workbook upload
    // would silently resurface on the next refresh, attached to a session
    // the instructor just chose not to use one for.
    if (rosterUpload) {
      await saveRosterUpload(rosterUpload);
    } else {
      await clearRosterUpload();
    }
    setPersistedRosterUpload(rosterUpload);
    onStart(result.config, rosterUpload);
  }

  if (!loaded) return null;

  return (
    <div className="page">
      <div className="app-header">
        <div>
          <span className="eyebrow">Script Mark Scanner</span>
          <h1>{saved && !editing ? saved.quizName : 'Set up this quiz'}</h1>
        </div>
      </div>

      {/*
        Renders above the quiz config on purpose. Someone reopening the app
        mid-session wants to know their scans are still there before they
        care about anything else — and if they have forgotten a session was
        open, this is the only place the app would ever tell them.
      */}
      {savedCount > 0 && (
        <div className="card stack-sm">
          <div className="row-between">
            {/*
              Wording kept distinct from the "saved on this device" line in
              HOW_IT_WORKS below, which describes the app's behaviour in
              general. This one is a count of real records right now, and
              two identical phrases meaning different things on one screen
              is a genuine reading hazard, not just a test-matcher problem.
            */}
            <span>
              <strong>
                {savedCount} {savedCount === 1 ? 'script' : 'scripts'}
              </strong>{' '}
              already scanned
            </span>
            {saved && (
              <button className="btn btn-secondary btn-sm" onClick={() => onViewResults(saved, persistedRosterUpload)}>
                View
              </button>
            )}
          </div>
          <span className="field-hint">
            From an earlier session. Starting a new scan adds to these rather than replacing
            them — reset first if this is a different class.
          </span>
          {!confirmingReset && (
            <div className="row">
              <button className="btn btn-danger btn-sm" onClick={() => setConfirmingReset(true)}>
                Reset everything
              </button>
            </div>
          )}
        </div>
      )}

      {confirmingReset && (
        <div className="banner banner-danger" role="alert">
          <p>
            This deletes {savedCount} saved {savedCount === 1 ? 'record' : 'records'} and the
            quiz setup — there's no undo. Make sure you've exported the Excel file first.
          </p>
          <div className="banner-actions">
            <button className="btn btn-danger-solid btn-sm" onClick={handleReset}>
              Yes, delete everything
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmingReset(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {saved && !editing ? (
        <div className="card stack">
          <div className="stack-sm">
            <div className="row-between">
              <span className="muted text-sm">Student ID digits</span>
              <span>{saved.idDigits}</span>
            </div>
            <div className="row-between">
              <span className="muted text-sm">Questions</span>
              <span>{saved.questions.length}</span>
            </div>
            <hr className="divider" />
            {saved.questions.map((q) => (
              <div className="row-between" key={q.q}>
                <span className="muted text-sm">Q{q.q}</span>
                <span>{q.max}</span>
              </div>
            ))}
            <hr className="divider" />
            <div className="row-between">
              <span style={{ fontWeight: 600 }}>Total</span>
              <span style={{ fontWeight: 600 }}>{saved.totalMax}</span>
            </div>
          </div>
          <div className="row">
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="btn btn-primary btn-block" onClick={() => onStart(saved, persistedRosterUpload)}>
              Start scanning &rarr;
            </button>
          </div>
        </div>
      ) : (
        <form className="card stack" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label" htmlFor="quizName">
              Quiz name
            </label>
            <input
              id="quizName"
              className="input"
              value={quizName}
              onChange={(e) => setQuizName(e.target.value)}
              placeholder="e.g. CSE211L Quiz 1…"
              autoComplete="off"
            />
          </div>

          {/* Step.md 12.1 — the mode choice. "Plain download" is the
              default and matches today's behaviour byte for byte; nothing
              below this toggle is reachable, or has any effect, unless
              "workbook" is picked. */}
          <div className="field">
            <span className="field-label">Marks export</span>
            <div className="row" style={{ flexWrap: 'wrap' }} aria-label="Marks export mode">
              <button
                type="button"
                className={`btn ${mode === 'plain' ? 'btn-primary' : 'btn-secondary'} flex-1`}
                aria-pressed={mode === 'plain'}
                onClick={() => setMode('plain')}
              >
                Plain download
              </button>
              <button
                type="button"
                className={`btn ${mode === 'workbook' ? 'btn-primary' : 'btn-secondary'} flex-1`}
                aria-pressed={mode === 'workbook'}
                onClick={() => setMode('workbook')}
              >
                Use my class marksheet
              </button>
            </div>
            <span className="field-hint">
              {mode === 'plain'
                ? 'One standalone spreadsheet with this quiz’s results, same as before.'
                : 'Upload your own class-list workbook. Results are written into it as a new sheet, and every other sheet is left untouched.'}
            </span>
          </div>

          {mode === 'workbook' && (
            <div className="field">
              <label className="field-label" htmlFor="rosterFile">
                Class marksheet (.xlsx)
              </label>
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
                  // Cleared so choosing the same filename again (a re-export
                  // dropped back in, for instance) still fires onChange —
                  // this also means the input's OWN "chosen file" text
                  // reverts to "No file chosen" right away, which is why
                  // selectedFileName exists to show the real state instead.
                  e.target.value = '';
                }}
              />

              {selectedFileName && (
                <span className="text-sm muted">Selected: {selectedFileName}</span>
              )}

              {loadingWorkbook && <span className="text-sm muted">Reading {'…'}</span>}

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
                      {parsedRoster.students.length}{' '}
                      {parsedRoster.students.length === 1 ? 'student' : 'students'}
                    </span>
                    {workbookState.analysis.candidates.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setPickerOpen((v) => !v)}
                      >
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
                          ? "More than one sheet here looks like a class list — pick the right one:"
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
                          {c.sheetName} &mdash; {c.studentCount}{' '}
                          {c.studentCount === 1 ? 'student' : 'students'}
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
          )}

          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label" htmlFor="idDigits">
                Student ID digits
              </label>
              <input
                id="idDigits"
                className="input"
                type="number"
                inputMode="numeric"
                value={idDigits}
                onChange={(e) => setIdDigits(Number(e.target.value))}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label" htmlFor="questionCount">
                Number of questions
              </label>
              <input
                id="questionCount"
                className="input"
                type="number"
                inputMode="numeric"
                value={questionCount}
                onChange={(e) => handleQuestionCountChange(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="field">
            <span className="field-label">Max mark per question</span>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {questionMaxes.map((max, i) => (
                <label key={i} className="field" style={{ width: '4.5rem', gap: '4px' }}>
                  <span className="field-hint">Q{i + 1}</span>
                  <input
                    className="input"
                    type="number"
                    inputMode="decimal"
                    value={max}
                    onChange={(e) => {
                      const next = [...questionMaxes];
                      next[i] = Number(e.target.value);
                      setQuestionMaxes(next);
                    }}
                    style={{ padding: '10px 8px', textAlign: 'center' }}
                  />
                </label>
              ))}
            </div>
            <span className="field-hint">These must match the table pasted in your question paper.</span>
          </div>

          {errors.length > 0 && (
            <div className="banner banner-danger">
              {errors.map((err) => (
                <span key={err}>{err}</span>
              ))}
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block">
            Start scanning &rarr;
          </button>
        </form>
      )}

      <details className="disclosure" open={!saved}>
        <summary>How this works</summary>
        <div className="disclosure-body">
          <ol className="steps-list">
            {HOW_IT_WORKS.map((step, i) => (
              <li key={step.title}>
                <span className="step-number">{i + 1}</span>
                <span className="step-text">
                  <strong>{step.title}</strong>
                  <span>{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-sm muted">
            Your marks stay on this device until you export them — there’s no account and no
            copy kept anywhere else. A photo that can’t be read clearly is always flagged for
            you to fix rather than guessed at.
          </p>
          <p className="text-sm muted">
            <strong>What’s kept to improve recognition.</strong> The photograph itself is
            never stored — it’s read and then discarded. What is saved is the individual
            cells it was cut into: one digit or one mark per image, each labelled with the
            value you confirmed. These are used to train and tune the handwriting
            recognition so it reads better over time. They carry no name, nothing that links
            them back to a student, and no way to reassemble a whole student ID from them.
            They’re deleted automatically after a year.
          </p>
          {/* Step.md 12.11 — a class list is different from a crop: it
              carries real names, and it's held in full rather than
              anonymised, so it gets its own paragraph rather than a
              clause added to the one above. Deliberately worded not to
              overlap with the "Upload your class marksheet" validation
              message below — the two are found by text in tests, and
              matching phrasing there would make one ambiguous to find. */}
          <p className="text-sm muted">
            <strong>Using your own class-list workbook</strong> (the option above) holds
            the names on it on this device for the session — shown next to a scanned ID so
            a misread is easy to catch — and clears them, along with everything else, via
            Reset everything below. Names are never sent anywhere; only the digits you
            confirm are used to improve recognition, exactly as above.
          </p>
        </div>
      </details>

      {/*
        Step 11.5.1 — deliberately OUTSIDE the <details> above, which
        collapses once a quiz config exists. Someone using this for the
        tenth time would otherwise never see it again, and they are the
        person whose students' handwriting is actually being collected.
        One line, always visible, plain wording.
      */}
      {/*
        The retention period is stated here as well as in the disclosure
        above, and it is not decoration: deploy.sh sets a matching S3
        lifecycle rule (issues.md N8), and the two are one fact written
        twice. Change CROPS_RETENTION_DAYS and this line changes with it, or
        the app is telling the instructor something that is no longer true —
        the same way "everything stays on this device" was true-sounding and
        wrong from step 5 until 11.5 caught it.
      */}
      <p className="text-sm muted data-note">
        Scripts are never stored. Individual cells — one digit or mark each — are kept with
        the values you confirm for up to a year, and used to train and tune handwriting
        recognition.
      </p>
      {/* Step.md 12.11 — extends the always-visible note above with a
          second one, rather than folding it into the same paragraph or
          moving it inside <details>; same reasoning as the crops line:
          a returning instructor with a saved config sees this section
          collapsed and would otherwise never see the roster fact again.
          Worded to avoid overlapping the "Upload your class marksheet"
          validation message — see the note in <details> above. */}
      <p className="text-sm muted data-note">
        Using your own class-list workbook keeps the names on it on this device for the
        session, cleared by Reset everything — never sent anywhere.
      </p>
    </div>
  );
}
