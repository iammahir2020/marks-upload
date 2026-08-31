// Component-level checks for step 7's Done-when bar items that need a DOM:
// the sum check recomputing live on edit, and a failed scan landing on an
// editable screen rather than a dead end. The cross-check/legal-value/sum
// *logic* itself is already covered without a DOM in validateMarks.test.ts.
import { fireEvent, render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Review from './Review';
import type { ScanResult } from './api';
import { getAllRecords, saveRecord } from './db';
import type { QuizConfig } from './types';

const config: QuizConfig = {
  quizName: 'CSE211L Quiz 1',
  idDigits: 7,
  questions: [
    { q: 1, max: 5 },
    { q: 2, max: 5 },
  ],
  totalMax: 10,
};

const okResult: ScanResult = {
  status: 'ok',
  failure_reason: null,
  student_id: '1912345',
  serial: '07',
  questions: [
    { q: 1, value: 4 },
    { q: 2, value: 3 },
  ],
  total: { q: 0, value: 7 },
  low_confidence_fields: [],
};

beforeEach(() => {
  // fresh IndexedDB per test, same pattern as db.test.ts
  globalThis.indexedDB = new IDBFactory();
});

describe('Review — sum check (7.3)', () => {
  it('recomputes live as marks are edited, without needing a save', () => {
    render(<Review result={okResult} config={config} onRetake={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByText(/Sum check: 7 vs printed 7 ✓/)).toBeInTheDocument();

    const q1 = screen.getByDisplayValue('4');
    fireEvent.change(q1, { target: { value: '5' } });

    expect(screen.getByText(/Sum check: 8 vs printed 7 ✗/)).toBeInTheDocument();
  });
});

describe('Review — legal value check (7.4)', () => {
  it('rejects an illegal edit and blocks Confirm until it is fixed', () => {
    render(<Review result={okResult} config={config} onRetake={vi.fn()} onSaved={vi.fn()} />);

    const q1 = screen.getByDisplayValue('4');
    fireEvent.change(q1, { target: { value: '5.25' } });

    expect(screen.getByText(/Must be a multiple of 0.5/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm & next/ })).toBeDisabled();

    fireEvent.change(q1, { target: { value: '5' } });
    expect(screen.queryByText(/Must be a multiple of 0.5/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm & next/ })).not.toBeDisabled();
  });
});

