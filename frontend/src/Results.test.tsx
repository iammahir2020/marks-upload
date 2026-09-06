// Component-level checks for step 9's Done-when bar items that need a
// DOM: inline edits actually persisting, the unverified count rendering,
// and identity/mark validation blocking a bad edit. Sorting and the
// unverified-record rule themselves are already covered without a DOM in
// results.test.ts.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExcelJS from 'exceljs';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllRecords, loadConfig, saveConfig, saveRecord } from './db';
import Results from './Results';
import type { RosterUpload } from './roster';
import type { QuizConfig, StudentRecord } from './types';

const config: QuizConfig = {
  quizName: 'CSE211L Quiz 1',
  idDigits: 7,
  questions: [
    { q: 1, max: 5 },
    { q: 2, max: 5 },
  ],
  totalMax: 10,
};

function makeRecord(overrides: Partial<StudentRecord>): StudentRecord {
  return {
    id: crypto.randomUUID(),
    studentId: '1912345',
    serial: '07',
    questions: [
      { q: 1, value: 4 },
      { q: 2, value: 3 },
    ],
    total: 7,
    confirmed: true,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('Results — table (9.1) and unverified summary (9.2)', () => {
  it('renders saved records sorted by serial, with the record count and unverified count', async () => {
    await saveRecord(makeRecord({ serial: '2', studentId: '1912302' }));
    await saveRecord(makeRecord({ serial: '1', studentId: '1912301' }));
    await saveRecord(makeRecord({ serial: null, studentId: '1912399' })); // unverified

    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);

    await screen.findByText(/3 records/);
    expect(screen.getByText(/1 unverified/)).toBeInTheDocument();

    // serial "1" row should render before serial "2" row — check via DOM order
    const serialInputs = screen.getAllByDisplayValue(/^[12]$/);
    expect(serialInputs.map((el) => (el as HTMLInputElement).value)).toEqual(['1', '2']);
  });

  it('states the attendance-sheet expectation plainly (9.3)', async () => {
    await saveRecord(makeRecord({}));
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);
    await screen.findByText(/no class list/);
  });
});

describe('Results — inline editing (9.1)', () => {
  it('writes a corrected mark back to IndexedDB on blur', async () => {
    const record = makeRecord({});
    await saveRecord(record);
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);

    const q1 = await screen.findByDisplayValue('4');
    fireEvent.change(q1, { target: { value: '4.5' } });
    fireEvent.blur(q1);

    await vi.waitFor(async () => {
      const [saved] = await getAllRecords();
      expect(saved.questions.find((q) => q.q === 1)?.value).toBe(4.5);
    });
  });

  it('rejects an illegal mark value and does not persist it', async () => {
    const record = makeRecord({});
    await saveRecord(record);
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);

    const q1 = await screen.findByDisplayValue('4');
    fireEvent.change(q1, { target: { value: '4.25' } });
    fireEvent.blur(q1);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const [saved] = await getAllRecords();
    expect(saved.questions.find((q) => q.q === 1)?.value).toBe(4); // unchanged
  });

  it('refuses an edit that would clear both identity fields', async () => {
    const record = makeRecord({ studentId: '1912345', serial: null });
    await saveRecord(record);
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);

    const idInput = await screen.findByDisplayValue('1912345');
    fireEvent.change(idInput, { target: { value: '' } });
    fireEvent.blur(idInput);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const [saved] = await getAllRecords();
    expect(saved.studentId).toBe('1912345'); // unchanged — would have left no identity at all
  });
});

describe('Results — export (9.4)', () => {
  it('builds a workbook with columns following the quiz config, without crashing', async () => {
    await saveRecord(makeRecord({}));
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);

    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();

    const button = await screen.findByRole('button', { name: 'Download Excel' });
    fireEvent.click(button);

    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());

    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });
});

describe('Results — reset everything', () => {
  it('does not delete anything until the destructive action is confirmed', async () => {
    await saveConfig(config);
    await saveRecord(makeRecord({}));
    const onReset = vi.fn();
    render(<Results config={config} onBack={vi.fn()} onReset={onReset} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reset everything' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await getAllRecords()).toHaveLength(1);
    expect(await loadConfig()).toEqual(config);
    expect(onReset).not.toHaveBeenCalled();
  });

  it('clears every record and the quiz config, then hands control back to the app', async () => {
    await saveConfig(config);
    await saveRecord(makeRecord({}));
    await saveRecord(makeRecord({}));
    const onReset = vi.fn();
    render(<Results config={config} onBack={vi.fn()} onReset={onReset} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reset everything' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, delete everything' }));

    await vi.waitFor(() => expect(onReset).toHaveBeenCalled());
    expect(await getAllRecords()).toHaveLength(0);
    expect(await loadConfig()).toBeUndefined();
  });
});

