// Review screen (plan.md §10-11, step.md step 7): the correctness layer
// between a raw ScanResult and a saved StudentRecord.
//
// - 7.1 Identity fields render first and largest, above the marks — the
//   instructor is holding the script, and this is the highest-value check.
// - 7.2 Marks and total are editable, next to the capture for comparison.
// - 7.3 The sum check is recomputed from current field state on every
//   render — never stored, so it can't go stale behind an edit.
// - 7.4 A manual edit is rejected if it isn't a legal 0.5-step value in
//   range, same as the backend already enforces on Gemini's output.
// - 7.5 Save runs plan.md §10's identity cross-check via db.ts's
//   serial/studentId indexes, not a walk over every record.
// - 7.6 A failed scan lands here too, with empty fields, the reason shown,
//   and Retake/Enter-manually — never a dead end.
import { useMemo, useState } from 'react';
import { harvestScan, type HarvestFields, type ScanResult, type TableMismatch } from './api';
import { findRecordsBySerial, findRecordsByStudentId, getShareCrops, saveRecord } from './db';
import { matchAgainstRoster } from './rosterMatch';
import type { ParsedRoster } from './roster';
import { hasSerialBox } from './sections';
import type { QuizConfig, StudentRecord } from './types';
import {
  crossCheck,
  isCompleteId,
  isValidSerial,
  parseMarkField,
  sumCheck,
  type CrossCheckResult,
} from './validateMarks';

interface ReviewProps {
  result: ScanResult;
  config: QuizConfig;
  // Step.md step 13 — every saved record belongs to one Assessment.
  assessmentId: string;
  // Step.md 13.13 — Review renders as a fixed overlay (see Scan.tsx's own
  // comment on why) covering Scan's header entirely, which means the
  // section context that header shows is invisible at the exact moment
  // the instructor is deciding whether to Confirm a save — the highest-
  // value place for it to be visible, not the lowest. Optional/defaulted
  // so every existing caller and test render is unaffected.
  sectionLabel?: string;
  // Step.md 12.10/12.11 — optional and defaulted to null so every existing
  // caller (Scan.tsx in plain mode, all 15 pre-existing test renders)
  // keeps working unchanged; the not-on-list/name UI below simply doesn't
  // render when there's no class list to check against.
  roster?: ParsedRoster | null;
  imagePreviewUrl?: string;
  onRetake: () => void;
  onSaved: (record: StudentRecord) => void;
}

function marksFromResult(config: QuizConfig, result: ScanResult): Record<number, string> {
  const map: Record<number, string> = {};
  for (const qc of config.questions) {
    const found = result.questions.find((q) => q.q === qc.q);
    map[qc.q] = found?.value != null ? String(found.value) : '';
  }
  return map;
}

// What one field needs to tell the instructor, if anything. A mark field is
// 4.5rem wide, so this is a word or two, never a sentence: the sentence is
// said once for the whole card (see the notes above the marks grid).
type FieldStatus =
  | { tone: 'danger'; label: 'Invalid' }
  | { tone: 'warning'; label: 'Unclear' | 'Crossed out'; options: string[] }
  | null;

// Precedence: something the instructor typed that can't be saved beats
// anything the scan said. A scan note only shows while the field is still
// blank (issues.md N33's rule) — once a value is typed, that value is the
// answer and the note has done its job.
function fieldStatus(
  key: string,
  value: string,
  error: string | null,
  unmatched: Set<string>,
  crossedOut: Set<string>,
  suggestions: Record<string, string>,
  choices: Record<string, string[]> = {},
): FieldStatus {
  if (error) return { tone: 'danger', label: 'Invalid' };
  if (value) return null;
  // Every one-tap reading the scan has. `choices` holds two or more when
  // the reader couldn't pick (15 or 1.5 — both legal, a point that may or
  // may not be there); otherwise the single older `suggestion`.
  const options = choices[key] ?? (suggestions[key] !== undefined ? [suggestions[key]] : []);
  // Step 15 — crossed out is the more specific reason, so it wins.
  if (crossedOut.has(key)) return { tone: 'warning', label: 'Crossed out', options };
  if (unmatched.has(key)) return { tone: 'warning', label: 'Unclear', options };
  return null;
}

