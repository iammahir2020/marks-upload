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
import { harvestScan, type HarvestFields, type ScanResult } from './api';
import { findRecordsBySerial, findRecordsByStudentId, saveRecord } from './db';
import type { QuizConfig, StudentRecord } from './types';
import { crossCheck, isLegalValue, sumCheck, type CrossCheckResult } from './validateMarks';

interface ReviewProps {
  result: ScanResult;
  config: QuizConfig;
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

export default function Review({ result, config, imagePreviewUrl, onRetake, onSaved }: ReviewProps) {
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

  const markErrors = useMemo(() => {
    const errs: Record<number, string> = {};
    for (const qc of config.questions) {
      const raw = marks[qc.q];
      if (raw === '') continue; // blank is allowed — flagged, never guessed
      const value = Number(raw);
      if (Number.isNaN(value) || !isLegalValue(value, qc.max)) {
        errs[qc.q] = `Must be a multiple of 0.5 between 0 and ${qc.max}.`;
      }
    }
    return errs;
  }, [marks, config.questions]);
  const hasMarkErrors = Object.keys(markErrors).length > 0;

  const questionValues = config.questions.map((qc) => ({
    q: qc.q,
    value: marks[qc.q] === '' ? null : Number(marks[qc.q]),
  }));
  const total = totalStr === '' ? null : Number(totalStr);
  const { computedSum, matches } = sumCheck(questionValues, total);

  async function commitSave(
    candidate: { studentId: string | null; serial: string | null },
    overwriteId?: string,
  ) {
    const record: StudentRecord = {
      id: overwriteId ?? crypto.randomUUID(),
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
      };
      const confirmed: HarvestFields = {
        studentId: candidate.studentId,
        serial: candidate.serial,
        questions: questionValues.map((qv) => qv.value),
        total,
      };
      fetch(imagePreviewUrl)
        .then((r) => r.blob())
        .then((blob) => harvestScan(blob, config, original, confirmed))
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
      serial: serial.trim() || null,
    };

    // Lookup on save via the by-serial/by-studentId indexes (plan.md §10),
    // not a walk over every record in the session.
    const [bySerial, byId] = await Promise.all([
      candidate.serial ? findRecordsBySerial(candidate.serial) : Promise.resolve([]),
      candidate.studentId ? findRecordsByStudentId(candidate.studentId) : Promise.resolve([]),
    ]);
    const existingById = new Map<string, StudentRecord>();
    [...bySerial, ...byId].forEach((r) => existingById.set(r.id, r));

    const check = crossCheck(candidate, [...existingById.values()]);

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

  const failed = result.status === 'failed';
  const showFailureBanner = failed && !failureDismissed;
  const candidateForConflict = { studentId: studentId.trim() || null, serial: serial.trim() || null };

  return (
    <div className="stack">
      {showFailureBanner && (
        <div className="banner banner-danger" role="alert">
          <strong>Scan failed: {result.failure_reason}</strong>
          <div className="banner-actions">
            <button className="btn btn-secondary btn-sm" onClick={onRetake}>
              Retake
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setFailureDismissed(true)}>
              Enter manually
            </button>
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
            onChange={(e) => setStudentId(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className="field identity-field">
          <span className="field-label">Serial</span>
          <input
            className={`input ${lowConfidence.has('serial') ? 'input-flagged' : ''}`}
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            inputMode="numeric"
          />
        </label>
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
          <div className="row" style={{ flexWrap: 'wrap', rowGap: 14 }}>
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
                />
                {markErrors[qc.q] && (
                  <span role="alert" className="error-text">
                    {markErrors[qc.q]}
                  </span>
                )}
              </div>
            ))}
            <div className="field" style={{ width: '4.5rem' }}>
              <span className="field-hint">Total</span>
              <input
                className={`input ${lowConfidence.has('total') ? 'input-flagged' : ''}`}
                value={totalStr}
                onChange={(e) => setTotalStr(e.target.value)}
                style={{ height: 40, padding: '6px 8px', textAlign: 'center' }}
                inputMode="decimal"
              />
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
            {pendingConflict.action === 'block'
              ? 'Same serial and ID already saved — this script may already be scanned.'
              : 'This serial or ID conflicts with an existing record — one may be misread.'}
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {pendingConflict.conflicts.map((c) => (
              <li key={c.record.id}>
                ID {c.record.studentId ?? '—'} · Serial {c.record.serial ?? '—'} · Total {c.record.total ?? '—'}
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