// --- Regression tests for the 2026-08-31 audit fixes -----------------------

// Serial 9 throughout, so the only input showing "7" is Total: the record's
// serial "07" now normalizes to "7" on save (issues.md #2), which would
// otherwise make findByDisplayValue('7') ambiguous.
const distinct = { serial: '9', questions: [{ q: 1, value: 4 }, { q: 2, value: 3 }], total: 7 };

describe('Results — Total field validation (issues.md N6)', () => {
  it('refuses an unparseable Total instead of persisting NaN', async () => {
    await saveRecord(makeRecord({ id: 'r1', ...distinct }));
    await saveConfig(config);
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);
    await screen.findByDisplayValue('1912345');

    const totalCell = screen.getByDisplayValue('7') as HTMLInputElement;
    fireEvent.change(totalCell, { target: { value: 'abc' } });
    fireEvent.blur(totalCell);

    await screen.findByText(/Total must be 0/);

    // This is the last screen before export, so a NaN reaching the record
    // here would have had nothing after it to catch it.
    const [stored] = await getAllRecords();
    expect(stored.total).toBe(7);
  });
});

describe('Results — redundant writes (issues.md N25)', () => {
  it('does not rewrite the record when a field is only read', async () => {
    await saveRecord(makeRecord({ id: 'r1', ...distinct, capturedAt: '2026-01-01T00:00:00.000Z' }));
    await saveConfig(config);
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);

    const idCell = (await screen.findByDisplayValue('1912345')) as HTMLInputElement;
    // Tabbing across a row fires onBlur per column; nothing changed.
    fireEvent.blur(idCell);
    fireEvent.blur(screen.getByDisplayValue('7'));

    const [stored] = await getAllRecords();
    expect(stored.capturedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(stored.total).toBe(7);
  });

  it('still writes when something actually changed', async () => {
    await saveRecord(makeRecord({ id: 'r1', ...distinct }));
    await saveConfig(config);
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);

    const totalCell = (await screen.findByDisplayValue('7')) as HTMLInputElement;
    fireEvent.change(totalCell, { target: { value: '8' } });
    fireEvent.blur(totalCell);

    await vi.waitFor(async () => {
      const [stored] = await getAllRecords();
      expect(stored.total).toBe(8);
    });
  });
});

describe('Results — incomplete ID is surfaced (issues.md N5)', () => {
  it('counts a record whose ID still contains "?" as unverified', async () => {
    await saveRecord(makeRecord({ id: 'r1', ...distinct, studentId: '12?4567' }));
    await saveConfig(config);
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);

    // Both identity fields are present, so the old rule reported this as
    // fully verified and it would have exported as a literal "12?4567".
    await screen.findByText('1 unverified');
    expect(screen.getByText('ID incomplete')).toBeInTheDocument();
  });
});

// Step.md 12.5-12.8 (plan.md §17, Phase B) — the second export path, only
// reachable when Setup confirmed a class-list workbook. Built with real
// ExcelJS workbooks in memory (roster.test.ts/workbookExport.test.ts's own
// pattern), never a fixture file.
async function rosterUploadFixture(
  extraSheets: Array<{ name: string; rows: unknown[][] }> = [],
): Promise<RosterUpload> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  ws.addRow(['SL', 'STUDENT ID', 'STUDENT NAME']);
  ws.addRow([1, '1912345', 'Monem Tazwar']);
  for (const sheet of extraSheets) {
    const s = wb.addWorksheet(sheet.name);
    sheet.rows.forEach((r) => s.addRow(r));
  }
  const workbookBytes = await wb.xlsx.writeBuffer();
  return {
    fileName: 'roster.xlsx',
    workbookBytes,
    roster: {
      sheetName: 'data',
      headerRow: 1,
      students: [{ sl: 1, row: 1 + 1, studentId: '1912345', studentIdKey: '1912345', studentName: 'Monem Tazwar' }],
      duplicateIds: [],
    },
  };
}

