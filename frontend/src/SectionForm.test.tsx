// step.md 13.5/13.9 — course code, label, semester, ID digits, plus the
// class-list workbook upload ported from Setup.tsx's old workbook mode
// (step.md 12.1-12.4), unchanged in behaviour. roster.ts's own suite
// covers the parsing/detection logic in isolation; this exercises the
// component wiring around it, same as the old Setup.test.tsx did.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExcelJS from 'exceljs';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSection } from './db';
import SectionForm from './SectionForm';
import type { Section } from './types';

beforeEach(() => {
  indexedDB = new IDBFactory();
});

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

// Semester is a picker now (plan.md §18) — Autumn is pre-selected below
// by default (see currentSemesterSeason's own test for why, in
// sections.test.ts), so only the year needs a real change; the season
// button is clicked anyway so this helper doesn't depend on that default
// staying "Autumn" as the current date moves on.
function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/course code/i), { target: { value: 'CSE203' } });
  fireEvent.change(screen.getByLabelText(/^section$/i), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Autumn' }));
  fireEvent.change(screen.getByLabelText(/semester year/i), { target: { value: '2026' } });
}

function uploadFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

describe('SectionForm — creating a section', () => {
  it('hands a complete Section to onSave', async () => {
    const onSave = vi.fn();
    render(<SectionForm onSave={onSave} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /create section/i })).toBeEnabled());

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /create section/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ courseCode: 'CSE203', label: '2', semester: 'Autumn 2026', idDigits: 7 }),
    );
  });

  it('refuses to save with a missing field', async () => {
    const onSave = vi.fn();
    render(<SectionForm onSave={onSave} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /create section/i })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /create section/i }));

    expect(screen.getByText(/course code is required/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  // step.md 13.3's duplicate check — the real reason it exists.
  it('blocks a course/label already used in the same semester', async () => {
    await saveSection({
      id: 'existing',
      courseCode: 'CSE203',
      label: '2',
      semester: 'Autumn 2026',
      idDigits: 7,
    });
    const onSave = vi.fn();
    render(<SectionForm onSave={onSave} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /create section/i })).toBeEnabled());

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /create section/i }));

    expect(await screen.findByText(/CSE203-2 already exists/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('does not flag a duplicate against a DIFFERENT semester', async () => {
    await saveSection({
      id: 'existing',
      courseCode: 'CSE203',
      label: '2',
      semester: 'Spring 2026',
      idDigits: 7,
    });
    const onSave = vi.fn();
    render(<SectionForm onSave={onSave} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /create section/i })).toBeEnabled());

    fillRequiredFields(); // "Autumn 2026" — different semester
    fireEvent.click(screen.getByRole('button', { name: /create section/i }));

    expect(onSave).toHaveBeenCalled();
  });

  it('pre-fills the form and excludes itself from the duplicate check when editing', async () => {
    // "Fall 2026" is deliberately NOT something the picker could have
    // produced (see the dedicated fallback test below) — courseCode/label
    // are what this test cares about, and using a legacy-shaped semester
    // here doubles as proof that an unparseable value doesn't crash the
    // pre-fill.
    const editing: Section = {
      id: 'existing',
      courseCode: 'CSE203',
      label: '2',
      semester: 'Fall 2026',
      idDigits: 7,
    };
    await saveSection(editing);
    const onSave = vi.fn();
    render(<SectionForm editing={editing} onSave={onSave} onCancel={vi.fn()} />);
    await screen.findByDisplayValue('CSE203');
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'existing', courseCode: 'CSE203' }));
  });

  // Plan.md §18 — the picker's fallback for a section created before it
  // existed (or any other value the picker itself could never have
  // produced): default to today's own season/year rather than leaving
  // the picker in an invalid state or crashing on an unparseable string.
  it('falls back to the CURRENT season/year when editing a section with an unparseable semester', async () => {
    const editing: Section = {
      id: 'existing',
      courseCode: 'CSE203',
      label: '2',
      semester: 'F26', // nothing the picker could have produced
      idDigits: 7,
    };
    await saveSection(editing);
    const onSave = vi.fn();
    render(<SectionForm editing={editing} onSave={onSave} onCancel={vi.fn()} />);
    await screen.findByDisplayValue('CSE203');
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    const saved = onSave.mock.calls[0][0];
    // Whatever today's real season/year actually are — this must not
    // literally still be "F26", and it must be a real picker-shaped value.
    expect(saved.semester).not.toBe('F26');
    expect(saved.semester).toMatch(/^(Spring|Summer|Autumn) \d{4}$/);
  });

  it('pre-fills the picker from a section the picker itself produced', async () => {
    const editing: Section = {
      id: 'existing',
      courseCode: 'CSE203',
      label: '2',
      semester: 'Summer 2025',
      idDigits: 7,
    };
    await saveSection(editing);
    const onSave = vi.fn();
    render(<SectionForm editing={editing} onSave={onSave} onCancel={vi.fn()} />);
    await screen.findByDisplayValue('CSE203');
    expect(screen.getByRole('button', { name: 'Summer' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText(/semester year/i)).toHaveValue(2025);
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ semester: 'Summer 2025' }));
  });

  it('calls onCancel without saving', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<SectionForm onSave={onSave} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

// step.md 13.9 (Phase B) — the roster upload, relocated from Setup.tsx
// unchanged in behaviour (step.md 12.1-12.4's original suite, ported).
describe('SectionForm — class-list workbook upload', () => {
  it('parses a valid roster and shows the confirm card', async () => {
    render(<SectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const input = document.getElementById('rosterFile') as HTMLInputElement;
    uploadFile(input, await xlsxFile('roster.xlsx', ROSTER_ROWS));

    expect(await screen.findByText(/class list:/i)).toBeInTheDocument();
    expect(screen.getByText(/2 students/i)).toBeInTheDocument();
    expect(screen.getByText(/monem tazwar/i)).toBeInTheDocument();
  });

  it('shows the selected filename even though the native input reverts to "No file chosen"', async () => {
    render(<SectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const input = document.getElementById('rosterFile') as HTMLInputElement;
    uploadFile(input, await xlsxFile('my-roster.xlsx', ROSTER_ROWS));

    expect(await screen.findByText('Selected: my-roster.xlsx')).toBeInTheDocument();
    await screen.findByText(/class list:/i);
    expect(input.value).toBe('');
    expect(screen.getByText('Selected: my-roster.xlsx')).toBeInTheDocument();
  });

  it('saves with no roster attached at all — it is optional', async () => {
    const onSave = vi.fn();
    render(<SectionForm onSave={onSave} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /create section/i })).toBeEnabled());

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /create section/i }));

    expect(onSave).toHaveBeenCalled();
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('roster');
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('workbook');
  });

  it('rejects a workbook with no roster-shaped sheet, naming the reason', async () => {
    render(<SectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const input = document.getElementById('rosterFile') as HTMLInputElement;
    uploadFile(input, await xlsxFile('no-roster.xlsx', [['just', 'some', 'data']]));

    expect(await screen.findByText(/no sheet in this file/i)).toBeInTheDocument();
  });

  it('rejects a file ExcelJS cannot parse at all', async () => {
    render(<SectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const input = document.getElementById('rosterFile') as HTMLInputElement;
    const badFile = new File(['not a real xlsx'], 'bad.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    uploadFile(input, badFile);

    expect(await screen.findByText(/couldn.t read this file/i)).toBeInTheDocument();
  });

  it('flags duplicate ids within the roster without blocking the upload', async () => {
    render(<SectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const input = document.getElementById('rosterFile') as HTMLInputElement;
    uploadFile(
      input,
      await xlsxFile('dupes.xlsx', [
        ['SL', 'STUDENT ID', 'STUDENT NAME'],
        [1, '1722112', 'A'],
        [2, '1722112', 'B'],
      ]),
    );

    expect(await screen.findByText(/appears more than once/i)).toBeInTheDocument();
  });

  it('auto-opens the picker when two roster-shaped sheets are ambiguous, and "Change" resolves it', async () => {
    render(<SectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const input = document.getElementById('rosterFile') as HTMLInputElement;
    uploadFile(
      input,
      await xlsxFile(
        'two-sections.xlsx',
        [['unrelated', 'cover page']],
        [
          { name: 'Section 1', rows: [['SL', 'STUDENT ID', 'STUDENT NAME'], [1, '1111111', 'A']] },
          { name: 'Section 2', rows: [['SL', 'STUDENT ID', 'STUDENT NAME'], [1, '2222222', 'B']] },
        ],
      ),
    );

    expect(await screen.findByRole('button', { name: /section 1.*1 student/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /section 2.*1 student/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /section 2.*1 student/i }));
    await waitFor(() => expect(screen.getByText('Section 2', { selector: 'strong' })).toBeInTheDocument());
  });

  it('re-normalizes the roster if Student ID digits is changed after upload', async () => {
    render(<SectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const input = document.getElementById('rosterFile') as HTMLInputElement;
    uploadFile(
      input,
      await xlsxFile('short-id.xlsx', [
        ['SL', 'STUDENT ID', 'STUDENT NAME'],
        [1, 212345, 'Someone'],
      ]),
    );
    await screen.findByText(/class list:/i);

    fireEvent.change(screen.getByLabelText(/student id digits/i), { target: { value: '8' } });
    expect(screen.getByText(/class list:/i)).toBeInTheDocument();
  });

  it('editing a section with an existing workbook shows it, with a Remove option', async () => {
    const editing: Section = {
      id: 'existing',
      courseCode: 'CSE203',
      label: '2',
      semester: 'Fall 2026',
      idDigits: 7,
      roster: { sheetName: 'data', headerRow: 1, students: [], duplicateIds: [] },
      workbook: { fileName: 'old-roster.xlsx', bytes: new ArrayBuffer(8), capturedAt: '2026-09-01T00:00:00.000Z', source: 'uploaded' },
    };
    render(<SectionForm editing={editing} onSave={vi.fn()} onCancel={vi.fn()} />);

    expect(await screen.findByText('old-roster.xlsx', { selector: 'strong' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(screen.queryByText('old-roster.xlsx', { selector: 'strong' })).not.toBeInTheDocument();
  });

  it('keeps the existing roster when saving without a fresh upload', async () => {
    const editing: Section = {
      id: 'existing',
      courseCode: 'CSE203',
      label: '2',
      semester: 'Fall 2026',
      idDigits: 7,
      roster: { sheetName: 'data', headerRow: 1, students: [], duplicateIds: [] },
      workbook: { fileName: 'old-roster.xlsx', bytes: new ArrayBuffer(8), capturedAt: '2026-09-01T00:00:00.000Z', source: 'uploaded' },
    };
    const onSave = vi.fn();
    render(<SectionForm editing={editing} onSave={onSave} onCancel={vi.fn()} />);
    await screen.findByText('old-roster.xlsx', { selector: 'strong' });
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave.mock.calls[0][0].workbook.fileName).toBe('old-roster.xlsx');
  });
});

// A cleared number field must stay cleared (issues.md, 2026-09-08) —
// ported here for the idDigits field, which now lives on this form.
describe('SectionForm — clearing the ID-digits field', () => {
  it('leaves the box empty instead of writing a 0 back into it', async () => {
    render(<SectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const digits = (await screen.findByLabelText(/student id digits/i)) as HTMLInputElement;
    fireEvent.change(digits, { target: { value: '' } });
    expect(digits.value).toBe('');
  });

  it('refuses to save with an empty ID-digits field', async () => {
    const onSave = vi.fn();
    render(<SectionForm onSave={onSave} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /create section/i })).toBeEnabled());

    fillRequiredFields();
    fireEvent.change(screen.getByLabelText(/student id digits/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /create section/i }));

    expect(screen.getByText(/student id digits must be a whole number/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

// The year half of the semester picker is a real number input and needs
// the same cleared-field discipline idDigits already has (issues.md,
// 2026-09-08) — season itself can never be cleared, it's a fixed choice.
describe('SectionForm — clearing the semester-year field', () => {
  it('leaves the box empty instead of writing a 0 back into it', async () => {
    render(<SectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const yearInput = (await screen.findByLabelText(/semester year/i)) as HTMLInputElement;
    fireEvent.change(yearInput, { target: { value: '' } });
    expect(yearInput.value).toBe('');
  });

  it('refuses to save with an empty year', async () => {
    const onSave = vi.fn();
    render(<SectionForm onSave={onSave} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /create section/i })).toBeEnabled());

    fireEvent.change(screen.getByLabelText(/course code/i), { target: { value: 'CSE203' } });
    fireEvent.change(screen.getByLabelText(/^section$/i), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/semester year/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /create section/i }));

    expect(screen.getByText(/year must be a 4-digit year/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('refuses a year that is not a real 4-digit year', async () => {
    const onSave = vi.fn();
    render(<SectionForm onSave={onSave} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /create section/i })).toBeEnabled());

    fireEvent.change(screen.getByLabelText(/course code/i), { target: { value: 'CSE203' } });
    fireEvent.change(screen.getByLabelText(/^section$/i), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/semester year/i), { target: { value: '26' } });
    fireEvent.click(screen.getByRole('button', { name: /create section/i }));

    expect(screen.getByText(/year must be a 4-digit year/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
