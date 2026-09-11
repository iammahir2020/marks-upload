// step.md 13.4 — the new entry point: semester -> course -> sections ->
// assessments. Also carries what used to live at the bottom of Setup.tsx:
// the data-collection disclosure (step 11.5) and "Reset everything" —
// both ported here since Setup.tsx is retired (step.md 13.7).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllAssessments, getAllSections, getRecordsByAssessment, saveAssessment, saveRecord, saveSection } from './db';
import Library from './Library';
import type { Assessment, Section, StudentRecord } from './types';

function makeSection(overrides: Partial<Section> = {}): Section {
  return {
    id: crypto.randomUUID(),
    courseCode: 'CSE203',
    label: '1',
    semester: 'Fall 2026',
    idDigits: 7,
    ...overrides,
  };
}

function makeAssessment(sectionId: string, overrides: Partial<Assessment> = {}): Assessment {
  return {
    id: crypto.randomUUID(),
    sectionId,
    quizName: 'Quiz 1',
    questions: [{ q: 1, max: 5 }],
    totalMax: 5,
    createdAt: new Date().toISOString(),
    exportedAt: null,
    ...overrides,
  };
}

function makeRecord(assessmentId: string, overrides: Partial<StudentRecord> = {}): StudentRecord {
  return {
    id: crypto.randomUUID(),
    assessmentId,
    studentId: '2632711',
    serial: '7',
    questions: [{ q: 1, value: 5 }],
    total: 5,
    confirmed: true,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderLibrary(overrides: { pendingSemesterOffer?: string | null } = {}) {
  const props = {
    pendingSemesterOffer: overrides.pendingSemesterOffer ?? null,
    onShowLanding: vi.fn(),
    onNewSection: vi.fn(),
    onEditSection: vi.fn(),
    onNewAssessment: vi.fn(),
    onOpenAssessment: vi.fn(),
  };
  return { ...props, ...render(<Library {...props} />) };
}

// Both delete flows (13.23 section, 13.24 assessment) gate their "Yes,
// delete" button behind typing the exact name back — this fills that
// field the same way a real instructor would, via its placeholder (the
// same text shown in the field's own label).
function typeToConfirm(expected: string) {
  fireEvent.change(screen.getByPlaceholderText(expected), { target: { value: expected } });
}

beforeEach(() => {
  indexedDB = new IDBFactory();
});

describe('Library — the real semester from the design discussion', () => {
  it('groups CSE100, CSE200 and two CSE203 sections under one semester', async () => {
    const cse100 = makeSection({ courseCode: 'CSE100', label: '1' });
    const cse200 = makeSection({ courseCode: 'CSE200', label: '1' });
    const cse203a = makeSection({ courseCode: 'CSE203', label: '1' });
    const cse203b = makeSection({ courseCode: 'CSE203', label: '2' });
    await Promise.all([cse100, cse200, cse203a, cse203b].map(saveSection));

    renderLibrary();

    expect(await screen.findByText('Fall 2026')).toBeInTheDocument();
    expect(screen.getByText('CSE100')).toBeInTheDocument();
    expect(screen.getByText('CSE200')).toBeInTheDocument();
    expect(screen.getByText('CSE203-1')).toBeInTheDocument();
    expect(screen.getByText('CSE203-2')).toBeInTheDocument();
  });

  it('shows an assessment’s scanned count and export state', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id, { quizName: 'Quiz 1' });
    const exported = makeAssessment(section.id, { quizName: 'Quiz 2', exportedAt: new Date().toISOString() });
    await saveSection(section);
    await saveAssessment(assessment);
    await saveAssessment(exported);
    await saveRecord(makeRecord(assessment.id));
    await saveRecord(makeRecord(assessment.id, { studentId: '2632700', serial: '8' }));

    renderLibrary();

    expect(await screen.findByText('Quiz 1')).toBeInTheDocument();
    expect(screen.getByText('2 scanned')).toBeInTheDocument();
    expect(screen.getByText('Not exported')).toBeInTheDocument();
    expect(screen.getByText('Quiz 2')).toBeInTheDocument();
    expect(screen.getByText('Exported')).toBeInTheDocument();
  });

  it('shows an empty state when there are no sections yet', async () => {
    renderLibrary();
    expect(await screen.findByText(/no sections yet/i)).toBeInTheDocument();
  });

  // A brand-new assessment (no records at all yet) opens with no
  // confirmation — needsResumeConfirmation(null) is false by design, and
  // this is the common case that must not cost an extra tap.
  it('tapping an assessment resumes it with both its section and itself', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id, { quizName: 'Quiz 1' });
    await saveSection(section);
    await saveAssessment(assessment);

    const { onOpenAssessment } = renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Quiz 1' }));

    expect(onOpenAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ id: section.id }),
      expect.objectContaining({ id: assessment.id }),
    );
  });

  // Step.md 13.14 — the phase this belongs to.
  describe('resume confirmation (step.md 13.14)', () => {
    it('does not confirm an assessment last scanned earlier today', async () => {
      const section = makeSection();
      const assessment = makeAssessment(section.id, { quizName: 'Quiz 1' });
      await saveSection(section);
      await saveAssessment(assessment);
      await saveRecord(makeRecord(assessment.id, { capturedAt: new Date().toISOString() }));

      const { onOpenAssessment } = renderLibrary();
      fireEvent.click(await screen.findByRole('button', { name: 'Quiz 1' }));

      expect(onOpenAssessment).toHaveBeenCalled();
      expect(screen.queryByText(/last scanned/i)).not.toBeInTheDocument();
    });

    it('asks before resuming an assessment last scanned days ago', async () => {
      const section = makeSection();
      const assessment = makeAssessment(section.id, { quizName: 'Quiz 1' });
      const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      await saveSection(section);
      await saveAssessment(assessment);
      await saveRecord(makeRecord(assessment.id, { capturedAt: oldDate }));

      const { onOpenAssessment } = renderLibrary();
      fireEvent.click(await screen.findByRole('button', { name: 'Quiz 1' }));

      expect(await screen.findByText(/last scanned/i)).toBeInTheDocument();
      // Not opened yet — waiting on the instructor's own confirmation.
      expect(onOpenAssessment).not.toHaveBeenCalled();
    });

    it('Resume opens the assessment and clears the prompt', async () => {
      const section = makeSection();
      const assessment = makeAssessment(section.id, { quizName: 'Quiz 1' });
      const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      await saveSection(section);
      await saveAssessment(assessment);
      await saveRecord(makeRecord(assessment.id, { capturedAt: oldDate }));

      const { onOpenAssessment } = renderLibrary();
      fireEvent.click(await screen.findByRole('button', { name: 'Quiz 1' }));
      await screen.findByText(/last scanned/i);

      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

      expect(onOpenAssessment).toHaveBeenCalledWith(
        expect.objectContaining({ id: section.id }),
        expect.objectContaining({ id: assessment.id }),
      );
      expect(screen.queryByText(/last scanned/i)).not.toBeInTheDocument();
    });

    it('Cancel leaves the library exactly as it was', async () => {
      const section = makeSection();
      const assessment = makeAssessment(section.id, { quizName: 'Quiz 1' });
      const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      await saveSection(section);
      await saveAssessment(assessment);
      await saveRecord(makeRecord(assessment.id, { capturedAt: oldDate }));

      const { onOpenAssessment } = renderLibrary();
      fireEvent.click(await screen.findByRole('button', { name: 'Quiz 1' }));
      await screen.findByText(/last scanned/i);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onOpenAssessment).not.toHaveBeenCalled();
      expect(screen.queryByText(/last scanned/i)).not.toBeInTheDocument();
      // Still on the library, still showing the assessment row.
      expect(screen.getByRole('button', { name: 'Quiz 1' })).toBeInTheDocument();
    });
  });

  it('"+ New assessment" on a section passes that section through', async () => {
    const section = makeSection();
    await saveSection(section);

    const { onNewAssessment } = renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: /\+ new assessment/i }));

    expect(onNewAssessment).toHaveBeenCalledWith(expect.objectContaining({ id: section.id }));
  });
});