// A second, two-student roster for 12.12's coverage/blocking tests, where
// a single-student roster can't distinguish "missing" from "everyone done."
async function twoStudentRosterUploadFixture(): Promise<RosterUpload> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  ws.addRow(['SL', 'STUDENT ID', 'STUDENT NAME']);
  ws.addRow([1, '1912345', 'Monem Tazwar']);
  ws.addRow([2, '2130643', 'Salman Noor']);
  const workbookBytes = await wb.xlsx.writeBuffer();
  return {
    fileName: 'roster.xlsx',
    workbookBytes,
    roster: {
      sheetName: 'data',
      headerRow: 1,
      students: [
        { sl: 1, row: 2, studentId: '1912345', studentIdKey: '1912345', studentName: 'Monem Tazwar' },
        { sl: 2, row: 3, studentId: '2130643', studentIdKey: '2130643', studentName: 'Salman Noor' },
      ],
      duplicateIds: [],
    },
  };
}

function mockDownload() {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  return () => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  };
}

describe('Results — class-list workbook export (12.5-12.8)', () => {
  it('does not render the class-list card in plain mode', async () => {
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);
    await screen.findByText('Results');
    expect(screen.queryByText(/class list:/i)).not.toBeInTheDocument();
    // The plain button is exactly what it always was, unconditionally.
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeInTheDocument();
  });

  it('shows the class-list summary and both export buttons when a roster is attached', async () => {
    const rosterUpload = await rosterUploadFixture();
    await saveRecord(makeRecord({}));
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    expect(await screen.findByText('data', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('roster.xlsx', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export into class marksheet/i })).toBeInTheDocument();
  });

  it('always shows the confirm panel (step.md 12.12), even with nothing to resolve', async () => {
    const rosterUpload = await rosterUploadFixture();
    await saveRecord(makeRecord({}));
    const restore = mockDownload();
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /export into class marksheet/i }));
    // No collision or renamed sheet, but the panel still appears — 12.12's
    // coverage summary means there's always something worth confirming.
    expect(await screen.findByText(/this sheet will be named/i)).toBeInTheDocument();
    expect(screen.getByText(/every student on your class list has been scanned/i)).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    restore();
  });

  it('prompts before writing when the sheet name needed sanitising', async () => {
    const weirdConfig: QuizConfig = { ...config, quizName: 'Quiz: 1?' };
    const rosterUpload = await rosterUploadFixture();
    await saveRecord(makeRecord({}));
    const restore = mockDownload();
    render(<Results config={weirdConfig} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /export into class marksheet/i }));
    expect(await screen.findByText(/this sheet will be named "quiz 1"/i)).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    restore();
  });

  it('offers Overwrite/Rename/Cancel on a real collision, never Overwrite for the class-list sheet', async () => {
    // Must match `config.quizName` ("CSE211L Quiz 1") exactly, or there is
    // genuinely no collision to detect — this sheet stands in for a
    // previous session's own export already sitting in the file.
    const rosterUpload = await rosterUploadFixture([{ name: 'CSE211L Quiz 1', rows: [['old']] }]);
    await saveRecord(makeRecord({}));
    const restore = mockDownload();
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /export into class marksheet/i }));
    expect(await screen.findByText(/a sheet named "cse211l quiz 1" already exists/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /overwrite it/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use "cse211l quiz 1 \(2\)" instead/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /overwrite it/i }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    restore();
  });

  it('never offers Overwrite when the collision is with the class-list sheet itself', async () => {
    // The quiz is literally named "data" — colliding with the roster's own
    // sheet. Rule 3 (plan.md §17): Overwrite must not be reachable here.
    const dataNamedConfig: QuizConfig = { ...config, quizName: 'data' };
    const rosterUpload = await rosterUploadFixture();
    await saveRecord(makeRecord({}));
    render(<Results config={dataNamedConfig} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /export into class marksheet/i }));
    expect(await screen.findByText(/is your class list's own sheet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /overwrite it/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use "data \(2\)" instead/i })).toBeInTheDocument();
  });

  it('cancelling the confirm prompt writes nothing', async () => {
    const weirdConfig: QuizConfig = { ...config, quizName: 'Quiz: 1?' };
    const rosterUpload = await rosterUploadFixture();
    await saveRecord(makeRecord({}));
    render(<Results config={weirdConfig} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /export into class marksheet/i }));
    await screen.findByText(/this sheet will be named/i);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByText(/this sheet will be named/i)).not.toBeInTheDocument();
  });

  it('replaces the "no class list" note with the roster-aware one', async () => {
    const rosterUpload = await rosterUploadFixture();
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);
    expect(await screen.findByText(/your class list is attached/i)).toBeInTheDocument();
    expect(screen.queryByText(/this app has no class list/i)).not.toBeInTheDocument();
  });
});

