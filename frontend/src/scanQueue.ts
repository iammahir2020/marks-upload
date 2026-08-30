// Upload queue state (step.md step 6.3) as a pure reducer, kept separate
// from the camera/DOM code so it's directly unit-testable — camera capture
// itself needs a real device to test (see learn.md step 6).
import type { ScanResult } from './api';

export interface QueueEntry {
  id: string;
  status: 'pending' | 'done' | 'error';
  result?: ScanResult;
  error?: string;
}

export type QueueAction =
  | { type: 'enqueue'; id: string }
  | { type: 'resolve'; id: string; result: ScanResult }
  | { type: 'reject'; id: string; error: string };

export function queueReducer(state: QueueEntry[], action: QueueAction): QueueEntry[] {
  switch (action.type) {
    case 'enqueue':
      return [...state, { id: action.id, status: 'pending' }];
    case 'resolve':
      return state.map((e) =>
        e.id === action.id ? { ...e, status: 'done' as const, result: action.result } : e,
      );
    case 'reject':
      return state.map((e) =>
        e.id === action.id ? { ...e, status: 'error' as const, error: action.error } : e,
      );
  }
}

export function inFlightCount(entries: QueueEntry[]): number {
  return entries.filter((e) => e.status === 'pending').length;
}

// Step 8.1 — which entry Review should auto-open next, so Confirm → save →
// next capture requires no extra tap. Earliest-captured done entry that
// hasn't already been saved or explicitly dismissed (Retake); null once
// nothing is waiting, which is the steady state between captures.
export function nextToReview(entries: QueueEntry[], handledIds: Set<string>): string | null {
  return entries.find((e) => e.status === 'done' && !handledIds.has(e.id))?.id ?? null;
}
