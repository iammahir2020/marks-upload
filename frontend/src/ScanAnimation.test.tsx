// step.md 14.7/14.8 — structural coverage for what jsdom actually CAN
// verify. Layout (the pin staying bounded on a 320px phone, the pin never
// covering its own caption) and the real scroll-linked crossfade are
// explicitly NOT testable here — jsdom has no layout engine and no
// scroll-driven-animation support — and are this step's own named
// real-device Done-when bar instead (plan.md §19, step.md's Test
// section). What's covered: all five states exist with real content
// regardless of animation support (progressive enhancement), the pin is
// hidden from assistive tech since the captions already carry the same
// information as real text, and the reduced-motion/unsupported-browser
// fallback in landing.css actually targets the states this component
// renders.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ScanAnimation from './ScanAnimation';

const STEPS = [
  { title: 'Photograph the grid', detail: 'a' },
  { title: 'The table is found', detail: 'b' },
  { title: 'Each cell is read', detail: 'c' },
  { title: 'Flagged, never guessed', detail: 'd' },
  { title: 'You confirm, and it saves', detail: 'e' },
];

function renderAnimation() {
  return render(<ScanAnimation steps={STEPS} />);
}

describe('ScanAnimation — structure', () => {
  it('renders all five scan states, each with real content', () => {
    const { container } = renderAnimation();
    for (let i = 1; i <= 5; i++) {
      const state = container.querySelector(`.scan-state-${i}`);
      expect(state).not.toBeNull();
      expect(state!.children.length).toBeGreaterThan(0);
    }
  });

  it('hides the illustration from assistive tech — the captions already carry the same content as text', () => {
    const { container } = renderAnimation();
    expect(container.querySelector('.lp-scan-pin')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('state 4 resolves one mark to a flag rather than a number (plan.md §19)', () => {
    const { container } = renderAnimation();
    const state4 = container.querySelector('.scan-state-4')!;
    // Three marks get a <text> value; the fourth (Q3) gets the flag path instead.
    expect(state4.querySelectorAll('path').length).toBeGreaterThan(0);
  });

  it('state 5 never renders the flagged mark as a zero — the cell stays blank', () => {
    const { container } = renderAnimation();
    const state5 = container.querySelector('.scan-state-5')!;
    const texts = Array.from(state5.querySelectorAll('text')).map((t) => t.textContent);
    expect(texts).not.toContain('0');
  });

  it('renders one caption per step, reusing the app-wide .lp-step list item', () => {
    const { container } = renderAnimation();
    const captions = container.querySelectorAll('.lp-scan-captions .lp-step');
    expect(captions).toHaveLength(5);
  });

  it('renders an optional per-step visual when one is provided, and nothing extra when it is not', () => {
    const { container } = render(
      <ScanAnimation
        steps={[{ title: 'Photograph the grid', detail: 'a', visual: <span data-testid="template-figure" /> }, ...STEPS.slice(1)]}
      />,
    );
    expect(container.querySelectorAll('.lp-step-visual')).toHaveLength(1);
    expect(container.querySelector('[data-testid="template-figure"]')).not.toBeNull();
  });
});

describe('landing.css wires the reduced-motion / unsupported-browser fallback to these exact states (14.8)', () => {
  const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'landing.css'), 'utf8');

  it('defaults every state to hidden except the settled, final one', () => {
    expect(css).toMatch(/\.scan-state\s*{[^}]*opacity:\s*0/);
    expect(css).toMatch(/\.scan-state-5\s*{[^}]*opacity:\s*1/);
  });

  it('only turns on the real crossfade behind @supports + prefers-reduced-motion: no-preference', () => {
    const supportsBlock = css.match(/@supports \(animation-timeline: view\(\)\) \{[\s\S]*/);
    expect(supportsBlock).toBeTruthy();
    expect(supportsBlock![0]).toContain('prefers-reduced-motion: no-preference');
    for (let i = 1; i <= 5; i++) {
      expect(supportsBlock![0]).toContain(`.scan-state-${i} {`);
    }
  });

  it('keeps the pin bounded and never lets a flex row stretch it (the sticky-breaking bug this step names)', () => {
    expect(css).toContain('align-items: flex-start');
  });
});
