// POST /api/scan (step.md step 6.4). Mirrors backend/app/models.py's
// ScanResult exactly.
import { getSourceId } from './db';
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

// Three cases, and the empty one is deliberate:
//
//   unset   — the laptop. Derive the backend's address from wherever this
//             page was loaded, so localhost and the LAN IP both work with
//             nothing hardcoded (plan.md §9 "Running locally").
//   ""      — SAME ORIGIN. Requests become relative (`/api/scan`), which
//             is what the deployed setup uses: CloudFront serves the
//             frontend and routes /api/* to the Lambda, so there is no
//             second origin and therefore no CORS at all.
//   a URL   — an explicit backend elsewhere.
//
// Checking `!== undefined` rather than truthiness is the whole point: an
// empty string is a real answer here, and `if (override)` would silently
// treat it as "unset" and fall through to hostname:8000 — which, hosted,
// is a port nothing listens on.
function apiBase(): string {
  const override = import.meta.env.VITE_API_BASE as string | undefined;
  if (override !== undefined) return override.replace(/\/+$/, '');
  return `${window.location.protocol}//${window.location.hostname}:${DEFAULT_API_PORT}`;
}

// A scan that never comes back must still end, or it wedges the whole
// session (issues.md N3). `fetch` has no timeout of its own: a dropped wifi
// association mid-upload leaves the promise pending indefinitely, the queue
// entry stays 'pending' forever, and since the capture button is disabled
// while anything is in flight, that disables it for the rest of the session
// with no recovery but a page reload.
//
// 60 s is deliberately generous — well past a slow scan over a slow LAN,
// and past the ~9 s cold start of the hosted backend — because the job here
// is to bound the pathological case, not to give up on a slow one.
//
// AbortController rather than AbortSignal.timeout(): the latter is not
// available in every browser this might meet, nor in the jsdom test
// environment, and a polyfill check is more code than the controller.
const REQUEST_TIMEOUT_MS = 60_000;

async function postWithTimeout(url: string, body: FormData): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { method: 'POST', body, signal: controller.signal });
  } catch (err) {
    // Reported as a plain message because it lands in the queue entry's own
    // "Failed: ..." row, which the instructor reads mid-class.
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s — check the connection, then retake.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// The backend answers with a useful body and, for 429, a useful header:
//
//   400  {"detail": "Invalid config: ..."}     — which rule the config broke
//   413  {"detail": "Image too large."}
//   429  {"detail": "Too many requests..."}  + Retry-After: <seconds>
//
// All of it used to be collapsed into `HTTP <status>` (issues.md N29), so
// the instructor's queue row said "Failed: Scan request failed: HTTP 413"
// and gave them no way to tell "photo too big" from "unreadable", or to
// learn that waiting nine seconds would fix a 429. Nothing was broken —
// each side did exactly what it was built to do — which is why it never
// surfaced as a bug and had to be found by reading both ends of the
// contract together.
async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = await response.json();
    if (body && typeof body.detail === 'string') detail = body.detail;
  } catch {
    // Not JSON, or an empty body — fall through to the status-only message.
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? ` Try again in ${retryAfter}s.` : '';
    return `${detail || 'Too many requests.'}${wait}`;
  }
  if (detail) return detail;
  return `Scan request failed: HTTP ${response.status}`;
}

export async function scanImage(blob: Blob, config: QuizConfig): Promise<ScanResult> {
  const formData = new FormData();
  formData.append('image', blob, 'capture.jpg');
  // HTTP encodes a body as multipart or JSON, never both — config rides
  // as a JSON string in a form field (backend/app/main.py, stack-reference.md).
  formData.append('config', JSON.stringify(config));

  const response = await postWithTimeout(`${apiBase()}/api/scan`, formData);

  if (!response.ok) {
    throw new Error(await describeFailure(response));
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
    // A per-browser writer tag (step 11.2.5) — see db.ts's getSourceId
    // for why it is random, per-faculty, and generated here rather than
    // on the server. Inside the try because reading IndexedDB can throw
    // (private browsing, blocked storage) and this whole function is
    // best-effort: an untagged harvest is far better than a lost one.
    formData.append('source', await getSourceId());

    // Same timeout as the scan. This one is fire-and-forget so a hang here
    // cannot block the UI, but an unbounded pending request still holds the
    // image blob and a connection for as long as the tab lives.
    await postWithTimeout(`${apiBase()}/api/harvest`, formData);
  } catch {
    // Best-effort only — see the docstring above.
  }
}
