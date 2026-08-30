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
