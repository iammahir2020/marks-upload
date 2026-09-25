// lighting.ts — the live hint and torch control (2026-09-25).
import { describe, expect, it, vi } from 'vitest';
import {
  HINT_DARK_LEVEL,
  hasTorch,
  hintMessage,
  readLighting,
  setTorch,
  settledHint,
} from './lighting';

const W = 160;
const H = 90;

/** An RGBA frame: white "paper" at `level`, with dark "ink" lines, and an
 *  optional shadow darkening the left half by `shadow` (0-1). */
function frame(level: number, shadow = 0): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ink = x % 20 === 0 || y % 15 === 0; // grid lines
      let v = ink ? 30 : level;
      if (x < W / 2) v *= 1 - shadow;
      const i = (y * W + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  return px;
}

describe('readLighting', () => {
  it('says nothing about a well-lit, even page', () => {
    const r = readLighting(frame(190), W, H);
    expect(r.hint).toBeNull();
    expect(r.paper).toBeGreaterThan(180);
    expect(r.evenness).toBeGreaterThan(0.95);
  });

  it('calls a dim page too dark', () => {
    const r = readLighting(frame(HINT_DARK_LEVEL - 20), W, H);
    expect(r.hint).toBe('dark');
  });

  it('calls a half-shadowed page uneven', () => {
    const r = readLighting(frame(190, 0.6), W, H);
    expect(r.hint).toBe('uneven');
    expect(r.evenness).toBeLessThan(0.6);
  });

  it('prefers "dark" when the page is both dark and uneven', () => {
    expect(readLighting(frame(60, 0.6), W, H).hint).toBe('dark');
  });

  it('measures the paper, not the ink: a dense grid on bright paper is still bright', () => {
    expect(readLighting(frame(200), W, H).paper).toBeGreaterThan(190);
  });
});

describe('settledHint — no flicker', () => {
  it('waits for two readings that agree before showing a hint', () => {
    expect(settledHint(null, ['dark'])).toBeNull();
    expect(settledHint(null, [null, 'dark'])).toBeNull();
    expect(settledHint(null, ['dark', 'dark'])).toBe('dark');
  });

  it('and for two before clearing it', () => {
    expect(settledHint('dark', ['dark', null])).toBe('dark');
    expect(settledHint('dark', [null, null])).toBeNull();
  });
});

describe('hintMessage', () => {
  it('points at the Light button only when there is one and it is off', () => {
    expect(hintMessage('dark', true, false)).toMatch(/tap Light/);
    expect(hintMessage('dark', true, true)).not.toMatch(/tap Light/);
    expect(hintMessage('dark', false, false)).not.toMatch(/tap Light/);
  });

  it('explains a shadow, and says nothing when the light is fine', () => {
    expect(hintMessage('uneven', true, false)).toMatch(/shadow/i);
    expect(hintMessage(null, true, false)).toBeNull();
  });
});

describe('torch', () => {
  const track = (caps: object) =>
    ({ getCapabilities: () => caps, applyConstraints: vi.fn(async () => {}) }) as unknown as MediaStreamTrack;

  it('is offered only when the camera reports one', () => {
    expect(hasTorch(track({ torch: true }))).toBe(true);
    expect(hasTorch(track({}))).toBe(false);
    expect(hasTorch(null)).toBe(false);
    expect(hasTorch({} as MediaStreamTrack)).toBe(false); // no getCapabilities at all (older browsers)
  });

  it('a camera that throws on getCapabilities is treated as having none', () => {
    const bad = { getCapabilities: () => { throw new Error('nope'); } } as unknown as MediaStreamTrack;
    expect(hasTorch(bad)).toBe(false);
  });

  it('switches with the advanced torch constraint', async () => {
    const t = track({ torch: true });
    await setTorch(t, true);
    expect(t.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
  });
});
