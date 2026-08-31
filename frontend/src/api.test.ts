// The frontend half of the backend's error contract (issues.md N29).
//
// Step 11.4 built 413 and 429 with useful bodies — and a Retry-After header
// computed to the second — and the frontend collapsed all of it into
// "HTTP <status>". Nothing was broken: each side did exactly what it was
// built to do, which is why it never surfaced as a bug and had to be found
// by reading both ends of the contract together.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanImage } from './api';
import type { QuizConfig } from './types';

const config: QuizConfig = {
  quizName: 'Q',
  idDigits: 7,
  questions: [{ q: 1, max: 5 }],
  totalMax: 5,
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => ({
    ok: false,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('scanImage — surfacing the backend detail', () => {
  it('reports "Image too large." rather than HTTP 413', async () => {
    vi.stubGlobal('fetch', respond(413, { detail: 'Image too large.' }));
    await expect(scanImage(new Blob(['x']), config)).rejects.toThrow('Image too large.');
  });

  it('reports the rate-limit message AND how long to wait', async () => {
    // The remedy is the actionable part and it was the part being thrown
    // away. 429 is also the response most likely to reach someone who is
    // not the author, since the limit exists because the URL is public.
    vi.stubGlobal(
      'fetch',
      respond(429, { detail: 'Too many requests. Please slow down.' }, { 'Retry-After': '9' }),
    );
    await expect(scanImage(new Blob(['x']), config)).rejects.toThrow(
      'Too many requests. Please slow down. Try again in 9s.',
    );
  });

  it('reports which config rule was broken', async () => {
    vi.stubGlobal(
      'fetch',
      respond(400, { detail: 'Invalid config: totalMax (25.0) must equal the sum of question maxima (10.0)' }),
    );
    await expect(scanImage(new Blob(['x']), config)).rejects.toThrow(/totalMax/);
  });

  it('falls back to the status when there is no JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        headers: { get: () => null },
        json: async () => {
          throw new Error('not json');
        },
      })),
    );
    await expect(scanImage(new Blob(['x']), config)).rejects.toThrow('HTTP 502');
  });
});
