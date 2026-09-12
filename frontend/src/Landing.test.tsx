// step.md 14 (Test section) — every section renders, the pinned CTA is
// present and calls through, and the copy's factual claims are pinned as
// text assertions so a future edit can't quietly overclaim something the
// code doesn't actually keep (plan.md §19's own rule: every claim here
// has to be an invariant that lives elsewhere in this repo).
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Landing from './Landing';

function renderLanding() {
  const onOpenApp = vi.fn();
  return { onOpenApp, ...render(<Landing onOpenApp={onOpenApp} />) };
}

describe('Landing — structure', () => {
  it('renders the hero headline', () => {
    renderLanding();
    expect(screen.getByRole('heading', { name: /you already graded it/i, level: 1 })).toBeInTheDocument();
  });

  it('renders all six sections, each with real content', () => {
    renderLanding();
    expect(screen.getByText(/the problem/i)).toBeInTheDocument();
    expect(screen.getByText(/how it works/i)).toBeInTheDocument();
    expect(screen.getByText(/what it refuses to do/i)).toBeInTheDocument();
    expect(screen.getByText(/where your work actually goes/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /open the app and photograph/i })).toBeInTheDocument();
  });

  it('lists all five how-it-works steps in order', () => {
    renderLanding();
    const items = screen.getAllByRole('listitem').filter((li) => li.className.includes('lp-step'));
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent(/photograph the grid/i);
    expect(items[3]).toHaveTextContent(/flagged, never guessed/i);
    expect(items[4]).toHaveTextContent(/you confirm, and it saves/i);
  });

  it('step one names the grid structure that must already be on the script', () => {
    renderLanding();
    const items = screen.getAllByRole('listitem').filter((li) => li.className.includes('lp-step'));
    expect(items[0]).toHaveTextContent(/id table/i);
    expect(items[0]).toHaveTextContent(/serial table/i);
    expect(items[0]).toHaveTextContent(/marks table/i);
  });

  it('step one shows a reference drawing of the printed grid structure, not text alone', () => {
    renderLanding();
    const items = screen.getAllByRole('listitem').filter((li) => li.className.includes('lp-step'));
    const figure = items[0].querySelector('.lp-step-visual svg[role="img"]');
    expect(figure).not.toBeNull();
    const label = figure!.getAttribute('aria-label')!;
    expect(label).toMatch(/id table/i);
    expect(label).toMatch(/serial table/i);
    expect(label).toMatch(/marks table/i);
    // ID and Serial each render as the first column of their OWN table,
    // not as a caption floating beside a separate shape — pins the fix
    // for the earlier version's mistake.
    expect(label.match(/first column/gi)).toHaveLength(2);
    // no other how-it-works step gets this treatment
    for (const item of items.slice(1)) {
      expect(item.querySelector('.lp-step-visual')).toBeNull();
    }
  });
});

describe('Landing — the pinned CTA (decision 1: visible at every scroll position)', () => {
  it('the top bar CTA calls onOpenApp', () => {
    const { onOpenApp } = renderLanding();
    const ctas = screen.getAllByRole('button', { name: /open the app/i });
    ctas[0].click(); // the top-bar instance is the first in document order
    expect(onOpenApp).toHaveBeenCalledTimes(1);
  });

  it('offers the CTA at least three times — top bar, hero, and close', () => {
    renderLanding();
    expect(screen.getAllByRole('button', { name: /open the app/i }).length).toBeGreaterThanOrEqual(3);
  });

  it('every CTA instance calls the same handler', () => {
    const { onOpenApp } = renderLanding();
    for (const button of screen.getAllByRole('button', { name: /open the app/i })) {
      button.click();
    }
    expect(onOpenApp).toHaveBeenCalledTimes(screen.getAllByRole('button', { name: /open the app/i }).length);
  });
});

describe('Landing — sharing via QR code', () => {
  it('shows a QR code that links to the deployed app', () => {
    renderLanding();
    const qr = screen.getByRole('img', { name: /qr code linking to https/i });
    expect(qr).toBeInTheDocument();
  });

  it('also shows the same link as plain, readable text', () => {
    renderLanding();
    const qr = screen.getByRole('img', { name: /qr code linking to (https\S+)/i });
    const url = qr.getAttribute('aria-label')!.replace(/^QR code linking to /, '');
    const link = screen.getByRole('link', { name: url.replace(/^https?:\/\//, '') });
    expect(link).toHaveAttribute('href', url);
  });
});

// plan.md §19 section 4 — every claim here is an invariant enforced
// elsewhere in the codebase (backend/app/marks.py's legal-value
// rejection, app/detection.py's column_count_mismatch, examSheet.ts's
// blank-never-0 rule), not marketing language invented for this page.
describe('Landing — factual claims (plan.md §19 §4/§5, must stay true)', () => {
  it('claims an uncertain digit is flagged, never guessed', () => {
    renderLanding();
    expect(screen.getByText(/never filled in with a confident guess/i)).toBeInTheDocument();
  });

  it('claims a column mismatch fails the scan rather than misplacing a mark', () => {
    renderLanding();
    expect(screen.getByText(/never writes one question’s mark into another’s column/i)).toBeInTheDocument();
  });

  it('claims a blank never exports as a zero', () => {
    renderLanding();
    expect(screen.getByText(/a blank never exports as a zero/i)).toBeInTheDocument();
  });

  it('claims the photograph is never stored', () => {
    renderLanding();
    expect(screen.getByText(/never stored/i)).toBeInTheDocument();
  });

  it('claims nothing leaves the laptop on the default recognizer, no third party sees a script', () => {
    renderLanding();
    expect(screen.getByText(/nothing leaves that laptop at all/i)).toBeInTheDocument();
    expect(screen.getByText(/no third party ever sees a script/i)).toBeInTheDocument();
  });

  it('claims no account and no server-side database', () => {
    renderLanding();
    expect(screen.getByText(/no account, no sign-up, no server-side database/i)).toBeInTheDocument();
  });
});