// Step.md 12.12 — pre-export coverage summary and duplicate blocking.
describe('Results — pre-export coverage and duplicate blocking (12.12)', () => {
  it('lists a roster student who has not been scanned', async () => {
    const rosterUpload = await twoStudentRosterUploadFixture();
    await saveRecord(makeRecord({ studentId: '1912345' })); // only Monem scanned
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /export into class marksheet/i }));
    expect(await screen.findByText(/1 student not yet scanned: salman noor/i)).toBeInTheDocument();
  });

  it('confirms full coverage when every roster student has been scanned', async () => {
    const rosterUpload = await twoStudentRosterUploadFixture();
    await saveRecord(makeRecord({ id: 'a', studentId: '1912345' }));
    await saveRecord(makeRecord({ id: 'b', studentId: '2130643' }));
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /export into class marksheet/i }));
    expect(await screen.findByText(/every student on your class list has been scanned/i)).toBeInTheDocument();
  });

  it('blocks the export outright when two records match one roster student, naming both', async () => {
    const rosterUpload = await twoStudentRosterUploadFixture();
    await saveRecord(makeRecord({ id: 'a', studentId: '1912345', total: 5 }));
    await saveRecord(makeRecord({ id: 'b', studentId: '1912345', total: 9 }));
    const restore = mockDownload();
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /export into class marksheet/i }));
    expect(await screen.findByText(/two scanned scripts matching them/i)).toBeInTheDocument();
    expect(screen.getByText(/1912345 — Monem Tazwar: 2 scripts/i)).toBeInTheDocument();

    // No way to proceed — only Cancel. The plain download stays available
    // as the escape hatch (already unconditionally rendered elsewhere).
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /overwrite/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
    restore();
  });
});

// Step.md 12.13 — the opt-in totals column.
describe('Results — opt-in totals column (12.13)', () => {
  it('is off by default and does not write a totals column when left unchecked', async () => {
    const rosterUpload = await rosterUploadFixture();
    await saveRecord(makeRecord({ total: 7 }));
    const restore = mockDownload();
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /export into class marksheet/i }));
    await screen.findByText(/this sheet will be named/i);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    restore();
  });

  it('checking it still exports cleanly — the column write itself is workbookExport.test.ts\'s job', async () => {
    const rosterUpload = await twoStudentRosterUploadFixture();
    await saveRecord(makeRecord({ studentId: '1912345', total: 7 }));
    const restore = mockDownload();
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    fireEvent.click(await screen.findByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /export into class marksheet/i }));
    await screen.findByText(/this sheet will be named/i);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    restore();
  });
});

// Step.md 12.11 — the Name column, on-screen. rosterUploadFixture()'s
// roster carries studentId "1912345" == makeRecord()'s own default, so the
// exact-match case needs no override.
describe('Results — Name column (12.11)', () => {
  it('has no Name column in plain mode', async () => {
    await saveRecord(makeRecord({}));
    render(<Results config={config} onBack={vi.fn()} onReset={vi.fn()} />);
    await screen.findByText('CSE211L Quiz 1');
    expect(screen.queryByRole('columnheader', { name: 'Name' })).not.toBeInTheDocument();
  });

  it('shows the matched name when a roster is attached', async () => {
    await saveRecord(makeRecord({}));
    const rosterUpload = await rosterUploadFixture();
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    expect(await screen.findByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByText('Monem Tazwar')).toBeInTheDocument();
  });

  it('flags a record whose ID matches nobody on the roster', async () => {
    await saveRecord(makeRecord({ studentId: '9999999' }));
    const rosterUpload = await rosterUploadFixture();
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    expect(await screen.findByText('Not on list')).toBeInTheDocument();
  });

  it('updates the Name cell live as the ID is corrected in the table', async () => {
    await saveRecord(makeRecord({ studentId: '9999999' }));
    const rosterUpload = await rosterUploadFixture();
    render(<Results config={config} rosterUpload={rosterUpload} onBack={vi.fn()} onReset={vi.fn()} />);

    await screen.findByText('Not on list');
    fireEvent.change(screen.getByDisplayValue('9999999'), { target: { value: '1912345' } });
    expect(screen.getByText('Monem Tazwar')).toBeInTheDocument();
    expect(screen.queryByText('Not on list')).not.toBeInTheDocument();
  });
});
