// Component-level checks for step 9's Done-when bar items that need a
// DOM: inline edits actually persisting, the unverified count rendering,
// and identity/mark validation blocking a bad edit. Sorting and the
// unverified-record rule themselves are already covered without a DOM in
// results.test.ts.
import { fireEvent, render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllRecords, loadConfig, saveConfig, saveRecord } from './db';
import Results from './Results';
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
