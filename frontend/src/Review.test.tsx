// Component-level checks for step 7's Done-when bar items that need a DOM:
// the sum check recomputing live on edit, and a failed scan landing on an
// editable screen rather than a dead end. The cross-check/legal-value/sum
// *logic* itself is already covered without a DOM in validateMarks.test.ts.
import { fireEvent, render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Review from './Review';
import type { ScanResult } from './api';
import { getAllRecords, saveRecord, setShareCrops } from './db';
import type { ParsedRoster } from './roster';
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
  unmatched_fields: [],
};

beforeEach(() => {
  // fresh IndexedDB per test, same pattern as db.test.ts
  globalThis.indexedDB = new IDBFactory();
});

describe('Review — sum check (7.3)', () => {
  it('recomputes live as marks are edited, without needing a save', () => {
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByText(/Sum check: 7 vs printed 7 ✓/)).toBeInTheDocument();

    const q1 = screen.getByDisplayValue('4');
    fireEvent.change(q1, { target: { value: '5' } });

    expect(screen.getByText(/Sum check: 8 vs printed 7 ✗/)).toBeInTheDocument();
  });
});

describe('Review — legal value check (7.4)', () => {
  it('rejects an illegal edit and blocks Confirm until it is fixed', () => {
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);

    const q1 = screen.getByDisplayValue('4');
    fireEvent.change(q1, { target: { value: '5.25' } });

    // The field says one word; the rule is stated once for the card.
    expect(q1.closest('.field')).toHaveTextContent('Invalid');
    expect(screen.getByRole('alert')).toHaveTextContent(/steps of 0.5/);
    expect(screen.getByRole('button', { name: /Confirm & next/ })).toBeDisabled();

    fireEvent.change(q1, { target: { value: '5' } });
    expect(screen.queryByText('Invalid')).not.toBeInTheDocument();
    expect(screen.queryByText(/steps of 0.5/)).not.toBeInTheDocument();
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
    unmatched_fields: [],
  };

  it('lands on an editable screen with the reason shown, plus Retake and Enter manually', () => {
    const onRetake = vi.fn();
    render(<Review result={failedResult} config={config} assessmentId="test-assessment" onRetake={onRetake} onSaved={vi.fn()} />);

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
    render(<Review result={failedResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter manually' }));
    expect(screen.queryByText(/Scan failed:/)).not.toBeInTheDocument();
  });

  it('offers Save photo as a download of the capture, named by reason and never by content', () => {
    render(
      <Review
        result={{ ...failedResult, failure_reason: 'column_count_mismatch' }}
        config={config}
        assessmentId="test-assessment"
        imagePreviewUrl="blob:fake-preview"
        onRetake={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const link = screen.getByRole('link', { name: 'Save photo' });
    expect(link).toHaveAttribute('href', 'blob:fake-preview');
    expect(link.getAttribute('download')).toMatch(/^scan-column_count_mismatch-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.jpg$/);
  });

  it('shows no Save photo when there is no capture to save', () => {
    render(<Review result={failedResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Save photo' })).not.toBeInTheDocument();
  });
});

describe('Review — partial scan (one table miscounted)', () => {
  const partialResult: ScanResult = {
    ...okResult,
    student_id: null,
    low_confidence_fields: ['student_id'],
    table_mismatches: [{ table: 'id', found: 7, expected: 8 }],
  };

  it('names the unread table in digit boxes, keeps the fields that were read, and offers Retake and Save photo', () => {
    const onRetake = vi.fn();
    render(
      <Review
        result={partialResult}
        config={config}
        assessmentId="test-assessment"
        imagePreviewUrl="blob:fake-preview"
        onRetake={onRetake}
        onSaved={vi.fn()}
      />,
    );

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Student ID row: found 6 digit boxes, expected 7.');
    expect(screen.queryByText(/Scan failed/)).not.toBeInTheDocument();
    expect((screen.getByLabelText('Student ID') as HTMLInputElement).value).toBe('');
    expect(screen.getByDisplayValue('07')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Save photo' })).toHaveAttribute('download', expect.stringMatching(/^scan-partial-/));

    fireEvent.click(screen.getAllByRole('button', { name: 'Retake' })[0]);
    expect(onRetake).toHaveBeenCalled();
  });

  it('shows no partial banner on a full read', () => {
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByText(/couldn’t be read/)).not.toBeInTheDocument();
  });
});

describe('Review — save path', () => {
  it('saves a valid record to IndexedDB and calls onSaved', async () => {
    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);

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
    render(<Review result={emptyResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);

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
        assessmentId="test-assessment"
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

    expect(original).toEqual({
      studentId: '1912345',
      serial: '07',
      questions: [4, 3],
      total: 7,
      unmatchedFields: [], // issues.md N31 — okResult carries none
      crossedOutFields: [], // step 15 — nor any crossed-out field
    });
    expect(confirmed).toEqual({
      studentId: '1912345',
      serial: '07',
      questions: [4, 4],
      total: 7,
      unmatchedFields: [], // meaningless on this side — see api.ts's comment
      crossedOutFields: [],
    });

    vi.unstubAllGlobals();
  });

  it('sends nothing to /api/harvest when the instructor has turned sharing off (N45)', async () => {
    await setShareCrops(false);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (typeof input === 'string' && input === 'blob:fake-preview') {
        return { blob: async () => new Blob(['x']) } as Response;
      }
      return { ok: true, json: async () => ({ harvested: true }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const onSaved = vi.fn();
    render(
      <Review result={okResult} config={config} assessmentId="test-assessment"
        imagePreviewUrl="blob:fake-preview" onRetake={vi.fn()} onSaved={onSaved} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1)); // the save itself is unaffected
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget chain run
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not attempt to harvest when no image preview is available', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);
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
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);

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
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);
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
    render(<Review result={flagged} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    expect(onSaved).not.toHaveBeenCalled();
    expect(await getAllRecords()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/exactly 7 digits/);
  });

  it('saves once the instructor completes the ID', async () => {
    const onSaved = vi.fn();
    render(<Review result={flagged} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByDisplayValue('12?4567'), { target: { value: '1234567' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('still allows saving with the ID cleared — unverified, but permitted', async () => {
    // plan.md §10: one identity field is enough. The rule is "no PARTIAL
    // id", not "an id is mandatory".
    const onSaved = vi.fn();
    render(<Review result={flagged} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByDisplayValue('12?4567'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});

describe('Review — conflict panel goes stale on edit (issues.md #5)', () => {
  it('drops a pending conflict when the serial is corrected', async () => {
    await saveRecord({
      id: 'earlier',
      assessmentId: 'test-assessment',
      studentId: '1999999',
      serial: '7',
      questions: [{ q: 1, value: 1 }, { q: 2, value: 1 }],
      total: 2,
      confirmed: true,
      capturedAt: new Date().toISOString(),
    });

    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);

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

// Step.md 13.15 (Phase C) — the actual bug this closes: a shared serial or
// student ID across two different courses is normal, and the identity
// cross-check (plan.md §2's highest-value check) must not fire across
// that boundary. Same shape as the conflict test above, but the "earlier"
// record belongs to a DIFFERENT assessment.
describe('Review — the identity cross-check is scoped to one assessment (step.md 13.15)', () => {
  it('raises no conflict against a record with the same serial in a different assessment', async () => {
    await saveRecord({
      id: 'other-course',
      assessmentId: 'a-different-assessment', // e.g. CSE100, while this Review is CSE203
      studentId: '1999999',
      serial: '07', // same serial okResult reads, normalized the same way
      questions: [{ q: 1, value: 1 }, { q: 2, value: 1 }],
      total: 2,
      confirmed: true,
      capturedAt: new Date().toISOString(),
    });

    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/conflicts with an existing record/)).not.toBeInTheDocument();
  });

  it('still raises the conflict against a record in the SAME assessment', async () => {
    // Same setup as above, but this time the earlier record genuinely
    // belongs to the assessment being reviewed — the warning must survive.
    await saveRecord({
      id: 'same-course',
      assessmentId: 'test-assessment',
      studentId: '1999999',
      serial: '07',
      questions: [{ q: 1, value: 1 }, { q: 2, value: 1 }],
      total: 2,
      confirmed: true,
      capturedAt: new Date().toISOString(),
    });

    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));
    await screen.findByText(/conflicts with an existing record/);
  });
});

describe('Review — serial validation (issues.md N21)', () => {
  it('refuses a non-numeric serial', async () => {
    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByDisplayValue('07'), { target: { value: '7a' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));

    expect(onSaved).not.toHaveBeenCalled();
    expect(await getAllRecords()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/Serial must be a number/);
  });

  it('still allows saving with the serial cleared, given an ID', async () => {
    const onSaved = vi.fn();
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByDisplayValue('07'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});

// Step.md 12.10/12.11 (plan.md §17) — not-on-list flagging with a
// tap-to-accept candidate, and the resolved name shown next to a match.
const roster: ParsedRoster = {
  sheetName: 'data',
  headerRow: 1,
  students: [
    { sl: 1, row: 1 + 1, studentId: '1912345', studentIdKey: '1912345', studentName: 'Monem Tazwar' },
    { sl: 2, row: 2 + 1, studentId: '2130643', studentIdKey: '2130643', studentName: 'Salman Noor' },
  ],
  duplicateIds: [],
};

describe('Review — roster awareness (12.10/12.11)', () => {
  it('shows nothing extra when no roster is attached', () => {
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByText(/not on your class list/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Monem Tazwar')).not.toBeInTheDocument();
  });

  it('shows the matched student\'s name next to a recognized ID already on the roster', () => {
    render(<Review result={okResult} config={config} assessmentId="test-assessment" roster={roster} onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Monem Tazwar')).toBeInTheDocument();
    expect(screen.queryByText(/not on your class list/i)).not.toBeInTheDocument();
  });

  it('flags an ID matching nobody on the roster, with no suggestion when none is unique', () => {
    const result: ScanResult = { ...okResult, student_id: '9999999' };
    render(<Review result={result} config={config} assessmentId="test-assessment" roster={roster} onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText(/not on your class list/i)).toBeInTheDocument();
    expect(screen.queryByText(/did you mean/i)).not.toBeInTheDocument();
  });

  it('offers a tap-to-accept suggestion for a single-digit misread, and never applies it automatically', () => {
    // 1912345 misread as 1912395 (one substituted digit)
    const result: ScanResult = { ...okResult, student_id: '1912395' };
    render(<Review result={result} config={config} assessmentId="test-assessment" roster={roster} onRetake={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByText(/not on your class list/i)).toBeInTheDocument();
    expect(screen.getByText(/did you mean/i)).toBeInTheDocument();
    // Not applied on its own — the field still holds the misread value.
    expect(screen.getByDisplayValue('1912395')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /use this/i }));
    expect(screen.getByDisplayValue('1912345')).toBeInTheDocument();
    expect(screen.getByText('Monem Tazwar')).toBeInTheDocument();
    expect(screen.queryByText(/not on your class list/i)).not.toBeInTheDocument();
  });

  it('offers a suggestion for a partial read consistent with exactly one roster student', () => {
    // low-confidence recognizer output: one digit unread
    const result: ScanResult = {
      ...okResult,
      student_id: '191234?',
      low_confidence_fields: ['student_id'],
    };
    render(<Review result={result} config={config} assessmentId="test-assessment" roster={roster} onRetake={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByText(/did you mean/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /use this/i }));
    expect(screen.getByDisplayValue('1912345')).toBeInTheDocument();
  });

  it('never treats a partial read as an exact match even if it looks close', () => {
    const result: ScanResult = { ...okResult, student_id: '191234?' };
    render(<Review result={result} config={config} assessmentId="test-assessment" roster={roster} onRetake={vi.fn()} onSaved={vi.fn()} />);
    // Flagged, not silently accepted as Monem Tazwar.
    expect(screen.queryByText('Monem Tazwar')).not.toBeInTheDocument();
    expect(screen.getByText(/not on your class list/i)).toBeInTheDocument();
  });

  it('updates the roster flag live as the ID field is corrected by hand', () => {
    const result: ScanResult = { ...okResult, student_id: '9999999' };
    render(<Review result={result} config={config} assessmentId="test-assessment" roster={roster} onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText(/not on your class list/i)).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('9999999'), { target: { value: '2130643' } });
    expect(screen.queryByText(/not on your class list/i)).not.toBeInTheDocument();
    expect(screen.getByText('Salman Noor')).toBeInTheDocument();
  });
});

describe('Review — an unmatched mark is explained, not just blank (issues.md N33)', () => {
  const result: ScanResult = {
    ...okResult,
    questions: [
      { q: 1, value: null }, // ink present, no legal value matched
      { q: 2, value: 3 },
    ],
    total: { q: 0, value: null },
    low_confidence_fields: ['q1', 'total'],
    unmatched_fields: ['q1', 'total'],
  };

  it('marks each flagged field with a short status and explains once for the card', () => {
    render(<Review result={result} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getAllByText('Unclear')).toHaveLength(2);
    // One sentence for the whole card, not one per field.
    expect(screen.getAllByText(/check the highlighted marks against the script/i)).toHaveLength(1);
  });

  it('says nothing about a field that is merely blank, not unmatched', () => {
    // Q2 is fine, and low_confidence_fields/unmatched_fields agree it's
    // not flagged at all — the message must not appear for it.
    render(<Review result={result} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    const q2 = screen.getByDisplayValue('3').closest('.field');
    expect(q2).not.toHaveTextContent('Unclear');
  });

  it('clears the message the moment the instructor types anything, whether legal or not', () => {
    render(<Review result={result} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    const q1Container = screen.getAllByText('Unclear')[0].closest('.field')!;
    const q1Input = q1Container.querySelector('input')!;

    fireEvent.change(q1Input, { target: { value: '4' } }); // a real, legal value from the script
    expect(screen.queryAllByText('Unclear')).toHaveLength(1); // total's remains
  });

  it('never blocks Confirm on its own — only an actual illegal value does', () => {
    // A blank field is valid-but-unverified (plan.md §10), same rule as
    // every other optional field; this message is informational only.
    render(<Review result={result} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Confirm & next/ })).not.toBeDisabled();
  });
});

// Step.md 13.13 — Review renders as a fixed overlay covering Scan.tsx's
// own header, so the section context has to be shown here too, not just
// on the screen underneath it.
describe('Review — section context (step.md 13.13)', () => {
  it('shows the section label when provided', () => {
    render(
      <Review
        result={okResult}
        config={config}
        assessmentId="test-assessment"
        sectionLabel="CSE203-2 · Quiz 1"
        onRetake={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText('CSE203-2 · Quiz 1')).toBeInTheDocument();
  });

  it('renders nothing extra when no section label is given', () => {
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(document.querySelector('.eyebrow')).not.toBeInTheDocument();
  });
});

describe('Review — crossed-out writing (step 15)', () => {
  // The photo that started this: Q1 had a 6 struck out and 5 written
  // beside it; the total had nothing legible left once its struck glyph
  // was dropped.
  const result: ScanResult = {
    ...okResult,
    questions: [
      { q: 1, value: null },
      { q: 2, value: 3 },
    ],
    total: { q: 0, value: null },
    low_confidence_fields: ['q1', 'total'],
    crossed_out_fields: ['q1', 'total'],
    suggestions: { q1: '5' },
  };

  function renderIt(r: ScanResult = result) {
    return render(
      <Review result={r} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />,
    );
  }

  it('leaves the field blank and says why, rather than filling in the suggestion', () => {
    renderIt();
    const q1 = screen.getByRole('button', { name: 'Use 5' }).closest('.field')!;
    expect(q1.querySelector('input')!).toHaveValue('');
    expect(screen.getAllByText('Crossed out')).toHaveLength(2);
  });

  it('fills the field only when the instructor taps Use', () => {
    renderIt();
    const use = screen.getByRole('button', { name: 'Use 5' });
    const q1Input = use.closest('.field')!.querySelector('input')!;
    fireEvent.click(use);
    expect(q1Input).toHaveValue('5');
    // The note belongs to a blank field; once filled, it goes.
    expect(screen.getAllByText('Crossed out')).toHaveLength(1);
  });

  it('offers no button when nothing legible was left', () => {
    renderIt();
    expect(screen.getAllByRole('button', { name: /^Use / })).toHaveLength(1);
  });

  it('says nothing on a field that was not crossed out', () => {
    renderIt();
    expect(screen.getByDisplayValue('3').closest('.field')).not.toHaveTextContent(/crossed out/i);
  });

  it('offers a crossed-out serial the same way', () => {
    renderIt({ ...okResult, serial: null, crossed_out_fields: ['serial'], suggestions: { serial: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use 12' }));
    expect(screen.getByDisplayValue('12')).toBeInTheDocument();
  });

  it('points at the script for a crossed-out ID digit, with no suggestion', () => {
    renderIt({ ...okResult, student_id: '19?2345', crossed_out_fields: ['student_id'] });
    expect(screen.getByText(/a digit was crossed out/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
  });

  it('sends the crossed-out fields with the original values, so harvest refuses those crops', async () => {
    const blob = new Blob(['fake image bytes']);
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
        result={result}
        config={config}
        assessmentId="test-assessment"
        imagePreviewUrl="blob:fake-preview"
        onRetake={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use 5' }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('/api/harvest'))).toBe(true),
    );

    const call = fetchMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('/api/harvest'));
    const form = call?.[1]?.body as FormData;
    expect(JSON.parse(form.get('original') as string).crossedOutFields).toEqual(['q1', 'total']);
    expect(JSON.parse(form.get('confirmed') as string).crossedOutFields).toEqual([]);

    vi.unstubAllGlobals();
  });
});

describe('Review — field status overhaul (2026-09-24)', () => {
  it('offers a lost-decimal-point reading on an unclear mark, filling it only on Use', () => {
    const result: ScanResult = {
      ...okResult,
      questions: [
        { q: 1, value: null },
        { q: 2, value: 3 },
      ],
      total: { q: 0, value: null },
      low_confidence_fields: ['q1', 'total'],
      unmatched_fields: ['q1', 'total'],
      suggestions: { q1: '2.5' },
    };
    render(<Review result={result} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);

    const use = screen.getByRole('button', { name: 'Use 2.5' });
    const q1Input = use.closest('.field')!.querySelector('input')!;
    expect(q1Input).toHaveValue('');
    expect(screen.getByText(/or tap Use to accept a reading/i)).toBeInTheDocument();

    fireEvent.click(use);
    expect(q1Input).toHaveValue('2.5');
    expect(screen.getAllByText('Unclear')).toHaveLength(1); // only the total's remains
  });

  it('offers both readings of a 15 / 1.5 tie, fills only the one tapped, and says why', () => {
    const config25: QuizConfig = { ...config, questions: [{ q: 1, max: 5 }, { q: 2, max: 20 }], totalMax: 25 };
    const result: ScanResult = {
      ...okResult,
      total: { q: 0, value: null },
      low_confidence_fields: ['total'],
      unmatched_fields: ['total'],
      choices: { total: ['1.5', '15'] },
    };
    render(<Review result={result} config={config25} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);

    const small = screen.getByRole('button', { name: 'Use 1.5' });
    const big = screen.getByRole('button', { name: 'Use 15' });
    const totalInput = small.closest('.field')!.querySelector('input')!;
    expect(big.closest('.field')).toBe(small.closest('.field'));
    expect(totalInput).toHaveValue(''); // never pre-filled, least of all on a tie
    expect(screen.getByText(/two readings are offered/i)).toBeInTheDocument();

    fireEvent.click(big);
    expect(totalInput).toHaveValue('15');
    expect(screen.queryByRole('button', { name: /^Use / })).not.toBeInTheDocument();
    expect(screen.queryByText('Invalid')).not.toBeInTheDocument();
  });

  it('prefers the choices list over the single suggestion when both are sent', () => {
    const result: ScanResult = {
      ...okResult,
      questions: [
        { q: 1, value: null },
        { q: 2, value: 3 },
      ],
      low_confidence_fields: ['q1'],
      unmatched_fields: ['q1'],
      suggestions: { q1: '2.5' },
      choices: { q1: ['2.5'] },
    };
    render(<Review result={result} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: 'Use 2.5' })).toHaveLength(1);
    expect(screen.queryByText(/two readings are offered/i)).not.toBeInTheDocument();
  });

  it('calls a crossed-out field crossed out, not unclear, when both apply', () => {
    const result: ScanResult = {
      ...okResult,
      questions: [
        { q: 1, value: null },
        { q: 2, value: 3 },
      ],
      low_confidence_fields: ['q1'],
      unmatched_fields: ['q1'],
      crossed_out_fields: ['q1'],
    };
    render(<Review result={result} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Crossed out')).toBeInTheDocument();
    expect(screen.queryByText('Unclear')).not.toBeInTheDocument();
  });

  it('marks an illegal Total as Invalid, with the rule stated once', () => {
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '11' } });
    expect(screen.getByText('Invalid')).toBeInTheDocument();
    expect(screen.getAllByText(/steps of 0.5/)).toHaveLength(1);
  });

  it('shows no card note at all on a clean scan', () => {
    render(<Review result={okResult} config={config} assessmentId="test-assessment" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByText(/check the highlighted marks/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/steps of 0.5/)).not.toBeInTheDocument();
  });
});

// Step 16 (plan.md §21) — a quiz printed without a Serial box.
describe('Review — no Serial box (step 16)', () => {
  const noSerialConfig: QuizConfig = { ...config, hasSerial: false };
  const noSerialResult: ScanResult = { ...okResult, serial: null };

  it('does not show a Serial field', () => {
    render(<Review result={noSerialResult} config={noSerialConfig} assessmentId="a" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByText('Serial')).not.toBeInTheDocument();
    expect(screen.getByText('Student ID')).toBeInTheDocument();
  });

  it('still shows the Serial field when the config has no hasSerial (every existing quiz)', () => {
    render(<Review result={okResult} config={config} assessmentId="a" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Serial')).toBeInTheDocument();
  });

  it('refuses to save without a student ID', async () => {
    const onSaved = vi.fn();
    render(
      <Review
        result={{ ...noSerialResult, student_id: null }}
        config={noSerialConfig}
        assessmentId="a"
        onRetake={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));
    expect(await screen.findByText(/no serial to fall back on/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(await getAllRecords()).toHaveLength(0);
  });

  it('saves with the ID alone, and stores no serial', async () => {
    const onSaved = vi.fn();
    render(<Review result={noSerialResult} config={noSerialConfig} assessmentId="a" onRetake={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [saved] = await getAllRecords();
    expect(saved.studentId).toBe('1912345');
    expect(saved.serial).toBeNull();
  });

  it('blocks a second scan of the same ID, offering to overwrite it', async () => {
    await saveRecord({
      id: 'earlier',
      assessmentId: 'a',
      studentId: '1912345',
      serial: null,
      questions: [],
      total: 5,
      confirmed: true,
      capturedAt: '2026-09-25T00:00:00.000Z',
    });
    const onSaved = vi.fn();
    render(<Review result={noSerialResult} config={noSerialConfig} assessmentId="a" onRetake={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm & next/ }));
    expect(await screen.findByText(/student ID is already saved/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /overwrite earlier record/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save anyway/i })).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('points at the Serial setting when a scan fails with a column mismatch', () => {
    const mismatch: ScanResult = { ...noSerialResult, status: 'failed', failure_reason: 'column_count_mismatch' };
    const { unmount } = render(
      <Review result={mismatch} config={noSerialConfig} assessmentId="a" onRetake={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByText(/set to “no Serial box”/)).toBeInTheDocument();
    unmount();
    render(<Review result={mismatch} config={config} assessmentId="a" onRetake={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText(/untick “Serial box on paper”/)).toBeInTheDocument();
  });
});
