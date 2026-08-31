// Step 11.5 — the data-collection disclosure.
//
// This is tested for a different reason than most UI: it is a promise made
// to the people using the app about their students' handwriting. Wording
// can change freely, but it must not silently *disappear* — and the
// always-visible line specifically must not drift back inside the
// collapsible <details>, where a returning user (whose config is already
// saved, so the section is collapsed) would never see it again.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Setup from './Setup';
import { getAllRecords, saveConfig, saveRecord } from './db';
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
    expect(onViewResults).toHaveBeenCalledWith(config);
  });

  it('reset needs a second confirmation and then clears both stores', async () => {
    await saveConfig(config);
    await saveRecord(makeRecord());
    render(<Setup onStart={vi.fn()} onViewResults={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /reset everything/i }));
    // Cancelling must delete nothing.
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(await getAllRecords()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /reset everything/i }));
    fireEvent.click(screen.getByRole('button', { name: /yes, delete everything/i }));

    await waitFor(async () => expect(await getAllRecords()).toHaveLength(0));
    // The notice goes with it, and the form returns to a blank setup.
    await waitFor(() =>
      expect(screen.queryByText(/already scanned/i)).not.toBeInTheDocument(),
    );
  });
});
