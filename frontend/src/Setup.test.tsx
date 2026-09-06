// Step 11.5 — the data-collection disclosure.
//
// This is tested for a different reason than most UI: it is a promise made
// to the people using the app about their students' handwriting. Wording
// can change freely, but it must not silently *disappear* — and the
// always-visible line specifically must not drift back inside the
// collapsible <details>, where a returning user (whose config is already
// saved, so the section is collapsed) would never see it again.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExcelJS from 'exceljs';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Setup from './Setup';
import { getAllRecords, loadRosterUpload, saveConfig, saveRecord, saveRosterUpload } from './db';
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

beforeEach(() => {
  indexedDB = new IDBFactory();
});

describe('data-collection disclosure', () => {
  it('tells a first-time user that cells are kept for training', async () => {
    render(<Setup onStart={vi.fn()} onViewResults={vi.fn()} />);

    // Said in both places on a first run: the expanded "How this works"
    // detail and the always-visible summary line below it.
    await waitFor(() => {
      expect(screen.getAllByText(/train and tune/i)).toHaveLength(2);
    });
    // The important half: what is NOT kept, stated as plainly.
    expect(screen.getAllByText(/never stored/i).length).toBeGreaterThan(0);
  });

  it('still shows the summary line to a returning user', async () => {
    // With a saved config the "How this works" section renders collapsed,
    // so anything only inside it is effectively invisible from the second
    // session onward — which is precisely the user whose students'
    // handwriting is being collected.
    await saveConfig(config);
    render(<Setup onStart={vi.fn()} onViewResults={vi.fn()} />);

    const note = await screen.findByText(/used to train and tune handwriting recognition/i);
    expect(note).toBeInTheDocument();
    expect(note.closest('details')).toBeNull();
  });

  // Step.md 12.11 — the class-list disclosure added alongside the crops
  // one. Same rule applies: it must survive to a returning user, whose
  // saved config collapses the <details> section it's also said in.
  it('discloses that an uploaded class list keeps names on the device, to a returning user too', async () => {
    await saveConfig(config);
    render(<Setup onStart={vi.fn()} onViewResults={vi.fn()} />);

    const note = await screen.findByText(/class-list workbook keeps the names on it on this device/i);
    expect(note).toBeInTheDocument();
    expect(note.closest('details')).toBeNull();
    // Never sent anywhere is the important half, said as plainly as the
    // crops disclosure says it for cell crops.
    expect(screen.getAllByText(/never sent anywhere/i).length).toBeGreaterThan(0);
  });
});

function makeRecord(overrides: Partial<StudentRecord> = {}): StudentRecord {
  return {
    id: crypto.randomUUID(),
    studentId: '2632711',
    serial: '7',
    questions: [{ q: 1, value: 5 }],
    total: 5,
    confirmed: true,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Someone reopening the app mid-session needs to be told their scans are
// still there. Before this, nothing on the first screen mentioned them —
// the only way to find out was to start scanning and reach Results.
describe('saved-session notice', () => {
  it('says nothing when there is no saved data', async () => {
    render(<Setup onStart={vi.fn()} onViewResults={vi.fn()} />);
    await screen.findByText(/Set up this quiz/i);
    expect(screen.queryByText(/already scanned/i)).not.toBeInTheDocument();
  });

  it('reports how many scripts are already saved', async () => {
    await saveConfig(config);
    await saveRecord(makeRecord());
    await saveRecord(makeRecord({ studentId: '2632700' }));

    render(<Setup onStart={vi.fn()} onViewResults={vi.fn()} />);

    expect(await screen.findByText(/already scanned/i)).toBeInTheDocument();
    expect(screen.getByText('2 scripts')).toBeInTheDocument();
  });

  it('singularises one script, because "1 scripts" reads as a bug', async () => {
    await saveConfig(config);
    await saveRecord(makeRecord());
    render(<Setup onStart={vi.fn()} onViewResults={vi.fn()} />);
    expect(await screen.findByText('1 script')).toBeInTheDocument();
  });

  it('View hands the saved config through, so Results can label its columns', async () => {
    await saveConfig(config);
    await saveRecord(makeRecord());
    const onViewResults = vi.fn();
    render(<Setup onStart={vi.fn()} onViewResults={onViewResults} />);

    fireEvent.click(await screen.findByRole('button', { name: /view/i }));
    // Second argument is whatever step 12.14 restored — null here, since
    // no roster was ever persisted in this test.
    expect(onViewResults).toHaveBeenCalledWith(config, null);
  });

  it('View also hands through a persisted roster, restoring it the same way Start scanning does (12.14)', async () => {
    await saveConfig(config);
    await saveRecord(makeRecord());
    const upload: RosterUpload = {
      fileName: 'roster.xlsx',
      workbookBytes: new ArrayBuffer(8),
      roster: { sheetName: 'data', headerRow: 1, students: [], duplicateIds: [] },
    };
    await saveRosterUpload(upload);
    const onViewResults = vi.fn();
    render(<Setup onStart={vi.fn()} onViewResults={onViewResults} />);

    fireEvent.click(await screen.findByRole('button', { name: /view/i }));
    expect(onViewResults).toHaveBeenCalledWith(config, upload);
  });

  it('resumes with a persisted roster attached, restoring what a refresh would otherwise drop (12.14)', async () => {
    await saveConfig(config);
    const upload: RosterUpload = {
      fileName: 'roster.xlsx',
      workbookBytes: new ArrayBuffer(8),
      roster: {
        sheetName: 'data',
        headerRow: 1,
        students: [{ sl: 1, row: 1 + 1, studentId: '1912345', studentIdKey: '1912345', studentName: 'Monem Tazwar' }],
        duplicateIds: [],
      },
    };
    await saveRosterUpload(upload);
    const onStart = vi.fn();
    render(<Setup onStart={onStart} onViewResults={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /start scanning/i }));
    expect(onStart).toHaveBeenCalledWith(config, upload);
  });

  it('reset needs a second confirmation and then clears every store, including a persisted roster', async () => {
    await saveConfig(config);
    await saveRecord(makeRecord());
    await saveRosterUpload({
      fileName: 'roster.xlsx',
      workbookBytes: new ArrayBuffer(8),
      roster: { sheetName: 'data', headerRow: 1, students: [], duplicateIds: [] },
    });
    render(<Setup onStart={vi.fn()} onViewResults={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /reset everything/i }));
    // Cancelling must delete nothing.
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(await getAllRecords()).toHaveLength(1);
    expect(await loadRosterUpload()).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /reset everything/i }));
    fireEvent.click(screen.getByRole('button', { name: /yes, delete everything/i }));

    await waitFor(async () => expect(await getAllRecords()).toHaveLength(0));
    await waitFor(async () => expect(await loadRosterUpload()).toBeUndefined());
    // The notice goes with it, and the form returns to a blank setup.
    await waitFor(() =>
      expect(screen.queryByText(/already scanned/i)).not.toBeInTheDocument(),
    );
  });
});

