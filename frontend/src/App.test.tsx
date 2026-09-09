// Step.md 13.18 — App.tsx is otherwise thin routing glue (untested
// directly elsewhere in this project, on purpose: Library/SectionForm/
// Scan/Review/Results each cover their own screen's real logic). This one
// piece of glue is real logic worth its own test: deciding whether
// creating a section introduced a genuinely NEW semester, which is what
// triggers Library's purge offer. Library.test.tsx already covers what
// happens once that offer is shown (passed directly as a prop there);
// this covers the decision that produces it in the first place.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import { saveSection } from './db';
import type { Section } from './types';

beforeEach(() => {
  indexedDB = new IDBFactory();
});

function makeSection(overrides: Partial<Section> = {}): Section {
  return {
    id: crypto.randomUUID(),
    courseCode: 'CSE203',
    label: '1',
    semester: 'Autumn 2026',
    idDigits: 7,
    ...overrides,
  };
}

async function fillAndSubmitNewSection(courseCode: string, label: string, semester: string) {
  // The empty-state Library renders a SECOND "+ New section" button
  // (the header's own one, plus the empty-state's call to action) — take
  // whichever comes first rather than assuming there's exactly one.
  const newSectionButtons = await screen.findAllByRole('button', { name: /\+ new section/i });
  fireEvent.click(newSectionButtons[0]);
  fireEvent.change(await screen.findByLabelText(/course code/i), { target: { value: courseCode } });
  fireEvent.change(screen.getByLabelText(/^section$/i), { target: { value: label } });
  setSemesterPicker(semester);
  await waitFor(() => expect(screen.getByRole('button', { name: /create section/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /create section/i }));
}

// The semester field is a Season/Year picker, not free text (step.md
// 13.20) — every call site here still passes a plain "Season YYYY"
// string, the same one that ends up stored, so the tests below didn't
// need to change shape, just how they drive the picker.
function setSemesterPicker(semester: string) {
  const [season, year] = semester.split(' ');
  fireEvent.click(screen.getByRole('button', { name: season }));
  fireEvent.change(screen.getByLabelText(/semester year/i), { target: { value: year } });
}

describe('App — the semester-purge offer only fires on a genuinely new semester (step.md 13.18)', () => {
  it('does not offer a purge for the very first section ever created', async () => {
    render(<App />);
    await fillAndSubmitNewSection('CSE100', '1', 'Autumn 2026');

    await screen.findByText('CSE100');
    expect(screen.queryByText(/new semester/i)).not.toBeInTheDocument();
  });

  it('does not offer a purge for a second section in the SAME semester', async () => {
    await saveSection(makeSection({ courseCode: 'CSE100', semester: 'Autumn 2026' }));
    render(<App />);
    await fillAndSubmitNewSection('CSE203', '2', 'Autumn 2026');

    await screen.findByText('CSE203-2');
    expect(screen.queryByText(/new semester/i)).not.toBeInTheDocument();
  });

  it('offers a purge when a section is created in a genuinely NEW semester', async () => {
    await saveSection(makeSection({ courseCode: 'CSE100', semester: 'Autumn 2026' }));
    render(<App />);
    await fillAndSubmitNewSection('CSE203', '1', 'Spring 2027');

    expect(await screen.findByText(/new semester/i)).toBeInTheDocument();
    expect(screen.getByText('Autumn 2026', { selector: 'strong' })).toBeInTheDocument();
  });

  it('the offer does not resurface on a later, unrelated visit to the library', async () => {
    await saveSection(makeSection({ courseCode: 'CSE100', semester: 'Autumn 2026' }));
    render(<App />);
    await fillAndSubmitNewSection('CSE203', '1', 'Spring 2027');
    await screen.findByText(/new semester/i);

    // Dismiss it, then leave and come back to the library via a normal
    // navigation (Edit -> Cancel) that has nothing to do with the offer.
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await screen.findByText('CSE100');
    expect(screen.queryByText(/new semester/i)).not.toBeInTheDocument();
  });

  it('editing an existing section into a "new" semester does not offer a purge', async () => {
    const section = makeSection({ courseCode: 'CSE100', semester: 'Autumn 2026' });
    await saveSection(section);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByLabelText(/semester year/i);
    setSemesterPicker('Spring 2027');
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText('CSE100');
    expect(screen.queryByText(/new semester/i)).not.toBeInTheDocument();
  });
});
