// POST /api/scan (step.md step 6.4). Mirrors backend/app/models.py's
// ScanResult exactly.
import type { QuizConfig } from './types';

export interface QuestionMark {
  q: number;
  value: number | null;
}

export interface ScanResult {
  status: 'ok' | 'failed';
  failure_reason: string | null;
  student_id: string | null;
  serial: string | null;
  questions: QuestionMark[];
  total: QuestionMark | null;
  low_confidence_fields: string[];
}

const DEFAULT_API_PORT = 8000;

// The frontend and backend are different origins on the same laptop
// (plan.md §9 "Running locally") — derive the backend's address from
// wherever this page itself was loaded (works over localhost or the LAN
// IP alike) rather than hardcoding one. VITE_API_BASE overrides this for
// a nonstandard setup (a different backend port, etc).
function apiBase(): string {
  const override = import.meta.env.VITE_API_BASE as string | undefined;
  if (override) return override;
  return `${window.location.protocol}//${window.location.hostname}:${DEFAULT_API_PORT}`;
}

export async function scanImage(blob: Blob, config: QuizConfig): Promise<ScanResult> {
  const formData = new FormData();
  formData.append('image', blob, 'capture.jpg');
  // HTTP encodes a body as multipart or JSON, never both — config rides
  // as a JSON string in a form field (backend/app/main.py, stack-reference.md).
  formData.append('config', JSON.stringify(config));

  const response = await fetch(`${apiBase()}/api/scan`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Scan request failed: HTTP ${response.status}`);
  }

  return response.json() as Promise<ScanResult>;
}

// One side (original or confirmed) of a harvest request — mirrors
// backend/app/models.py's HarvestFields exactly. `questions` is
// positional (index 0 = Q1), not keyed by `q`.
export interface HarvestFields {
  studentId: string | null;
  serial: string | null;
  questions: (number | null)[];
  total: number | null;
}

// Step 3r.6c: called from the review screen on Confirm, alongside (never
// blocking) the actual save to IndexedDB — every digit the instructor
// confirms or corrects is a labelled crop of real handwriting, worth
// capturing even though nothing consumes it yet (plan.md §16). Swallows
// its own errors rather than throwing: a harvest failure must never be
// mistaken for a save failure by whatever calls this.
export async function harvestScan(
  blob: Blob,
  config: QuizConfig,
  original: HarvestFields,
  confirmed: HarvestFields,
): Promise<void> {
  try {
    const formData = new FormData();
    formData.append('image', blob, 'capture.jpg');
    formData.append('config', JSON.stringify(config));
    formData.append('original', JSON.stringify(original));
    formData.append('confirmed', JSON.stringify(confirmed));

    await fetch(`${apiBase()}/api/harvest`, { method: 'POST', body: formData });
  } catch {
    // Best-effort only — see the docstring above.
  }
}