// The status word, plus a one-tap Use per candidate reading. The field
// itself stays empty until one is tapped: a suggestion is never a value
// filled in on the instructor's behalf — least of all when there are two.
function FieldStatusView({
  status,
  onUse,
  inline = false,
}: {
  status: FieldStatus;
  onUse: (value: string) => void;
  inline?: boolean;
}) {
  if (!status) return null;
  const options = status.tone === 'warning' ? status.options : [];
  return (
    <span className={`field-status${inline ? ' field-status-inline' : ''}`}>
      <span className={`field-status-label tone-${status.tone}`}>{status.label}</span>
      {options.map((option) => (
        <button key={option} type="button" className="btn btn-secondary btn-use" onClick={() => onUse(option)}>
          Use {option}
        </button>
      ))}
    </span>
  );
}

// One line per table the scan couldn't read. The backend's counts include
// the label column, so the ID row reports "8 columns" for 7 digit boxes.
export function describeMismatch(m: TableMismatch, questionCount: number): string {
  if (m.table === 'id') {
    return `Student ID row: found ${m.found - 1} digit boxes, expected ${m.expected - 1}.`;
  }
  if (m.table === 'serial') {
    return `Serial row: found ${m.found} boxes, expected ${m.expected}.`;
  }
  return `Marks table: found ${m.found} columns, expected ${m.expected} (${questionCount} questions + Total).`;
}

// Keeps the capture on the phone, for adding to the detector's test photos
// later. A plain download of the blob URL Scan.tsx already holds: the same
// bytes the backend saw, nothing uploaded, nothing stored server-side. The
// name carries the reason and the time, never anything read off the script.
function SavePhotoButton({ url, reason }: { url?: string; reason: string }) {
  if (!url) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return (
    <a className="btn btn-secondary btn-sm" href={url} download={`scan-${reason}-${stamp}.jpg`}>
      Save photo
    </a>
  );
}