describe('Library — data-collection disclosure', () => {
  it('tells a first-time user that cells are kept for training', async () => {
    renderLibrary();
    await waitFor(() => {
      expect(screen.getAllByText(/train and tune/i)).toHaveLength(2);
    });
    expect(screen.getAllByText(/never stored/i).length).toBeGreaterThan(0);
  });

  it('still shows the summary line once sections exist', async () => {
    // With sections the "How this works" section renders collapsed, so
    // anything only inside it is effectively invisible to a returning
    // instructor — which is precisely the person whose students'
    // handwriting is being collected.
    await saveSection(makeSection());
    renderLibrary();

    const note = await screen.findByText(/used to train and tune handwriting recognition/i);
    expect(note).toBeInTheDocument();
    expect(note.closest('details')).toBeNull();
  });

  it('discloses that an attached class list keeps names on the device, to a returning user too', async () => {
    await saveSection(makeSection());
    renderLibrary();

    const note = await screen.findByText(/class-list workbook attached to a section keeps the names/i);
    expect(note).toBeInTheDocument();
    expect(note.closest('details')).toBeNull();
    expect(screen.getAllByText(/never sent anywhere/i).length).toBeGreaterThan(0);
  });

  // Step.md 14.4/14.9 — the landing page's "way back". App.test.tsx
  // covers the full round trip through App's own routing; this covers
  // Library's own half of the contract in isolation: the link is offered
  // and calls through when the caller provides it, Library never assumes
  // it will be provided at all, and — 14.9's own fix — it stays visible
  // once sections exist rather than living inside the "How this works"
  // disclosure, which collapses itself the moment `sections.length > 0`.
  it('"About" calls onShowLanding when provided', async () => {
    const { onShowLanding } = renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: /^about$/i }));
    expect(onShowLanding).toHaveBeenCalledTimes(1);
  });

  it('stays visible once a section exists, unlike the collapsible disclosure below it', async () => {
    await saveSection(makeSection());
    renderLibrary();
    await screen.findByText('CSE203-1');
    expect(screen.getByRole('button', { name: /^about$/i })).toBeInTheDocument();
  });

  it('offers no way back at all when onShowLanding is not provided', async () => {
    render(
      <Library
        onNewSection={vi.fn()}
        onEditSection={vi.fn()}
        onNewAssessment={vi.fn()}
        onOpenAssessment={vi.fn()}
      />,
    );
    await screen.findByText(/no sections yet/i);
    expect(screen.queryByRole('button', { name: /^about$/i })).not.toBeInTheDocument();
  });
});

