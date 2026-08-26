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
import type { ScanResult } from './api';
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

const flagStyle = { background: 'var(--code-bg)', borderColor: '#c60' };

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
    <div style={{ textAlign: 'left', maxWidth: 640, margin: '0 auto' }}>
      {showFailureBanner && (
        <div role="alert" style={{ border: '2px solid #c00', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' }}>
          <p style={{ marginBottom: '0.5rem' }}>Scan failed: {result.failure_reason}</p>
          <button onClick={onRetake}>Retake</button>{' '}
          <button onClick={() => setFailureDismissed(true)}>Enter manually</button>
        </div>
      )}

      {/* 7.1 — identity fields, first and largest on the screen. */}
      <div style={{ marginBottom: '1.5rem' }}>
        <label style={{ display: 'block', marginBottom: '0.5rem' }}>
          <span style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text)' }}>Student ID</span>
          <input
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            style={{
              fontSize: '2rem',
              fontWeight: 600,
              width: '100%',
              padding: '0.25rem 0.5rem',
              border: `2px solid ${lowConfidence.has('student_id') ? '#c60' : 'var(--border)'}`,
              borderRadius: 6,
            }}
          />
        </label>
        <label style={{ display: 'block' }}>
          <span style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text)' }}>Serial</span>
          <input
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            style={{
              fontSize: '2rem',
              fontWeight: 600,
              width: '100%',
              padding: '0.25rem 0.5rem',
              border: `2px solid ${lowConfidence.has('serial') ? '#c60' : 'var(--border)'}`,
              borderRadius: 6,
            }}
          />
        </label>
      </div>

      {/* 7.2 — marks, editable, beside the capture for comparison. */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
        {imagePreviewUrl && (
          <img
            src={imagePreviewUrl}
            alt="captured grid"
            style={{ width: 200, height: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}
          />
        )}
        <div style={{ flex: 1 }}>
          {config.questions.map((qc) => (
            <label key={qc.q} style={{ display: 'inline-block', marginRight: '0.75rem', marginBottom: '0.5rem' }}>
              <span style={{ display: 'block', fontSize: '0.8rem' }}>
                Q{qc.q} (max {qc.max})
              </span>
              <input
                value={marks[qc.q]}
                onChange={(e) => setMarks((m) => ({ ...m, [qc.q]: e.target.value }))}
                style={{
                  width: '4rem',
                  ...(lowConfidence.has(`q${qc.q}`) || markErrors[qc.q] ? flagStyle : {}),
                  border: `1px solid ${markErrors[qc.q] ? '#c00' : lowConfidence.has(`q${qc.q}`) ? '#c60' : 'var(--border)'}`,
                }}
              />
              {markErrors[qc.q] && (
                <span role="alert" style={{ display: 'block', fontSize: '0.75rem', color: '#c00' }}>
                  {markErrors[qc.q]}
                </span>
              )}
            </label>
          ))}
          <label style={{ display: 'block', marginTop: '0.5rem' }}>
            <span style={{ display: 'block', fontSize: '0.8rem' }}>Total</span>
            <input
              value={totalStr}
              onChange={(e) => setTotalStr(e.target.value)}
              style={{
                width: '4rem',
                border: `1px solid ${lowConfidence.has('total') ? '#c60' : 'var(--border)'}`,
              }}
            />
          </label>
        </div>
      </div>

      {/* 7.3 — sum check, derived on every render. */}
      <p style={{ marginTop: '1rem', color: matches ? undefined : '#c00' }}>
        Sum check: {computedSum} vs printed {total ?? '—'} {matches ? '✓' : '✗'}
      </p>

      {/* 7.5 — identity cross-check outcome, shown only once a save is attempted. */}
      {pendingConflict && pendingConflict.conflicts.length > 0 && (
        <div role="alert" style={{ border: '2px solid #c60', borderRadius: 6, padding: '0.75rem 1rem', margin: '1rem 0' }}>
          <p>
            {pendingConflict.action === 'block'
              ? 'Same serial and ID already saved — this script may already be scanned.'
              : 'This serial or ID conflicts with an existing record — one may be misread.'}
          </p>
          <ul>
            {pendingConflict.conflicts.map((c) => (
              <li key={c.record.id}>
                ID {c.record.studentId ?? '—'} · Serial {c.record.serial ?? '—'} · Total {c.record.total ?? '—'}
              </li>
            ))}
          </ul>
          {pendingConflict.action === 'block' ? (
            <>
              <button onClick={() => commitSave(candidateForConflict, pendingConflict.conflicts[0].record.id)}>
                Overwrite earlier record
              </button>{' '}
              <button onClick={() => setPendingConflict(null)}>Cancel</button>
            </>
          ) : (
            <>
              <button onClick={() => commitSave(candidateForConflict)}>Save anyway</button>{' '}
              <button onClick={() => setPendingConflict(null)}>Cancel</button>
            </>
          )}
        </div>
      )}

      {saveError && (
        <p role="alert" style={{ color: '#c00' }}>
          {saveError}
        </p>
      )}

      <div style={{ marginTop: '1rem' }}>
        <button onClick={onRetake}>Retake</button>{' '}
        <button onClick={handleConfirm} disabled={hasMarkErrors || !!pendingConflict}>
          Confirm & next →
        </button>
      </div>
    </div>
  );
}
