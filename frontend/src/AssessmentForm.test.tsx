// step.md 13.6 — quiz name, question count, per-question maxes. idDigits
// is inherited from the section and never asked here; validateConfig.ts's
// own suite covers the validation rules themselves, so this exercises the
// component wiring: the array-resize guard, the cleared-number-field fix
// (issues.md, 2026-09-08), and what gets handed to onSave.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AssessmentForm from './AssessmentForm';
import type { Section } from './types';

const section: Section = {
  id: 'sec-1',
  courseCode: 'CSE203',
  label: '2',
  semester: 'Fall 2026',
  idDigits: 7,
};

describe('AssessmentForm — creating a quiz', () => {
  it('hands a complete Assessment shape to onSave, with idDigits nowhere in it', async () => {
    const onSave = vi.fn();
    render(<AssessmentForm section={section} onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/quiz name/i), { target: { value: 'Quiz 1' } });
    fireEvent.click(screen.getByRole('button', { name: /start scanning/i }));

    expect(onSave).toHaveBeenCalledWith({
      quizName: 'Quiz 1',
      questions: [
        { q: 1, max: 5 },
        { q: 2, max: 5 },
        { q: 3, max: 5 },
        { q: 4, max: 5 },
        { q: 5, max: 5 },
      ],
      totalMax: 25,
      // Step 16 — always written explicitly for a new quiz; on by default.
      hasSerial: true,
    });
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('idDigits');
  });

  it('refuses to save with no quiz name', () => {
    const onSave = vi.fn();
    render(<AssessmentForm section={section} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /start scanning/i }));

    expect(screen.getByText(/quiz name is required/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('resizes the max-mark row when the question count changes', () => {
    render(<AssessmentForm section={section} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/number of questions/i), { target: { value: '3' } });
    expect(screen.getByLabelText('Q3')).toBeInTheDocument();
    expect(screen.queryByLabelText('Q4')).not.toBeInTheDocument();
  });

  // issues.md #1 — a bad question count could crash this screen outright
  // before validateConfig ever ran. The typed value is kept (so the field
  // stays editable), but the array resize must survive it.
  it('does not crash on a question count outside the array-resize guard', () => {
    render(<AssessmentForm section={section} onSave={vi.fn()} onCancel={vi.fn()} />);
    const count = screen.getByLabelText(/number of questions/i) as HTMLInputElement;

    fireEvent.change(count, { target: { value: '5.5' } });
    expect(count.value).toBe('5.5');
    expect(screen.getByLabelText('Q5')).toBeInTheDocument(); // unchanged, not crashed

    fireEvent.change(count, { target: { value: '99999999999' } });
    expect(count.value).toBe('99999999999');
    expect(screen.getByLabelText('Q5')).toBeInTheDocument(); // still unchanged
  });

  it('calls onCancel without saving anything', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<AssessmentForm section={section} onSave={onSave} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

// A cleared number field must stay cleared. Number('') is 0, so coercing
// on every keystroke put a literal 0 back in the box the moment the
// instructor emptied it — and the next digit typed landed after that
// zero (issues.md, 2026-09-08). Ported here from the old Setup.tsx suite
// for the fields that now live on this form.
describe('AssessmentForm — clearing a number field', () => {
  it('leaves the box empty instead of writing a 0 back into it', () => {
    render(<AssessmentForm section={section} onSave={vi.fn()} onCancel={vi.fn()} />);

    const count = screen.getByLabelText(/number of questions/i) as HTMLInputElement;
    fireEvent.change(count, { target: { value: '' } });
    expect(count.value).toBe('');

    const q1 = screen.getByLabelText('Q1') as HTMLInputElement;
    fireEvent.change(q1, { target: { value: '' } });
    expect(q1.value).toBe('');
  });

  it('takes a fresh value typed into the emptied box', () => {
    render(<AssessmentForm section={section} onSave={vi.fn()} onCancel={vi.fn()} />);

    const count = screen.getByLabelText(/number of questions/i) as HTMLInputElement;
    fireEvent.change(count, { target: { value: '' } });
    fireEvent.change(count, { target: { value: '1' } });
    expect(count.value).toBe('1');
    fireEvent.change(count, { target: { value: '10' } });

    expect(count.value).toBe('10');
    expect(screen.getByLabelText('Q10')).toBeInTheDocument();
  });

  it('refuses to save with an empty question count', () => {
    const onSave = vi.fn();
    render(<AssessmentForm section={section} onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/quiz name/i), { target: { value: 'Quiz 1' } });
    fireEvent.change(screen.getByLabelText(/number of questions/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /start scanning/i }));

    expect(screen.getByText(/number of questions must be a whole number/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

// Step 16 (plan.md §21) — the "Serial box on paper" setting.
describe('AssessmentForm — Serial box on paper (step 16)', () => {
  it('is ticked by default and saved as true', () => {
    const onSave = vi.fn();
    render(<AssessmentForm section={section} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: /serial box on paper/i })).toBeChecked();
    fireEvent.change(screen.getByLabelText(/quiz name/i), { target: { value: 'Quiz 1' } });
    fireEvent.click(screen.getByRole('button', { name: /start scanning/i }));
    expect(onSave.mock.calls[0][0].hasSerial).toBe(true);
  });

  it('starts from the value it is given, and saves an unticked box as false', () => {
    const onSave = vi.fn();
    render(<AssessmentForm section={section} defaultHasSerial={false} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: /serial box on paper/i })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText(/quiz name/i), { target: { value: 'Quiz 2' } });
    fireEvent.click(screen.getByRole('button', { name: /start scanning/i }));
    expect(onSave.mock.calls[0][0].hasSerial).toBe(false);
  });

  it('warns, without blocking, when unticked on a section with no class list', () => {
    render(<AssessmentForm section={section} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText(/nothing can catch a misread/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /serial box on paper/i }));
    expect(screen.getByText(/nothing can catch a misread/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start scanning/i })).toBeEnabled();
  });

  it('does not warn when the section has a class list', () => {
    const withRoster: Section = {
      ...section,
      roster: { sheetName: 'data', headerRow: 1, students: [], duplicateIds: [] },
    };
    render(<AssessmentForm section={withRoster} defaultHasSerial={false} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText(/nothing can catch a misread/i)).not.toBeInTheDocument();
  });
});
