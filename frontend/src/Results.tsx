// Results screen (plan.md §11, step.md step 9): the table every confirmed
// record ends up in, inline-editable (9.1), unverified records and the
// record count called out (9.2), the attendance-sheet expectation stated
// plainly (9.3), and the Excel export that's the actual point of the
// whole exercise (9.4).
//
// Step.md step 12.5-12.8 (plan.md §17, Phase B) added a second export
// path here: when `rosterUpload` is present (a class-list workbook was
// confirmed at Setup), the instructor can also write this quiz's results
// as a new sheet into their own file, alongside the plain download —
// which stays exactly as it was, unconditionally, as the escape hatch
// plan.md §17 names it. ExcelJS is already a static import below because
// Results itself is lazy-loaded as a whole screen (App.tsx) — no separate
// dynamic import is needed here the way Setup.tsx's upload UI requires.
import { useEffect, useMemo, useState } from 'react';
import ExcelJS from 'exceljs';
import { getAllRecords, resetAll, saveRecord } from './db';
import { buildExamSheet, type ExamSheetResult } from './examSheet';
import { sortRecords, unverifiedReason } from './results';
import type { ParsedRoster, RosterUpload } from './roster';
import { matchAgainstRoster } from './rosterMatch';
import type { QuestionValue, QuizConfig, StudentRecord } from './types';
import { parseMarkField, sumCheck } from './validateMarks';
import {
  findSheetCollision,
  sanitizeSheetName,
  writeExamSheet,
  writeTotalsColumn,
  type SheetCollision,
} from './workbookExport';

// One place for the anchor-attach-then-delayed-revoke dance (issues.md
// N7), shared by both export paths now rather than duplicated: attached
// to the document before clicking (`click()` on a detached anchor is a
// no-op in some browsers) and revoked on a LATER tick (revoking
// synchronously can abort the download before the browser has read from
// it — iOS Safari being the documented case, and this app's whole purpose
// is a phone).
// `BlobPart` (lib.dom, no @types/node needed) rather than naming ExcelJS's
// own `writeBuffer()` return type directly — that type is Node's `Buffer`,
// which node_modules/exceljs can reference under `skipLibCheck` without
// `@types/node` ever needing to be in this tsconfig's global scope, but
// this file is checked for real and can't name it. A Node `Buffer` is
// itself a valid `BlobPart` at runtime (it's a `Uint8Array`), so nothing
// about the actual value changes — only how it's typed here.
function triggerDownload(buffer: BlobPart, filename: string) {
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 30_000);
}

// State for the confirm prompt between clicking "Export into class
// marksheet" and the actual write. Holds a workbook already loaded fresh
// from `rosterUpload.workbookBytes` — never the original bytes themselves
// — so cancelling and re-triggering costs nothing and can't leave a
// half-written workbook lying around in state. `result` is computed once
// here and reused by finishWorkbookExport, rather than rebuilt — it's also
// what the coverage summary and duplicate block below read from.
//
// Step.md 12.12 — this panel is now ALWAYS shown on a workbook-mode
// export, not only when a name needed sanitising or collided. Before
// 12.12, an export with nothing to confirm skipped straight to the write
// (this app's general "don't add a tap" rule, applied to export). 12.12's
// own coverage requirement — "list who is missing before the download" —
// means there is now always at least ONE fact worth showing, so the
// shortcut is gone rather than kept as a second, inconsistent path.
interface PendingWorkbookExport {
  workbook: ExcelJS.Workbook;
  sanitizedName: string;
  nameChanged: boolean;
  collision: SheetCollision | null;
  result: ExamSheetResult;
}

// A quiz name is user text and becomes a filename. Stripping the characters
// that are illegal or path-bearing on the platforms this lands on, so a quiz
// called "CSE211L/Q1" downloads as a file rather than failing or being
// interpreted as a path (issues.md N7).
function exportFilename(quizName: string): string {
  const base = quizName
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
  return `${base || 'quiz'}.xlsx`;
}

interface ResultsProps {
  config: QuizConfig;
  // Optional and defaulted to null rather than required: every existing
  // call site (App.tsx's saved-config quick-start, every test render)
  // predates this and passes nothing — plain mode must stay exactly as it
  // was, byte for byte, for anyone who never uploaded a workbook.
  rosterUpload?: RosterUpload | null;
  onBack: () => void;
  onReset: () => void;
}

