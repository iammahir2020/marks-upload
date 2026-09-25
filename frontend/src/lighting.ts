// Live lighting hint and torch control for the camera screen (2026-09-25).
//
// The two measures are the backend's (backend/app/detection.py:
// paper_level, evenness), applied to a small copy of the live video frame so
// the instructor hears about a dark room or a shadow BEFORE capturing:
//
//   paper level — the 90th-percentile grey: how white the paper comes out.
//   evenness    — min/max of that level across a 4x4 grid: a shadow makes
//                 one region much darker than the rest.
//
// A hint never blocks Capture, and the torch is never switched on by the
// app — only by the instructor's own tap (the owner's decision).

// Thresholds. The live hint warns a little EARLIER than the backend fails
// (DARK_PAPER_LEVEL = 70 there): measured on darkened testset photos, the
// grid still reads at paper ~89 and ~63, collapses by ~46.
export const HINT_DARK_LEVEL = 80;
// Same as the backend's EVENNESS_FLOOR: good photos are >= 0.83; shadows
// start costing reads around 0.6.
export const HINT_EVENNESS_FLOOR = 0.6;

export type LightingHint = 'dark' | 'uneven' | null;

export interface LightingReading {
  paper: number;
  evenness: number;
  hint: LightingHint;
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function percentile90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

/** Measure an RGBA frame (canvas ImageData layout). */
export function readLighting(rgba: Uint8ClampedArray, width: number, height: number, grid = 4): LightingReading {
  const all: number[] = [];
  const cells: number[][] = Array.from({ length: grid * grid }, () => []);
  for (let y = 0; y < height; y++) {
    const row = Math.min(grid - 1, Math.floor((y * grid) / height));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
      all.push(v);
      cells[row * grid + Math.min(grid - 1, Math.floor((x * grid) / width))].push(v);
    }
  }
  const paper = percentile90(all);
  const levels = cells.map(percentile90);
  const top = Math.max(...levels);
  const evenness = top > 0 ? Math.min(...levels) / top : 0;
  const hint: LightingHint =
    paper < HINT_DARK_LEVEL ? 'dark' : evenness < HINT_EVENNESS_FLOOR ? 'uneven' : null;
  return { paper, evenness, hint };
}

/** Show a hint only once two readings in a row agree, and clear it the same
 *  way — so a hand passing over the page doesn't make it flicker. */
export function settledHint(previous: LightingHint, recent: LightingHint[]): LightingHint {
  if (recent.length < 2) return previous;
  const [a, b] = recent.slice(-2);
  return a === b ? a : previous;
}

// --- Torch -------------------------------------------------------------------
// MediaTrackCapabilities.torch is not in TypeScript's DOM lib yet.

type TorchCapable = MediaTrackCapabilities & { torch?: boolean };

/** Whether this camera can switch its light on (Chrome on Android, Safari on
 *  recent iPhones; checked per device, never assumed). */
export function hasTorch(track: MediaStreamTrack | null | undefined): boolean {
  if (!track || typeof track.getCapabilities !== 'function') return false;
  try {
    return Boolean((track.getCapabilities() as TorchCapable).torch);
  } catch {
    return false;
  }
}

export async function setTorch(track: MediaStreamTrack, on: boolean): Promise<void> {
  await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
}

export function hintMessage(hint: LightingHint, torchAvailable: boolean, torchOn: boolean): string | null {
  if (hint === 'dark') {
    if (torchAvailable && !torchOn) return 'Too dark — tap Light, or find more light';
    return 'Too dark — find more light';
  }
  if (hint === 'uneven') return 'Shadow on the page — keep your hand and phone out of the light';
  return null;
}