describe('Review — failed scan (7.6)', () => {
  const failedResult: ScanResult = {
    status: 'failed',
    failure_reason: 'table_not_found',
    student_id: null,
    serial: null,
    questions: [],
    total: null,
    low_confidence_fields: [],
  };

  it('lands on an editable screen with the reason shown, plus Retake and Enter manually', () => {
    const onRetake = vi.fn();
    render(<Review result={failedResult} config={config} onRetake={onRetake} onSaved={vi.fn()} />);

    expect(screen.getByText(/Scan failed: table_not_found/)).toBeInTheDocument();
    // two Retake buttons exist — one in the failure banner, one in the
    // always-present footer controls — either is a valid way out.
    const retakeButtons = screen.getAllByRole('button', { name: 'Retake' });
    expect(retakeButtons.length).toBeGreaterThan(0);
    fireEvent.click(retakeButtons[0]);
    expect(onRetake).toHaveBeenCalled();

    // fields are present and editable, not a dead end
    const idInput = screen.getByLabelText('Student ID') as HTMLInputElement;
    expect(idInput.value).toBe('');
    fireEvent.change(idInput, { target: { value: '1912345' } });
    expect(idInput.value).toBe('1912345');
  });

  it('Enter manually dismisses the banner without losing entered data', () => {
    render(<Review result={failedResult} config={config} onRetake={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter manually' }));
    expect(screen.queryByText(/Scan failed:/)).not.toBeInTheDocument();
  });
});

describe('Review — save path', () => {
  it('saves a valid record to IndexedDB and calls onSaved', async () => {
    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const records = await getAllRecords();
    expect(records).toHaveLength(1);
    // The scan read the serial as "07" and it is STORED as "7" — saveRecord
    // normalizes on write (issues.md #2). This assertion said '07' until
    // 2026-08-31, i.e. it pinned the bug: with two spellings of one serial
    // reaching the by-serial index, an exact-match lookup for "7" never
    // found the record saved as "07" and the duplicate cross-check silently
    // had nothing to compare.
    expect(records[0]).toMatchObject({ studentId: '1912345', serial: '7', total: 7 });
  });

  it('blocks save and asks for identity when both fields are empty', async () => {
    const emptyResult: ScanResult = { ...okResult, student_id: null, serial: null };
    const onSaved = vi.fn();
    render(<Review result={emptyResult} config={config} onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    await screen.findByText(/Enter at least a student ID or a serial/);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('Review — harvesting on confirm (step 3r.6c)', () => {
  it('posts original and confirmed values to /api/harvest, without blocking save', async () => {
    const blob = new Blob(['fake image bytes']);
    // Plain mock responses, not real Response instances — jsdom's fetch
    // polyfill doesn't reliably support Response.blob() round-tripping a
    // Blob constructed this way, and this test only cares that Review.tsx
    // calls fetch with the right arguments, not that the network stack
    // actually round-trips bytes.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (typeof input === 'string' && input === 'blob:fake-preview') {
        return { blob: async () => blob } as Response;
      }
      return { ok: true, json: async () => ({ harvested: true }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const onSaved = vi.fn();
    render(
      <Review
        result={okResult}
        config={config}
        imagePreviewUrl="blob:fake-preview"
        onRetake={vi.fn()}
        onSaved={onSaved}
      />,
    );

    // Q2 corrected from the original scan's 3 -> 4
    fireEvent.change(screen.getByDisplayValue('3'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/harvest'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );

    const harvestCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/harvest'),
    );
    const formData = harvestCall?.[1]?.body as FormData;
    const original = JSON.parse(formData.get('original') as string);
    const confirmed = JSON.parse(formData.get('confirmed') as string);

    expect(original).toEqual({ studentId: '1912345', serial: '07', questions: [4, 3], total: 7 });
    expect(confirmed).toEqual({ studentId: '1912345', serial: '07', questions: [4, 4], total: 7 });

    vi.unstubAllGlobals();
  });

  it('does not attempt to harvest when no image preview is available', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} onRetake={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

// --- Regression tests for the 2026-08-31 audit fixes -----------------------

describe('Review — Total field validation (issues.md #4)', () => {
  it('blocks Confirm and never stores NaN when Total is not a number', async () => {
    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} onRetake={vi.fn()} onSaved={onSaved} />);

    const totalInput = screen.getByDisplayValue('7') as HTMLInputElement;
    fireEvent.change(totalInput, { target: { value: 'abc' } });

    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    // Nothing saved, and nothing written — the old behaviour stored
    // total: NaN on a confirmed:true record and carried it to the export.
    expect(onSaved).not.toHaveBeenCalled();
    expect(await getAllRecords()).toHaveLength(0);
  });

  it('blocks a Total above totalMax', async () => {
    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} onRetake={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('Review — incomplete student ID (issues.md N5)', () => {
  const flagged: ScanResult = {
    ...okResult,
    student_id: '12?4567',
    low_confidence_fields: ['student_id'],
  };

  it('refuses to save an ID that still contains an unread digit', async () => {
    const onSaved = vi.fn();
    render(<Review result={flagged} config={config} onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    expect(onSaved).not.toHaveBeenCalled();
    expect(await getAllRecords()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/exactly 7 digits/);
  });

  it('saves once the instructor completes the ID', async () => {
    const onSaved = vi.fn();
    render(<Review result={flagged} config={config} onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByDisplayValue('12?4567'), { target: { value: '1234567' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('still allows saving with the ID cleared — unverified, but permitted', async () => {
    // plan.md §10: one identity field is enough. The rule is "no PARTIAL
    // id", not "an id is mandatory".
    const onSaved = vi.fn();
    render(<Review result={flagged} config={config} onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByDisplayValue('12?4567'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});

describe('Review — conflict panel goes stale on edit (issues.md #5)', () => {
  it('drops a pending conflict when the serial is corrected', async () => {
    await saveRecord({
      id: 'earlier',
      studentId: '1999999',
      serial: '7',
      questions: [{ q: 1, value: 1 }, { q: 2, value: 1 }],
      total: 2,
      confirmed: true,
      capturedAt: new Date().toISOString(),
    });

    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} onRetake={vi.fn()} onSaved={onSaved} />);

    // Same serial as the saved record, different ID -> warn.
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));
    await vi.waitFor(() => expect(screen.getByText(/conflicts with an existing record/)).toBeInTheDocument());

    // The instructor realises the serial was misread and fixes it. The
    // conflict no longer applies, so the panel must go and Confirm must
    // come back — previously it stayed, Confirm stayed disabled, and
    // "Overwrite earlier record" would have written over 'earlier'.
    fireEvent.change(screen.getByDisplayValue('07'), { target: { value: '9' } });
    expect(screen.queryByText(/conflicts with an existing record/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm & next/ })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    // 'earlier' survived untouched.
    const records = await getAllRecords();
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.id === 'earlier')?.total).toBe(2);
  });
});

describe('Review — serial validation (issues.md N21)', () => {
  it('refuses a non-numeric serial', async () => {
    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByDisplayValue('07'), { target: { value: '7a' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    expect(onSaved).not.toHaveBeenCalled();
    expect(await getAllRecords()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/Serial must be a number/);
  });

  it('still allows saving with the serial cleared, given an ID', async () => {
    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} onRetake={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByDisplayValue('07'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});