export default function Results({ config, rosterUpload = null, onBack, onReset }: ResultsProps) {
  const [records, setRecords] = useState<StudentRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [pendingWorkbookExport, setPendingWorkbookExport] = useState<PendingWorkbookExport | null>(null);
  const [workbookExportError, setWorkbookExportError] = useState<string | null>(null);
  // Step.md 12.13 — off by default: this is the only export operation that
  // writes into a sheet the instructor authored rather than one this app
  // created, so it needs an explicit opt-in rather than happening because
  // the roster export itself was requested.
  const [includeTotalsColumn, setIncludeTotalsColumn] = useState(false);

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
    () => records.filter((r) => unverifiedReason(r, config.idDigits) !== null).length,
    [records, config.idDigits],
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
      ...config.questions.map((qc) => ({ header: `Q${qc.q} (${qc.max})`, key: `q${qc.q}`, width: 8 })),
      { header: `Total (${config.totalMax})`, key: 'total', width: 10 },
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
    triggerDownload(buffer, exportFilename(config.quizName));
  }

  // Step.md 12.5-12.8 — the second export path, only reachable when a
  // class-list workbook was confirmed at Setup. Always starts from
  // `rosterUpload.workbookBytes`, the ORIGINAL upload, never a workbook
  // instance kept around from an earlier export in this same session —
  // that's what makes exporting the same quiz twice produce one sheet
  // rather than two (plan.md §17): each run starts from the same pristine
  // bytes and re-decides the same name/collision from scratch.
  async function handleWorkbookExportClick() {
    if (!rosterUpload) return;
    setWorkbookExportError(null);

    const sanitized = sanitizeSheetName(config.quizName);
    if (sanitized.name === '') {
      // Only reachable if the quiz name is made ENTIRELY of characters
      // Excel's own sheet-name rule forbids (e.g. "???") — validateConfig
      // already requires a non-empty name, so this is a narrow edge, but
      // an unwritable sheet name must never fail silently.
      setWorkbookExportError(
        "This quiz's name can't become a valid sheet name — rename it in Setup and try again.",
      );
      return;
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(rosterUpload.workbookBytes);
    const collision = findSheetCollision(workbook, sanitized.name, rosterUpload.roster.sheetName);
    const result = buildExamSheet(rosterUpload.roster, records, config);

    setPendingWorkbookExport({
      workbook,
      sanitizedName: sanitized.name,
      nameChanged: sanitized.changed,
      collision: collision.collides ? collision : null,
      result,
    });
  }

  async function finishWorkbookExport(pending: PendingWorkbookExport, finalName: string, overwrite: boolean) {
    if (!rosterUpload) return;
    writeExamSheet(pending.workbook, finalName, overwrite, pending.result, config);
    // Step.md 12.13 — opt-in, off by default (see the checkbox below).
    // Writes into the roster sheet itself, not the exam sheet just added.
    if (includeTotalsColumn) {
      writeTotalsColumn(pending.workbook, rosterUpload.roster, finalName, config.totalMax, pending.result);
    }
    const buffer = await pending.workbook.xlsx.writeBuffer();
    // The updated copy of the instructor's own file — same filename, so it
    // reads as "the same file, now with this quiz added" rather than a
    // new, separately-named artifact to keep track of.
    triggerDownload(buffer, rosterUpload.fileName);
    setPendingWorkbookExport(null);
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

      {/* Step.md 12.5-12.8 — only rendered when Setup confirmed a class-list
          workbook. The plain "Download Excel" button above stays exactly as
          it was, unconditionally — plan.md §17's own "escape hatch" for
          whenever this path can't be used or a conflict can't be resolved
          before class ends. */}
      {rosterUpload && (
        <div className="card stack-sm" style={{ padding: 12 }}>
          <div className="row-between">
            <span>
              Class list: <strong>{rosterUpload.roster.sheetName}</strong>
              {' — '}
              {rosterUpload.roster.students.length}{' '}
              {rosterUpload.roster.students.length === 1 ? 'student' : 'students'}, from{' '}
              <strong>{rosterUpload.fileName}</strong>
            </span>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleWorkbookExportClick}
              disabled={records.length === 0}
            >
              Export into class marksheet
            </button>
          </div>
          <span className="text-sm muted">
            Writes a new sheet into your own file — every other sheet, including the class
            list, is left untouched. Charts or pivot tables already in the file are not
            preserved.
          </span>

          {/* Step.md 12.13 — opt-in, off by default. The only export
              operation that writes into a sheet the instructor authored. */}
          <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={includeTotalsColumn}
              onChange={(e) => setIncludeTotalsColumn(e.target.checked)}
            />
            Also add this quiz's totals as a column in the class list
          </label>

          {workbookExportError && (
            <p role="alert" className="error-text">
              {workbookExportError}
            </p>
          )}

          {pendingWorkbookExport && (
            <PendingExportPanel
              pending={pendingWorkbookExport}
              onCancel={() => setPendingWorkbookExport(null)}
              onFinish={finishWorkbookExport}
            />
          )}
        </div>
      )}

      {records.length === 0 ? (
        <div className="empty-state">No records saved yet — confirmed scripts will show up here.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th className="col-serial">Serial</th>
                <th className="col-id">Student ID</th>
                {/* Step.md 12.11 — only when a class list is attached, so
                    the plain-mode table keeps its exact original columns. */}
                {rosterUpload && <th className="col-id">Name</th>}
                {config.questions.map((qc) => (
                  <th key={qc.q} className="col-mark">
                    Q{qc.q} ({qc.max})
                  </th>
                ))}
                <th className="col-mark">Total ({config.totalMax})</th>
                <th className="col-check">Check</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((record) => (
                <ResultsRow
                  key={record.id}
                  record={record}
                  config={config}
                  roster={rosterUpload?.roster ?? null}
                  onUpdate={updateRecord}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 9.3 — stated as an expectation, not a surprise (plan.md §10).
          plan.md §17 made half of this conditional: with a class list
          attached, the exported sheet already lists every student by name,
          blank if unscanned — the gap is visible without a manual check.
          Without one, the original limitation still holds exactly as
          written. */}
      <p className="text-sm muted">
        {rosterUpload
          ? 'Your class list is attached — the exported sheet lists every student on it, blank if they weren’t scanned, so a skipped student is visible without a separate attendance check.'
          : "This app has no class list, so it can't tell whether a serial is out of range or a student was skipped entirely — check the exported file against your attendance sheet for gaps."}
      </p>
    </div>
  );
}

// How many missing names to list before summarising the rest — a large
// class shouldn't turn the confirm step into a wall of text, but the
// instructor still needs to SEE the coverage gap, not just a count.
const MISSING_STUDENTS_PREVIEW = 10;

interface PendingExportPanelProps {
  pending: PendingWorkbookExport;
  onCancel: () => void;
  onFinish: (pending: PendingWorkbookExport, finalName: string, overwrite: boolean) => void;
}

// Step.md 12.12 — always shown once "Export into class marksheet" is
// clicked (no more "skip when nothing to confirm" shortcut, see
// PendingWorkbookExport's own comment on why). Three states, in priority
// order: a duplicate match BLOCKS the export outright (plan.md §17 — the
// worst failure this app has, and the plain download stays available as
// the escape hatch); otherwise a name collision needs Overwrite/Rename/
// Cancel; otherwise a plain confirm showing the sheet name and who's
// missing, with nothing to resolve but "Continue."
function PendingExportPanel({ pending, onCancel, onFinish }: PendingExportPanelProps) {
  const { result, collision, sanitizedName } = pending;

  if (result.duplicates.length > 0) {
    return (
      <div className="banner banner-danger" role="alert">
        <p>
          {result.duplicates.length === 1
            ? 'One student on your class list has two scanned scripts matching them — fix this in the table above before exporting.'
            : `${result.duplicates.length} students on your class list each have two scanned scripts matching them — fix these in the table above before exporting.`}
        </p>
        <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
          {result.duplicates.map((d) => (
            <li key={d.studentIdKey}>
              {d.studentId} — {d.studentName}: {d.records.length} scripts
            </li>
          ))}
        </ul>
        {/* No Overwrite/Continue here at all — the plain "Download Excel"
            button above is the only way out until the conflict is
            resolved, exactly as plan.md §17 intends. */}
        <div className="banner-actions">
          <button className="btn btn-secondary btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const missing = result.missingStudents;
  const previewNames = missing
    .slice(0, MISSING_STUDENTS_PREVIEW)
    .map((s) => s.studentName || s.studentId)
    .join(', ');
  const coverageLine =
    missing.length === 0 ? (
      'Every student on your class list has been scanned.'
    ) : (
      <>
        {missing.length} {missing.length === 1 ? 'student' : 'students'} not yet scanned:{' '}
        {previewNames}
        {missing.length > MISSING_STUDENTS_PREVIEW ? ` and ${missing.length - MISSING_STUDENTS_PREVIEW} more` : ''}.
      </>
    );

  return (
    <div className="banner banner-warning" role="alert">
      {collision ? (
        <>
          <p>
            {collision.isRosterSheet
              ? `"${sanitizedName}" is your class list's own sheet — it can't be overwritten.`
              : `A sheet named "${sanitizedName}" already exists in this file.`}
          </p>
          <p>{coverageLine}</p>
          <div className="banner-actions">
            {!collision.isRosterSheet && (
              <button
                className="btn btn-danger-solid btn-sm"
                onClick={() => onFinish(pending, sanitizedName, true)}
              >
                Overwrite it
              </button>
            )}
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onFinish(pending, collision.suggestedRename, false)}
            >
              Use "{collision.suggestedRename}" instead
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p>This sheet will be named "{sanitizedName}".</p>
          <p>{coverageLine}</p>
          <div className="banner-actions">
            <button className="btn btn-primary btn-sm" onClick={() => onFinish(pending, sanitizedName, false)}>
              Continue
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface ResultsRowProps {
  record: StudentRecord;
  config: QuizConfig;
  roster: ParsedRoster | null;
  onUpdate: (record: StudentRecord) => void;
}

// Field-by-field rather than JSON.stringify: `questions` is rebuilt as a
// fresh array on every render, so reference equality is always false and a
// serialisation comparison would depend on key order staying stable.
function isUnchanged(a: StudentRecord, b: StudentRecord): boolean {
  return (
    a.studentId === b.studentId &&
    a.serial === b.serial &&
    a.total === b.total &&
    a.questions.length === b.questions.length &&
    a.questions.every((q, i) => q.q === b.questions[i].q && q.value === b.questions[i].value)
  );
}

function ResultsRow({ record, config, roster, onUpdate }: ResultsRowProps) {
  const [studentId, setStudentId] = useState(record.studentId ?? '');
  const [serial, setSerial] = useState(record.serial ?? '');
  // Step.md 12.11 — derived from the LIVE (possibly just-edited) studentId
  // field, same "derive, don't store" reasoning the sum check below
  // already follows: correcting the ID in this table should update the
  // name shown next to it immediately, not lag behind a save.
  const rosterMatch = matchAgainstRoster(studentId, config.idDigits, roster);
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
    value: parseMarkField(marks[qc.q] ?? '', qc.max).value,
  }));
  // Total goes through the same parse as every other field now (issues.md
  // N6) — this screen had the identical unchecked-Total bug as Review, and
  // it is the LAST screen before export, so a NaN reaching here had nothing
  // after it to catch it.
  const totalParse = parseMarkField(totalStr, config.totalMax);
  const total = totalParse.value;
  // 9.1's sum check, derived on every render — never stored, same
  // principle as the Review screen (CLAUDE.md "Derive, don't store").
  const { computedSum, matches } = sumCheck(questionValues, total);
  const reason = unverifiedReason(record, config.idDigits);

  const markErrors: Record<number, string> = {};
  for (const qc of config.questions) {
    if (parseMarkField(marks[qc.q] ?? '', qc.max).error) {
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
    if (totalParse.error) {
      setError(`Total must be 0–${config.totalMax}, steps of 0.5 — edit not saved.`);
      return;
    }
    setError(null);

    const updated: StudentRecord = {
      ...record,
      studentId: trimmedId,
      serial: trimmedSerial,
      questions: questionValues,
      total,
    };
    // onBlur fires on every field the instructor tabs through, including
    // ones they only read. Without this, walking across a row rewrote the
    // record once per column and re-rendered the whole table each time
    // (issues.md N25).
    if (isUnchanged(record, updated)) return;
    onUpdate(updated);
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
      {/* Step.md 12.11 — the header only renders this column when a roster
          is attached, so `roster` is non-null here whenever this cell
          exists at all; kept simple rather than plumbing a second flag. */}
      {roster && (
        <td>
          {rosterMatch.status === 'matched' ? (
            rosterMatch.student.studentName
          ) : rosterMatch.status === 'not-on-list' ? (
            <span className="badge badge-warning">Not on list</span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      )}
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