describe('Library — Reset everything', () => {
  it('does nothing until the destructive action is confirmed', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id);
    await saveSection(section);
    await saveAssessment(assessment);
    await saveRecord(makeRecord(assessment.id));
    renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset everything' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await getAllSections()).toHaveLength(1);
  });

  it('clears every section, assessment and record', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id);
    await saveSection(section);
    await saveAssessment(assessment);
    await saveRecord(makeRecord(assessment.id));
    renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset everything' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, delete everything' }));

    await waitFor(async () => expect(await getAllSections()).toHaveLength(0));
    expect(await getAllAssessments()).toHaveLength(0);
    // The library returns to its empty state.
    await waitFor(() => expect(screen.getByText(/no sections yet/i)).toBeInTheDocument());
  });

  it('offers no reset button at all when nothing has been scanned yet', async () => {
    await saveSection(makeSection()); // a section with no records
    renderLibrary();
    await screen.findByText(/no quizzes yet/i);
    expect(screen.queryByRole('button', { name: 'Reset everything' })).not.toBeInTheDocument();
  });
});

// Step.md 13.18/13.19 — the real scoped semester purge, offered exactly
// once, right after creating a section in a genuinely new semester.
describe('Library — semester purge (step.md 13.18/13.19)', () => {
  it('shows no offer when pendingSemesterOffer is not set (the common case)', async () => {
    const oldSection = makeSection({ semester: 'Fall 2026' });
    await saveSection(oldSection);
    renderLibrary();
    await screen.findByText('Fall 2026');
    expect(screen.queryByText(/new semester/i)).not.toBeInTheDocument();
  });

  it('shows no offer when the new semester is the only one that exists', async () => {
    const section = makeSection({ semester: 'Spring 2027' });
    await saveSection(section);
    renderLibrary({ pendingSemesterOffer: 'Spring 2027' });
    await screen.findByText('Spring 2027');
    expect(screen.queryByText(/new semester/i)).not.toBeInTheDocument();
  });

  it('offers to purge an older semester, with real counts', async () => {
    const oldSection = makeSection({ semester: 'Fall 2026', courseCode: 'CSE203', label: '1' });
    const newSection = makeSection({ semester: 'Spring 2027', courseCode: 'CSE100', label: '1' });
    const assessment = makeAssessment(oldSection.id, { exportedAt: new Date().toISOString() });
    await saveSection(oldSection);
    await saveSection(newSection);
    await saveAssessment(assessment);
    await saveRecord(makeRecord(assessment.id));
    await saveRecord(makeRecord(assessment.id, { studentId: '2632700' }));

    renderLibrary({ pendingSemesterOffer: 'Spring 2027' });

    expect(await screen.findByText(/new semester/i)).toBeInTheDocument();
    expect(screen.getByText('Fall 2026', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/1 section, 1 quiz, 2 records/)).toBeInTheDocument();
  });

  it('blocks the purge on an unexported assessment that holds real records, naming it, Cancel only', async () => {
    const oldSection = makeSection({ semester: 'Fall 2026', courseCode: 'CSE203', label: '1' });
    const newSection = makeSection({ semester: 'Spring 2027' });
    const unexported = makeAssessment(oldSection.id, { quizName: 'Quiz 2', exportedAt: null });
    await saveSection(oldSection);
    await saveSection(newSection);
    await saveAssessment(unexported);
    await saveRecord(makeRecord(unexported.id));

    renderLibrary({ pendingSemesterOffer: 'Spring 2027' });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));

    expect(await screen.findByText(/can't purge/i)).toBeInTheDocument();
    expect(screen.getByText(/CSE203-1 · Quiz 2/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /yes, delete/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Nothing was deleted.
    expect(await getAllSections()).toHaveLength(2);
    expect(await getAllAssessments()).toHaveLength(1);
  });

  it('deletes the whole semester — sections, assessments, and records — once confirmed', async () => {
    const oldSection = makeSection({ semester: 'Fall 2026' });
    const newSection = makeSection({ semester: 'Spring 2027', courseCode: 'CSE100' });
    const exported = makeAssessment(oldSection.id, { exportedAt: new Date().toISOString() });
    await saveSection(oldSection);
    await saveSection(newSection);
    await saveAssessment(exported);
    await saveRecord(makeRecord(exported.id));

    renderLibrary({ pendingSemesterOffer: 'Spring 2027' });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: /yes, delete fall 2026/i }));

    await waitFor(async () => expect(await getAllSections()).toHaveLength(1));
    expect((await getAllSections())[0].semester).toBe('Spring 2027'); // the new one survives
    expect(await getAllAssessments()).toHaveLength(0);
    expect(await getRecordsByAssessment(exported.id)).toHaveLength(0);
    expect(screen.queryByText(/new semester/i)).not.toBeInTheDocument(); // offer clears itself
  });

  it('Cancel from the confirm view returns to the list without deleting anything', async () => {
    const oldSection = makeSection({ semester: 'Fall 2026' });
    const newSection = makeSection({ semester: 'Spring 2027' });
    const exported = makeAssessment(oldSection.id, { exportedAt: new Date().toISOString() });
    await saveSection(oldSection);
    await saveSection(newSection);
    await saveAssessment(exported);

    renderLibrary({ pendingSemesterOffer: 'Spring 2027' });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByText(/there's no undo/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Back to the summary list — the offer is still there, nothing deleted.
    expect(await screen.findByText('Fall 2026', { selector: 'strong' })).toBeInTheDocument();
    expect(await getAllSections()).toHaveLength(2);
  });

  it('"Not now" dismisses the offer without deleting anything', async () => {
    const oldSection = makeSection({ semester: 'Fall 2026' });
    const newSection = makeSection({ semester: 'Spring 2027' });
    await saveSection(oldSection);
    await saveSection(newSection);

    renderLibrary({ pendingSemesterOffer: 'Spring 2027' });
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));

    expect(screen.queryByText(/new semester/i)).not.toBeInTheDocument();
    expect(await getAllSections()).toHaveLength(2); // still there, just not offered
  });

  it('treats differently-cased semester labels as separate purge candidates', async () => {
    const section1 = makeSection({ semester: 'Fall 2026', courseCode: 'CSE100' });
    const section2 = makeSection({ semester: 'fall 2026', courseCode: 'CSE203' }); // a typo'd variant
    const newSection = makeSection({ semester: 'Spring 2027', courseCode: 'CSE200' });
    await saveSection(section1);
    await saveSection(section2);
    await saveSection(newSection);

    renderLibrary({ pendingSemesterOffer: 'Spring 2027' });

    await screen.findByText(/new semester/i);
    expect(screen.getByText('Fall 2026', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('fall 2026', { selector: 'strong' })).toBeInTheDocument();
  });
});

