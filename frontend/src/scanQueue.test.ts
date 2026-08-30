import { describe, expect, it } from 'vitest';
import { queueReducer, inFlightCount, nextToReview, type QueueEntry } from './scanQueue';
import type { ScanResult } from './api';

const okResult: ScanResult = {
  status: 'ok',
  failure_reason: null,
  student_id: '1912345',
  serial: '07',
  questions: [{ q: 1, value: 4 }],
  total: { q: 0, value: 4 },
  low_confidence_fields: [],
};

describe('queueReducer', () => {
  it('enqueue adds a pending entry', () => {
    const state = queueReducer([], { type: 'enqueue', id: 'a' });
    expect(state).toEqual([{ id: 'a', status: 'pending' }]);
  });

  it('the camera never blocks: multiple captures can be pending at once', () => {
    let state: QueueEntry[] = [];
    state = queueReducer(state, { type: 'enqueue', id: 'a' });
    state = queueReducer(state, { type: 'enqueue', id: 'b' });
    state = queueReducer(state, { type: 'enqueue', id: 'c' });
    expect(inFlightCount(state)).toBe(3);
  });

  it('resolve transitions only the matching entry to done, others stay pending', () => {
    let state: QueueEntry[] = [];
    state = queueReducer(state, { type: 'enqueue', id: 'a' });
    state = queueReducer(state, { type: 'enqueue', id: 'b' });
    state = queueReducer(state, { type: 'resolve', id: 'a', result: okResult });

    expect(state.find((e) => e.id === 'a')).toEqual({ id: 'a', status: 'done', result: okResult });
    expect(state.find((e) => e.id === 'b')?.status).toBe('pending');
    expect(inFlightCount(state)).toBe(1);
  });

  it('reject transitions the matching entry to error with the message, not a crash', () => {
    let state: QueueEntry[] = [];
    state = queueReducer(state, { type: 'enqueue', id: 'a' });
    state = queueReducer(state, { type: 'reject', id: 'a', error: 'Failed to fetch' });

    expect(state).toEqual([{ id: 'a', status: 'error', error: 'Failed to fetch' }]);
    expect(inFlightCount(state)).toBe(0);
  });

  it('a dead backend produces an error entry, not a hang — resolved order can differ from capture order', () => {
    // capture a, b, c in order; b's request fails first (backend died mid-queue)
    let state: QueueEntry[] = [];
    state = queueReducer(state, { type: 'enqueue', id: 'a' });
    state = queueReducer(state, { type: 'enqueue', id: 'b' });
    state = queueReducer(state, { type: 'enqueue', id: 'c' });
    state = queueReducer(state, { type: 'reject', id: 'b', error: 'Failed to fetch' });

    expect(state.map((e) => e.status)).toEqual(['pending', 'error', 'pending']);
  });
});

describe('inFlightCount', () => {
  it('is zero for an empty queue', () => {
    expect(inFlightCount([])).toBe(0);
  });

  it('counts only pending entries, not done or error ones', () => {
    const state: QueueEntry[] = [
      { id: 'a', status: 'done', result: okResult },
      { id: 'b', status: 'pending' },
      { id: 'c', status: 'error', error: 'x' },
      { id: 'd', status: 'pending' },
    ];
    expect(inFlightCount(state)).toBe(2);
  });
});

describe('nextToReview', () => {
  it('is null when nothing is done yet', () => {
    const state: QueueEntry[] = [{ id: 'a', status: 'pending' }];
    expect(nextToReview(state, new Set())).toBeNull();
  });

  it('picks the earliest-captured done entry not already handled', () => {
    const state: QueueEntry[] = [
      { id: 'a', status: 'done', result: okResult },
      { id: 'b', status: 'done', result: okResult },
    ];
    expect(nextToReview(state, new Set())).toBe('a');
    expect(nextToReview(state, new Set(['a']))).toBe('b');
  });

  it('skips a done entry once it is saved or dismissed via Retake', () => {
    const state: QueueEntry[] = [
      { id: 'a', status: 'done', result: okResult },
      { id: 'b', status: 'pending' },
    ];
    expect(nextToReview(state, new Set(['a']))).toBeNull();
  });

  it('ignores pending and error entries even if unhandled', () => {
    const state: QueueEntry[] = [
      { id: 'a', status: 'error', error: 'x' },
      { id: 'b', status: 'pending' },
      { id: 'c', status: 'done', result: okResult },
    ];
    expect(nextToReview(state, new Set())).toBe('c');
  });
});