// Step.md step 12.1/12.3/12.4 (plan.md §17) — the class-marksheet upload
// mode. roster.ts's own test suite covers the parsing/detection logic in
// isolation; these exercise the component wiring around it: the mode
// toggle's effect on what's reachable, the file input, the confirm card,
// the "Change" picker, and every validation state gating submission.
async function xlsxFile(
  name: string,
  rows: (string | number | null)[][],
  extraSheets: Array<{ name: string; rows: (string | number | null)[][] }> = [],
): Promise<File> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  rows.forEach((r) => ws.addRow(r));
  for (const sheet of extraSheets) {
    const s = wb.addWorksheet(sheet.name);
    sheet.rows.forEach((r) => s.addRow(r));
  }
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

const ROSTER_ROWS: (string | number | null)[][] = [
  ['SL', 'STUDENT ID', 'STUDENT NAME'],
  [1, '1722112', 'Monem Tazwar'],
  [2, '2130643', 'Salman Noor'],
];

async function switchToWorkbookMode() {
  render(<Setup onStart={vi.fn()} onViewResults={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /use my class marksheet/i }));
  return screen.getByLabelText(/class marksheet/i) as HTMLInputElement;
}

function uploadFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

describe('class marksheet upload', () => {
  it('hides the upload UI in plain mode, the default', async () => {
    render(<Setup onStart={vi.fn()} onViewResults={vi.fn()} />);
    await screen.findByText(/set up this quiz/i);
    expect(screen.queryByLabelText(/class marksheet/i)).not.toBeInTheDocument();
  });

  it('parses a valid roster and shows the confirm card', async () => {
    const input = await switchToWorkbookMode();
    uploadFile(input, await xlsxFile('roster.xlsx', ROSTER_ROWS));

    expect(await screen.findByText(/class list:/i)).toBeInTheDocument();
    expect(screen.getByText(/2 students/i)).toBeInTheDocument();
    expect(screen.getByText(/monem tazwar/i)).toBeInTheDocument();
  });

  // The native <input type="file">'s own displayed filename is cleared
  // deliberately (so re-selecting the same file re-fires onChange), which
  // means it reverts to "No file chosen" even after a successful upload —
  // this asserts the app's OWN feedback stays accurate instead.
  it('shows the selected filename even though the native input reverts to "No file chosen"', async () => {
    const input = await switchToWorkbookMode();
    uploadFile(input, await xlsxFile('my-roster.xlsx', ROSTER_ROWS));

    expect(await screen.findByText('Selected: my-roster.xlsx')).toBeInTheDocument();
    await screen.findByText(/class list:/i); // upload genuinely succeeded
    expect(input.value).toBe(''); // the native input's own value really is cleared
    expect(screen.getByText('Selected: my-roster.xlsx')).toBeInTheDocument(); // ours isn't
  });

  it('blocks submission until a workbook is uploaded', async () => {
    const onStart = vi.fn();
    render(<Setup onStart={onStart} onViewResults={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /use my class marksheet/i }));
    fireEvent.click(screen.getByRole('button', { name: /start scanning/i }));

    expect(await screen.findByText(/upload your class marksheet/i)).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('proceeds once a valid roster is uploaded', async () => {
    const onStart = vi.fn();
    render(<Setup onStart={onStart} onViewResults={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/quiz name/i), { target: { value: 'Quiz 1' } });
    fireEvent.click(screen.getByRole('button', { name: /use my class marksheet/i }));
    const input = screen.getByLabelText(/class marksheet/i) as HTMLInputElement;
    uploadFile(input, await xlsxFile('roster.xlsx', ROSTER_ROWS));
    await screen.findByText(/class list:/i);

    fireEvent.click(screen.getByRole('button', { name: /start scanning/i }));
    await waitFor(() => expect(onStart).toHaveBeenCalled());
  });

  it('rejects a workbook with no roster-shaped sheet, naming the reason', async () => {
    const input = await switchToWorkbookMode();
    uploadFile(input, await xlsxFile('no-roster.xlsx', [['just', 'some', 'data']]));

    expect(await screen.findByText(/no sheet in this file/i)).toBeInTheDocument();
  });

  it('rejects a header row with no student rows beneath it', async () => {
    const input = await switchToWorkbookMode();
    uploadFile(input, await xlsxFile('empty.xlsx', [['SL', 'STUDENT ID', 'STUDENT NAME']]));

    expect(await screen.findByText(/no student rows/i)).toBeInTheDocument();
  });

  it('rejects a file ExcelJS cannot parse at all', async () => {
    const input = await switchToWorkbookMode();
    const badFile = new File(['not a real xlsx'], 'bad.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    uploadFile(input, badFile);

    expect(await screen.findByText(/couldn.t read this file/i)).toBeInTheDocument();
  });

  it('flags duplicate ids within the roster without blocking the upload', async () => {
    const input = await switchToWorkbookMode();
    uploadFile(
      input,
      await xlsxFile('dupes.xlsx', [
        ['SL', 'STUDENT ID', 'STUDENT NAME'],
        [1, '1722112', 'A'],
        [2, '1722112', 'B'],
      ]),
    );

    expect(await screen.findByText(/appears more than once/i)).toBeInTheDocument();
    // Still lets the instructor proceed — duplicates are flagged, not blocking.
    expect(screen.getByRole('button', { name: /start scanning/i })).toBeEnabled();
  });

  it('auto-opens the picker when two roster-shaped sheets are ambiguous, and "Change" resolves it', async () => {
    const input = await switchToWorkbookMode();
    uploadFile(
      input,
      await xlsxFile('two-sections.xlsx', [
        ['unrelated', 'cover page'],
      ], [
        { name: 'Section 1', rows: [['SL', 'STUDENT ID', 'STUDENT NAME'], [1, '1111111', 'A']] },
        { name: 'Section 2', rows: [['SL', 'STUDENT ID', 'STUDENT NAME'], [1, '2222222', 'B']] },
      ]),
    );

    // Ambiguous: neither candidate is the first sheet ("data" doesn't
    // qualify as a roster here), so the picker should already be open
    // rather than hidden behind a "Change" tap.
    expect(await screen.findByRole('button', { name: /section 1.*1 student/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /section 2.*1 student/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /section 2.*1 student/i }));
    // "Class list: " and the sheet name render as separate text nodes
    // (the name is inside a <strong>), so match the <strong> directly
    // rather than the whole sentence as one string.
    await waitFor(() =>
      expect(screen.getByText('Section 2', { selector: 'strong' })).toBeInTheDocument(),
    );
  });

  it('re-normalizes the roster if Student ID digits is changed after upload', async () => {
    const input = await switchToWorkbookMode();
    // 6-digit numeric id, one short of the default 7 — Excel's own numeric
    // storage behaviour (leading zero lost), reproduced deliberately.
    uploadFile(
      input,
      await xlsxFile('short-id.xlsx', [
        ['SL', 'STUDENT ID', 'STUDENT NAME'],
        [1, 212345, 'Someone'],
      ]),
    );
    await screen.findByText(/class list:/i);

    // idDigits defaults to 7, so parsing already ran once; changing it
    // should re-derive without a re-upload. Not asserting the internal key
    // directly (that's roster.test.ts's job) — just that changing the
    // field doesn't throw or clear the confirm card.
    fireEvent.change(screen.getByLabelText(/student id digits/i), { target: { value: '8' } });
    expect(screen.getByText(/class list:/i)).toBeInTheDocument();
  });

  it('clears a previously-persisted roster when a new quiz starts in plain mode (12.14)', async () => {
    // A prior quiz used workbook mode; the roster is already persisted.
    await saveRosterUpload({
      fileName: 'old-roster.xlsx',
      workbookBytes: new ArrayBuffer(8),
      roster: { sheetName: 'data', headerRow: 1, students: [], duplicateIds: [] },
    });
    const onStart = vi.fn();
    render(<Setup onStart={onStart} onViewResults={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/quiz name/i), { target: { value: 'Quiz 2' } });
    // mode defaults to 'plain' — no need to touch the toggle.
    fireEvent.click(screen.getByRole('button', { name: /start scanning/i }));

    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.anything(), null));
    // Without this, a refresh later in THIS plain-mode session would
    // restore the old workbook via the saved-config quick-start path.
    expect(await loadRosterUpload()).toBeUndefined();
  });
});