describe('Library — delete a single section (13.23)', () => {
  it('the confirm button stays disabled until the section name is typed exactly', async () => {
    const section = makeSection({ courseCode: 'CSE100', label: '1' });
    await saveSection(section);

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete section' }));
    await screen.findByText(/there's no undo/i);

    const confirmButton = screen.getByRole('button', { name: /yes, delete cse100-1/i });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('CSE100-1'), { target: { value: 'CSE100' } }); // close, not exact
    expect(confirmButton).toBeDisabled();

    typeToConfirm('CSE100-1');
    expect(confirmButton).toBeEnabled();
  });

  it('deletes an empty section once its name is typed and confirmed', async () => {
    const section = makeSection({ courseCode: 'CSE100', label: '1' });
    await saveSection(section);

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete section' }));
    await screen.findByText(/there's no undo/i);

    typeToConfirm('CSE100-1');
    fireEvent.click(screen.getByRole('button', { name: /yes, delete cse100-1/i }));

    await waitFor(async () => expect(await getAllSections()).toHaveLength(0));
  });

  it('does nothing until the destructive action is confirmed', async () => {
    const section = makeSection();
    await saveSection(section);

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete section' }));
    await screen.findByText(/there's no undo/i);

    expect(await getAllSections()).toHaveLength(1); // not deleted just from opening the confirm
  });

  it('Cancel leaves the section untouched', async () => {
    const section = makeSection();
    await saveSection(section);

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete section' }));
    await screen.findByText(/there's no undo/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText(/there's no undo/i)).not.toBeInTheDocument();
    expect(await getAllSections()).toHaveLength(1);
  });

  it('cascades to every assessment and record under the section', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id, { exportedAt: new Date().toISOString() });
    await saveSection(section);
    await saveAssessment(assessment);
    await saveRecord(makeRecord(assessment.id));
    await saveRecord(makeRecord(assessment.id, { studentId: '2632700' }));

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete section' }));
    await screen.findByText(/there's no undo/i);
    typeToConfirm(`${section.courseCode}-${section.label}`);
    fireEvent.click(screen.getByRole('button', { name: /yes, delete/i }));

    await waitFor(async () => expect(await getAllSections()).toHaveLength(0));
    expect(await getAllAssessments()).toHaveLength(0);
    expect(await getRecordsByAssessment(assessment.id)).toHaveLength(0);
  });

  it('leaves a sibling section untouched', async () => {
    const toDelete = makeSection({ courseCode: 'CSE203', label: '1' });
    const sibling = makeSection({ courseCode: 'CSE203', label: '2' });
    await saveSection(toDelete);
    await saveSection(sibling);

    renderLibrary();
    const deleteButtons = await screen.findAllByRole('button', { name: 'Delete section' });
    fireEvent.click(deleteButtons[0]);
    await screen.findByText(/there's no undo/i);
    typeToConfirm('CSE203-1');
    fireEvent.click(screen.getByRole('button', { name: /yes, delete cse203-1/i }));

    await waitFor(async () => expect(await getAllSections()).toHaveLength(1));
    expect((await getAllSections())[0].id).toBe(sibling.id);
  });

  it('blocks the delete on an unexported assessment that holds real records, naming it, Cancel only', async () => {
    const section = makeSection();
    const unexported = makeAssessment(section.id, { quizName: 'Quiz 2', exportedAt: null });
    await saveSection(section);
    await saveAssessment(unexported);
    await saveRecord(makeRecord(unexported.id));

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete section' }));

    expect(await screen.findByText(/can't delete/i)).toBeInTheDocument();
    // "Quiz 2" appears twice — once as the section's own scan-queue row,
    // once (what this test is actually checking) named in the block list.
    expect(screen.getAllByText('Quiz 2').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button', { name: /yes, delete/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Nothing was deleted.
    expect(await getAllSections()).toHaveLength(1);
    expect(await getAllAssessments()).toHaveLength(1);
  });

  it('does not block deleting a section whose only assessment is empty and unexported', async () => {
    // A freshly-created, wrongly-added assessment is ALSO never exported
    // — the guard only fires when real records would actually be lost.
    const section = makeSection();
    const emptyUnexported = makeAssessment(section.id, { exportedAt: null });
    await saveSection(section);
    await saveAssessment(emptyUnexported);

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete section' }));

    expect(screen.queryByText(/can't delete/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/there's no undo/i)).toBeInTheDocument();
  });
});

describe('Library — delete a single assessment (13.24)', () => {
  it('deletes an empty assessment once its name is typed and confirmed', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id, { quizName: 'Quiz 1' });
    await saveSection(section);
    await saveAssessment(assessment);

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete quiz' }));
    await screen.findByText(/there's no undo/i);

    const confirmButton = screen.getByRole('button', { name: /yes, delete quiz 1/i });
    expect(confirmButton).toBeDisabled();
    typeToConfirm('Quiz 1');
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(async () => expect(await getAllAssessments()).toHaveLength(0));
  });

  it('does nothing until the destructive action is confirmed', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id);
    await saveSection(section);
    await saveAssessment(assessment);

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete quiz' }));
    await screen.findByText(/there's no undo/i);

    expect(await getAllAssessments()).toHaveLength(1);
  });

  it('Cancel leaves the assessment untouched', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id, { quizName: 'Quiz 1' });
    await saveSection(section);
    await saveAssessment(assessment);

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete quiz' }));
    await screen.findByText(/there's no undo/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText(/there's no undo/i)).not.toBeInTheDocument();
    expect(await getAllAssessments()).toHaveLength(1);
  });

  it('cascades to every record under the assessment, leaving the section itself untouched', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id, { quizName: 'Quiz 1', exportedAt: new Date().toISOString() });
    await saveSection(section);
    await saveAssessment(assessment);
    await saveRecord(makeRecord(assessment.id));
    await saveRecord(makeRecord(assessment.id, { studentId: '2632700' }));

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete quiz' }));
    await screen.findByText(/there's no undo/i);
    typeToConfirm('Quiz 1');
    fireEvent.click(screen.getByRole('button', { name: /yes, delete quiz 1/i }));

    await waitFor(async () => expect(await getAllAssessments()).toHaveLength(0));
    expect(await getRecordsByAssessment(assessment.id)).toHaveLength(0);
    expect(await getAllSections()).toHaveLength(1); // the section survives
  });

  it('leaves a sibling assessment in the same section untouched', async () => {
    const section = makeSection();
    const toDelete = makeAssessment(section.id, { quizName: 'Quiz 1' });
    const sibling = makeAssessment(section.id, { quizName: 'Quiz 2' });
    await saveSection(section);
    await saveAssessment(toDelete);
    await saveAssessment(sibling);

    renderLibrary();
    // assessmentsForSection sorts newest-first, so which row renders
    // where isn't something this test should assume — find Quiz 1's own
    // row and delete from inside it, regardless of position.
    const quiz1Row = (await screen.findByRole('button', { name: 'Quiz 1' })).closest('li')!;
    fireEvent.click(within(quiz1Row).getByRole('button', { name: 'Delete quiz' }));
    await screen.findByText(/there's no undo/i);
    typeToConfirm('Quiz 1');
    fireEvent.click(screen.getByRole('button', { name: /yes, delete quiz 1/i }));

    await waitFor(async () => expect(await getAllAssessments()).toHaveLength(1));
    expect((await getAllAssessments())[0].id).toBe(sibling.id);
  });

  it('blocks deleting an unexported assessment that holds real records', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id, { quizName: 'Quiz 1', exportedAt: null });
    await saveSection(section);
    await saveAssessment(assessment);
    await saveRecord(makeRecord(assessment.id));
    await saveRecord(makeRecord(assessment.id, { studentId: '2632700' }));

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete quiz' }));

    expect(await screen.findByText(/can't delete/i)).toBeInTheDocument();
    expect(screen.getByText(/2 records would be lost/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /yes, delete/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await getAllAssessments()).toHaveLength(1);
    expect(await getRecordsByAssessment(assessment.id)).toHaveLength(2);
  });

  it('does not block deleting a brand-new, empty, never-exported assessment', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id, { exportedAt: null });
    await saveSection(section);
    await saveAssessment(assessment);

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete quiz' }));

    expect(screen.queryByText(/can't delete/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/there's no undo/i)).toBeInTheDocument();
  });

  it('does not block deleting an EXPORTED assessment, even with real records', async () => {
    // Confirms the block guard's own boundary: it only ever fires on
    // real, UNEXPORTED work — once exported, the records are recoverable
    // from that export, so deleting the assessment costs nothing new.
    const section = makeSection();
    const assessment = makeAssessment(section.id, { quizName: 'Quiz 1', exportedAt: new Date().toISOString() });
    await saveSection(section);
    await saveAssessment(assessment);
    await saveRecord(makeRecord(assessment.id));

    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete quiz' }));

    expect(screen.queryByText(/can't delete/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/there's no undo/i)).toBeInTheDocument();
  });
});