export default function Review({
  result,
  config,
  assessmentId,
  sectionLabel,
  roster = null,
  imagePreviewUrl,
  onRetake,
  onSaved,
}: ReviewProps) {
  // Step 16 (plan.md §21) — false only for a quiz printed without a Serial
  // box. Every branch on it below leaves today's behaviour untouched when
  // true.
  const hasSerial = hasSerialBox(config);
  const [studentId, setStudentId] = useState(result.student_id ?? '');
  const [serial, setSerial] = useState(result.serial ?? '');
  const [marks, setMarks] = useState<Record<number, string>>(() => marksFromResult(config, result));
  const [totalStr, setTotalStr] = useState(
    result.total?.value != null ? String(result.total.value) : '',
  );
  const [failureDismissed, setFailureDismissed] = useState(false);
  const [pendingConflict, setPendingConflict] = useState<CrossCheckResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const lowConfidence = useMemo(() => new Set(result.low_confidence_fields), [result]);
  // issues.md N31/N33 — a strict subset of lowConfidence: ink was present
  // but nothing legal matched it, as opposed to the cell being genuinely
  // blank. Drives a specific explanatory message below instead of the
  // unexplained blank that used to push the instructor into typing a
  // workaround value (which N31 fixes on the harvesting side; this is
  // the other half — telling them why, so they don't need to guess).
  const unmatched = useMemo(() => new Set(result.unmatched_fields), [result]);
  // Step 15 — the student struck something out in these fields. The value
  // was left blank on purpose; `suggestions` holds what the rest of the
  // cell reads as, applied only by an explicit tap, never pre-filled.
  const crossedOut = useMemo(() => new Set(result.crossed_out_fields ?? []), [result]);
  const suggestions = result.suggestions ?? {};
  const choices = result.choices ?? {};

  // Step.md 12.10 — recomputed on every render from the live field value,
  // the same "derive, don't store" discipline the sum check already
  // follows below: a stale match cached from an earlier value would be
  // wrong the instant the instructor corrects the field.
  const rosterMatch = useMemo(
    () => matchAgainstRoster(studentId, config.idDigits, roster),
    [studentId, config.idDigits, roster],
  );

  const markErrors = useMemo(() => {
    const errs: Record<number, string> = {};
    for (const qc of config.questions) {
      const { error } = parseMarkField(marks[qc.q] ?? '', qc.max);
      if (error) errs[qc.q] = error;
    }
    return errs;
  }, [marks, config.questions]);

  // 7.4 applied to Total as well, which it never was (issues.md #4). Total
  // is checked against totalMax rather than a question's own max, but by the
  // same rule and the same helper as every other editable field — "abc" is
  // rejected here instead of being stored as NaN on a confirmed record.
  const totalError = useMemo(
    () => parseMarkField(totalStr, config.totalMax).error,
    [totalStr, config.totalMax],
  );

  const hasMarkErrors = Object.keys(markErrors).length > 0 || totalError !== null;

  const questionStatus: Record<number, FieldStatus> = {};
  for (const qc of config.questions) {
    questionStatus[qc.q] = fieldStatus(
      `q${qc.q}`, marks[qc.q] ?? '', markErrors[qc.q] ?? null, unmatched, crossedOut, suggestions, choices,
    );
  }
  const totalStatus = fieldStatus('total', totalStr, totalError, unmatched, crossedOut, suggestions, choices);
  const markStatuses = [...Object.values(questionStatus), totalStatus];
  // One explanation per card, not per field — the 4.5rem fields only have
  // room for the status word.
  const anyInvalid = markStatuses.some((s) => s?.tone === 'danger');
  const anyUnread = markStatuses.some((s) => s?.tone === 'warning');
  const anySuggestion = markStatuses.some((s) => s?.tone === 'warning' && s.options.length > 0);
  const anyTie = markStatuses.some((s) => s?.tone === 'warning' && s.options.length > 1);

  const questionValues = config.questions.map((qc) => ({
    q: qc.q,
    value: parseMarkField(marks[qc.q] ?? '', qc.max).value,
  }));
  const total = parseMarkField(totalStr, config.totalMax).value;
  const { computedSum, matches } = sumCheck(questionValues, total);

  async function commitSave(
    candidate: { studentId: string | null; serial: string | null },
    overwriteId?: string,
  ) {
    const record: StudentRecord = {
      id: overwriteId ?? crypto.randomUUID(),
      assessmentId,
      studentId: candidate.studentId,
      serial: candidate.serial,
      questions: questionValues,
      total,
      confirmed: true,
      capturedAt: new Date().toISOString(),
    };
    await saveRecord(record);
    setPendingConflict(null);
    onSaved(record);

    // Step 3r.6c — fire and forget, deliberately not awaited: harvesting
    // training data must never delay the confirm->next-capture loop
    // (step 8's own "no added tap" rule) or be mistaken for a save
    // failure if it errors. Every digit the instructor just confirmed or
    // corrected is a labelled crop of real handwriting, captured now even
    // though nothing consumes it yet (plan.md §16).
    if (imagePreviewUrl) {
      const original: HarvestFields = {
        studentId: result.student_id,
        serial: result.serial,
        questions: config.questions.map(
          (qc) => result.questions.find((q) => q.q === qc.q)?.value ?? null,
        ),
        total: result.total?.value ?? null,
        // issues.md N31 — the backend refuses to harvest any of these
        // regardless of what commitSave's confirmed values below say.
        unmatchedFields: result.unmatched_fields,
        // Step 15 — likewise refused: the crop still holds the struck-out
        // answer, whatever the confirmed value below is.
        crossedOutFields: result.crossed_out_fields ?? [],
      };
      const confirmed: HarvestFields = {
        studentId: candidate.studentId,
        serial: candidate.serial,
        questions: questionValues.map((qv) => qv.value),
        total,
        unmatchedFields: [], // meaningless on this side — see api.ts's comment
        crossedOutFields: [],
      };
      // issues.md N45 — only when the instructor hasn't turned sharing off
      // (Library.tsx). Read here, inside the fire-and-forget chain, so the
      // setting costs the confirm loop nothing.
      const previewUrl = imagePreviewUrl;
      getShareCrops()
        .then((share) => {
          if (!share) return;
          return fetch(previewUrl)
            .then((r) => r.blob())
            .then((blob) => harvestScan(blob, config, original, confirmed));
        })
        .catch(() => {
          // Best-effort — see the comment above.
        });
    }
  }

  async function handleConfirm() {
    setSaveError(null);
    if (hasMarkErrors) return;

    const candidate = {
      studentId: studentId.trim() || null,
      serial: hasSerial ? serial.trim() || null : null,
    };

    // Step 16 — with no Serial box the ID is the only identifier, so it is
    // required rather than one of two.
    if (!hasSerial && candidate.studentId === null) {
      setSaveError('Enter the student ID before saving — this quiz has no serial to fall back on.');
      return;
    }

    // An ID is allowed to be absent — that saves an unverified record, which
    // plan.md §10 permits. What is NOT allowed is a PARTIAL one: both
    // recognizers return "?" for a position they could not read, so a
    // flagged scan pre-fills something like "12?4567", and nothing stopped
    // that being confirmed and exported verbatim (issues.md N5). Blocking
    // rather than silently blanking it, so the instructor either finishes
    // the correction or clears the field deliberately.
    if (candidate.studentId !== null && !isCompleteId(candidate.studentId, config.idDigits)) {
      setSaveError(
        `Student ID must be exactly ${config.idDigits} digits — replace anything unreadable, or clear the field to save without it.`,
      );
      return;
    }

    // Same rule for the serial (issues.md N21). It was the one identity
    // field nothing validated on either side of the wire: `resultsTable.ts`
    // sorts by `Number(serial)`, so a non-numeric one has no defined place
    // in the exported table, and it also becomes a path segment in
    // /api/harvest's storage key. `marks.py`'s validate_serial enforces the
    // identical rule on what a recognizer returns.
    if (candidate.serial !== null && !isValidSerial(candidate.serial)) {
      setSaveError(
        'Serial must be a number (up to 4 digits) — or clear the field to save without it.',
      );
      return;
    }

    // Lookup on save via the by-serial/by-studentId indexes (plan.md §10),
    // not a walk over every record in the session. Scoped to THIS
    // assessment (step.md 13.15) — a shared serial or ID across two
    // different courses is normal and must not raise a conflict.
    const [bySerial, byId] = await Promise.all([
      candidate.serial ? findRecordsBySerial(candidate.serial, assessmentId) : Promise.resolve([]),
      candidate.studentId ? findRecordsByStudentId(candidate.studentId, assessmentId) : Promise.resolve([]),
    ]);
    const existingById = new Map<string, StudentRecord>();
    [...bySerial, ...byId].forEach((r) => existingById.set(r.id, r));

    const check = crossCheck(candidate, [...existingById.values()], hasSerial);

    if (check.action === 'block' && check.conflicts.length === 0) {
      setSaveError('Enter at least a student ID or a serial before saving.');
      return;
    }
    if (check.action === 'block' || check.action === 'warn') {
      setPendingConflict(check);
      return; // wait for Overwrite / Save anyway / Cancel below
    }

    await commitSave(candidate);
  }

  // Editing either identity field invalidates a pending conflict, so it is
  // dropped and Confirm re-enabled (issues.md #5).
  //
  // The bug this closes: the conflict panel captured the matched record at
  // the moment Confirm was pressed, and Confirm was disabled while it was
  // showing — so an instructor who spotted that the serial had been misread
  // and corrected it had no way to re-run the check. "Overwrite earlier
  // record" then wrote the corrected values on top of a record that the
  // corrected values no longer conflict with: someone else's.
  //
  // Only the identity fields clear it. A marks edit cannot change which
  // record matched, and commitSave already reads the current marks.
  function editIdentity(setter: (v: string) => void, value: string) {
    setter(value);
    setPendingConflict(null);
    setSaveError(null);
  }

  const failed = result.status === 'failed';
  const showFailureBanner = failed && !failureDismissed;
  const mismatches = result.table_mismatches ?? [];
  const candidateForConflict = {
    studentId: studentId.trim() || null,
    serial: hasSerial ? serial.trim() || null : null,
  };

  return (
    <div className="stack">
      {/* Step.md 13.13 — the one place in the whole confirm loop where the
          section context would otherwise be invisible. */}
      {sectionLabel && <span className="eyebrow">{sectionLabel}</span>}
      {showFailureBanner && (
        <div className="banner banner-danger" role="alert">
          <strong>Scan failed: {result.failure_reason}</strong>
          {/* Step 16 — the two paper layouts put a different box where the
              other expects one, so a Serial setting that doesn't match the
              paper fails exactly this way. */}
          {result.failure_reason === 'column_count_mismatch' && (
            <p className="text-sm" style={{ margin: 0 }}>
              {hasSerial
                ? 'If this paper has a Name/Section table instead of a Serial box, untick “Serial box on paper” for this quiz.'
                : 'This quiz is set to “no Serial box” — if the paper has one, the setting is wrong.'}{' '}
              Also check the number of questions matches the paper.
            </p>
          )}
          <div className="banner-actions">
            <button className="btn btn-secondary btn-sm" onClick={onRetake}>
              Retake
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setFailureDismissed(true)}>
              Enter manually
            </button>
            <SavePhotoButton url={imagePreviewUrl} reason={result.failure_reason ?? 'failed'} />
          </div>
        </div>
      )}
      {mismatches.length > 0 && (
        <div className="banner banner-warning" role="status">
          <strong>Part of this script couldn’t be read</strong>
          <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
            {mismatches.map((m) => (
              <li key={m.table}>{describeMismatch(m, config.questions.length)}</li>
            ))}
          </ul>
          <p className="text-sm" style={{ margin: 0 }}>
            Everything else was read as normal. Type the missing fields from the script, or retake the photo.
          </p>
          <div className="banner-actions">
            <button className="btn btn-secondary btn-sm" onClick={onRetake}>
              Retake
            </button>
            <SavePhotoButton url={imagePreviewUrl} reason="partial" />
          </div>
        </div>
      )}

      {/* 7.1 — identity fields, first and largest on the screen. */}
      <div className="stack-sm">
        <label className="field identity-field">
          <span className="field-label">Student ID</span>
          <input
            className={`input ${lowConfidence.has('student_id') ? 'input-flagged' : ''}`}
            value={studentId}
            onChange={(e) => editIdentity(setStudentId, e.target.value)}
            inputMode="numeric"
          />
          {/* Step.md 12.11 — the resolved name, so a misread ID is visible
              against the script in hand, not just a digit string. */}
          {rosterMatch.status === 'matched' && (
            <span className="field-hint">{rosterMatch.student.studentName}</span>
          )}
          {/* Step.md 12.10 — flagged, never silently accepted or corrected:
              a script genuinely can belong to a typo'd ID or a student not
              on this list (a walk-in, an add after the roster was pulled),
              so this warns without blocking Confirm. A suggestion is only
              ever offered when it is the UNIQUE explanation (rosterMatch.ts)
              and is applied by the same explicit tap every other identity
              correction already requires — never automatically. */}
          {rosterMatch.status === 'not-on-list' && (
            <div className="stack-sm" style={{ gap: 4 }}>
              <span className="badge badge-warning" style={{ width: 'fit-content' }}>
                Not on your class list
              </span>
              {rosterMatch.suggestion && (
                <span className="text-sm">
                  Did you mean{' '}
                  <strong>
                    {rosterMatch.suggestion.studentId} — {rosterMatch.suggestion.studentName}
                  </strong>
                  ?{' '}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => editIdentity(setStudentId, rosterMatch.suggestion!.studentId)}
                  >
                    Use this
                  </button>
                </span>
              )}
            </div>
          )}
          {/* Step 15 — no suggestion for the ID: the correction goes in the
              same box or outside it, where nothing reads it. A class list's
              own one-candidate match above covers a single "?". */}
          {crossedOut.has('student_id') && studentId.includes('?') && (
            <span className="field-status-label tone-warning">A digit was crossed out — check the script</span>
          )}
        </label>
        {hasSerial && (
        <label className="field identity-field">
          <span className="field-label">Serial</span>
          <input
            className={`input ${lowConfidence.has('serial') ? 'input-flagged' : ''}`}
            value={serial}
            onChange={(e) => editIdentity(setSerial, e.target.value)}
            inputMode="numeric"
          />
          <FieldStatusView
            status={fieldStatus('serial', serial, null, new Set(), crossedOut, suggestions)}
            onUse={(v) => editIdentity(setSerial, v)}
            inline
          />
        </label>
        )}
      </div>

      {/* 7.2 — marks, editable, beside the capture for comparison. */}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {imagePreviewUrl && (
          <img
            src={imagePreviewUrl}
            alt="captured grid"
            style={{
              width: 120,
              height: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              flexShrink: 0,
            }}
          />
        )}
        <div className="card" style={{ flex: 1, padding: 14 }}>
          {/* The explanation, said once. Each field below carries only a
              status word; this is where the instructor learns what the
              words mean and what to do about them. */}
          {anyInvalid && (
            <p role="alert" className="review-note tone-danger">
              Marks go from 0 up to the max shown, in steps of 0.5.
            </p>
          )}
          {anyUnread && (
            <p className="review-note tone-warning">
              Check the highlighted marks against the script{anySuggestion ? ', or tap Use to accept a reading' : ''}.
              {anyTie && ' Where two readings are offered, the point is unclear — pick the one written on the script.'}
            </p>
          )}
          {/* flex-start, not the row's default centring: a field with a
              status line under it is taller than one without, and centring
              pushed their inputs out of line with each other. */}
          <div className="row" style={{ flexWrap: 'wrap', rowGap: 14, alignItems: 'flex-start' }}>
            {config.questions.map((qc) => (
              <div key={qc.q} className="field" style={{ width: '4.5rem' }}>
                <span className="field-hint">
                  Q{qc.q} <span className="muted">/{qc.max}</span>
                </span>
                <input
                  className={`input ${markErrors[qc.q] ? 'input-error' : lowConfidence.has(`q${qc.q}`) ? 'input-flagged' : ''}`}
                  value={marks[qc.q]}
                  onChange={(e) => setMarks((m) => ({ ...m, [qc.q]: e.target.value }))}
                  style={{ height: 40, padding: '6px 8px', textAlign: 'center' }}
                  inputMode="decimal"
                  aria-label={`Q${qc.q}, out of ${qc.max}`}
                  aria-invalid={markErrors[qc.q] ? true : undefined}
                />
                <FieldStatusView
                  status={questionStatus[qc.q]}
                  onUse={(v) => setMarks((m) => ({ ...m, [qc.q]: v }))}
                />
              </div>
            ))}
            <div className="field" style={{ width: '4.5rem' }}>
              <span className="field-hint">
                Total <span className="muted">/{config.totalMax}</span>
              </span>
              <input
                className={`input ${totalError ? 'input-error' : lowConfidence.has('total') ? 'input-flagged' : ''}`}
                value={totalStr}
                onChange={(e) => setTotalStr(e.target.value)}
                style={{ height: 40, padding: '6px 8px', textAlign: 'center' }}
                inputMode="decimal"
                aria-label={`Total, out of ${config.totalMax}`}
                aria-invalid={totalError ? true : undefined}
              />
              <FieldStatusView status={totalStatus} onUse={setTotalStr} />
            </div>
          </div>

          {/* 7.3 — sum check, derived on every render. */}
          <hr className="divider" style={{ margin: '14px 0 10px' }} />
          <span className={matches ? 'check-ok' : 'check-fail'}>
            Sum check: {computedSum} vs printed {total ?? '—'} {matches ? '✓' : '✗'}
          </span>
        </div>
      </div>

      {/* 7.5 — identity cross-check outcome, shown only once a save is attempted. */}
      {pendingConflict && pendingConflict.conflicts.length > 0 && (
        <div className="banner banner-warning" role="alert">
          <p>
            {!hasSerial
              ? 'This student ID is already saved — this script may already be scanned. If the ID is misread, correct it above.'
              : pendingConflict.action === 'block'
                ? 'Same serial and ID already saved — this script may already be scanned.'
                : 'This serial or ID conflicts with an existing record — one may be misread.'}
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {pendingConflict.conflicts.map((c) => (
              <li key={c.record.id}>
                ID {c.record.studentId ?? '—'}
                {hasSerial && <> · Serial {c.record.serial ?? '—'}</>} · Total {c.record.total ?? '—'}
              </li>
            ))}
          </ul>
          {pendingConflict.action === 'block' ? (
            <div className="banner-actions">
              <button
                className="btn btn-danger-solid btn-sm"
                onClick={() => commitSave(candidateForConflict, pendingConflict.conflicts[0].record.id)}
              >
                Overwrite earlier record
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setPendingConflict(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="banner-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => commitSave(candidateForConflict)}>
                Save anyway
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setPendingConflict(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {saveError && (
        <p role="alert" className="error-text">
          {saveError}
        </p>
      )}

      <div className="row">
        <button className="btn btn-secondary" onClick={onRetake}>
          Retake
        </button>
        <button
          className="btn btn-primary flex-1"
          onClick={handleConfirm}
          disabled={hasMarkErrors || !!pendingConflict}
        >
          Confirm &amp; next &rarr;
        </button>
      </div>
    </div>
  );
}
