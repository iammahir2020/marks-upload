// Results screen (plan.md §11, step.md step 9): the table every confirmed
// record ends up in, inline-editable (9.1), unverified records and the
// record count called out (9.2), the attendance-sheet expectation stated
// plainly (9.3), and the Excel export that's the actual point of the
// whole exercise (9.4).
import { useEffect, useMemo, useState } from 'react';
import ExcelJS from 'exceljs';
import { getAllRecords, resetAll, saveRecord } from './db';
import { sortRecords, unverifiedReason } from './results';
import type { QuestionValue, QuizConfig, StudentRecord } from './types';
import { isLegalValue, sumCheck } from './validateMarks';

interface ResultsProps {
  config: QuizConfig;
  onBack: () => void;
  onReset: () => void;
}

export default function Results({ config, onBack, onReset }: ResultsProps) {
  const [records, setRecords] = useState<StudentRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  async function handleReset() {
    await resetAll();
    onReset();
  }

  useEffect(() => {
    getAllRecords().then((rs) => {
      setRecords(rs);
      setLoaded(true);
    });
  }, []);

  const sorted = useMemo(() => sortRecords(records), [records]);
  const unverifiedCount = useMemo(
    () => records.filter((r) => unverifiedReason(r) !== null).length,
    [records],
  );

  async function updateRecord(updated: StudentRecord) {
    await saveRecord(updated);
    setRecords((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
  }

  async function handleExport() {
    // 9.4 — columns built from QuizConfig, so question columns follow the
    // quiz rather than being hardcoded (stack-reference.md "Excel export").
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Marks');
    ws.columns = [
      { header: 'Serial', key: 'serial', width: 10 },
      { header: 'Student ID', key: 'studentId', width: 16 },
      ...config.questions.map((qc) => ({ header: `Q${qc.q}`, key: `q${qc.q}`, width: 8 })),
      { header: 'Total', key: 'total', width: 10 },
    ];
    ws.getRow(1).font = { bold: true };

    // Explicit `null` for a blank field, never `0` — a blank that exports
    // as zero looks like a real mark of zero and nothing downstream would
    // catch it (step.md step 9's own worst-case warning).
    ws.addRows(
      sorted.map((r) => ({
        serial: r.serial,
        studentId: r.studentId,
        ...Object.fromEntries(
          config.questions.map((qc) => [
            `q${qc.q}`,
            r.questions.find((q) => q.q === qc.q)?.value ?? null,
          ]),
        ),
        total: r.total,
      })),
    );

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${config.quizName || 'quiz'}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!loaded) return null;

  return (
    <div className="page page-wide">
      <div className="app-header">
        <div>
          <span className="eyebrow">{config.quizName}</span>
          <h1>Results</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-danger btn-sm" onClick={() => setConfirmingReset(true)}>
            Reset everything
          </button>
          <button className="btn btn-quiet" onClick={onBack}>
            &larr; Back to scanning
          </button>
        </div>
      </div>

      {confirmingReset && (
        <div className="banner banner-danger" role="alert">
          <p>
            This deletes every saved record and the quiz setup — there's no undo. Make sure
            you've downloaded the Excel file first.
          </p>
          <div className="banner-actions">
            <button className="btn btn-danger-solid btn-sm" onClick={handleReset}>
              Yes, delete everything
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirmingReset(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="row-between">
        <span className="text-sm">
          {records.length} record{records.length === 1 ? '' : 's'}
          {unverifiedCount > 0 && (
            <>
              {' · '}
              <span className="badge badge-warning">{unverifiedCount} unverified</span>
            </>
          )}
        </span>
        <button className="btn btn-primary btn-sm" onClick={handleExport} disabled={records.length === 0}>
          Download Excel
        </button>
      </div>

      {records.length === 0 ? (
        <div className="empty-state">No records saved yet — confirmed scripts will show up here.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th className="col-serial">Serial</th>
                <th className="col-id">Student ID</th>
                {config.questions.map((qc) => (
                  <th key={qc.q} className="col-mark">
                    Q{qc.q}
                  </th>
                ))}
                <th className="col-mark">Total</th>
                <th className="col-check">Check</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((record) => (
                <ResultsRow key={record.id} record={record} config={config} onUpdate={updateRecord} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 9.3 — stated as an expectation, not a surprise (plan.md §10). */}
      <p className="text-sm muted">
        This app has no class list, so it can't tell whether a serial is out of range or a
        student was skipped entirely — check the exported file against your attendance sheet
        for gaps.
      </p>
    </div>
  );
}

interface ResultsRowProps {
  record: StudentRecord;
  config: QuizConfig;
  onUpdate: (record: StudentRecord) => void;
}

function ResultsRow({ record, config, onUpdate }: ResultsRowProps) {
  const [studentId, setStudentId] = useState(record.studentId ?? '');
  const [serial, setSerial] = useState(record.serial ?? '');
  const [marks, setMarks] = useState<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    for (const qc of config.questions) {
      const found = record.questions.find((q) => q.q === qc.q);
      map[qc.q] = found?.value != null ? String(found.value) : '';
    }
    return map;
  });
  const [totalStr, setTotalStr] = useState(record.total != null ? String(record.total) : '');
  const [error, setError] = useState<string | null>(null);

  const questionValues: QuestionValue[] = config.questions.map((qc) => ({
    q: qc.q,
    value: marks[qc.q] === '' ? null : Number(marks[qc.q]),
  }));
  const total = totalStr === '' ? null : Number(totalStr);
  // 9.1's sum check, derived on every render — never stored, same
  // principle as the Review screen (CLAUDE.md "Derive, don't store").
  const { computedSum, matches } = sumCheck(questionValues, total);
  const reason = unverifiedReason(record);

  const markErrors: Record<number, string> = {};
  for (const qc of config.questions) {
    const raw = marks[qc.q];
    if (raw === '') continue; // blank is allowed — flagged, never guessed
    const value = Number(raw);
    if (Number.isNaN(value) || !isLegalValue(value, qc.max)) {
      markErrors[qc.q] = `0–${qc.max}, steps of 0.5`;
    }
  }
  const hasMarkErrors = Object.keys(markErrors).length > 0;

  function commit() {
    const trimmedId = studentId.trim() || null;
    const trimmedSerial = serial.trim() || null;
    // CLAUDE.md: at least one of studentId/serial must be non-null — an
    // edit that would clear both is rejected rather than silently
    // orphaning the record.
    if (!trimmedId && !trimmedSerial) {
      setError('Needs a student ID or a serial — edit not saved.');
      return;
    }
    if (hasMarkErrors) {
      setError('Fix the highlighted mark — edit not saved.');
      return;
    }
    setError(null);
    onUpdate({ ...record, studentId: trimmedId, serial: trimmedSerial, questions: questionValues, total });
  }

  return (
    <tr className={reason ? 'unverified' : undefined} title={error ?? undefined}>
      <td>
        <input className="cell-input" value={serial} onChange={(e) => setSerial(e.target.value)} onBlur={commit} />
      </td>
      <td>
        <input
          className="cell-input"
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          onBlur={commit}
        />
      </td>
      {config.questions.map((qc) => (
        <td key={qc.q} className="col-mark">
          <input
            className={`cell-input ${markErrors[qc.q] ? 'input-error' : ''}`}
            value={marks[qc.q]}
            onChange={(e) => setMarks((m) => ({ ...m, [qc.q]: e.target.value }))}
            onBlur={commit}
          />
        </td>
      ))}
      <td className="col-mark">
        <input className="cell-input" value={totalStr} onChange={(e) => setTotalStr(e.target.value)} onBlur={commit} />
      </td>
      <td>
        {error ? (
          <span className="badge badge-danger">{error}</span>
        ) : (
          <span className={matches ? 'check-ok' : 'check-fail'}>{matches ? '✓' : `✗ (${computedSum})`}</span>
        )}
        {reason && (
          <span className="badge badge-warning" style={{ marginLeft: 6 }}>
            {reason}
          </span>
        )}
      </td>
    </tr>
  );
}
