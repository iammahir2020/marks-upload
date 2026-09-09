// Create an Assessment (step.md step 13.6, plan.md §18) — one quiz's name,
// question count and per-question maxes. This is Setup.tsx's old form
// minus the ID-digits field (inherited from the Section, never asked
// twice) and minus the workbook mode (that lives on the Section now, step
// 13.9) — reuses validateConfig.ts unchanged rather than writing a second
// validator, the same bounds pair CLAUDE.md pins against the backend.
import { useState } from 'react';
import type { Section } from './types';
import { MAX_QUESTIONS, validateConfig } from './validateConfig';

// Same NumField pattern as SectionForm/the old Setup.tsx — see either
// file's own comment on why Number('') can't be the coercion for a
// cleared box (issues.md, the cleared-number-field fix).
type NumField = number | '';
function toNumField(raw: string): NumField {
  return raw === '' ? '' : Number(raw);
}
function asNumber(value: NumField): number {
  return value === '' ? NaN : value;
}

export interface NewAssessmentInput {
  quizName: string;
  questions: { q: number; max: number }[];
  totalMax: number;
}

interface AssessmentFormProps {
  section: Section;
  onSave: (input: NewAssessmentInput) => void;
  onCancel: () => void;
}

export default function AssessmentForm({ section, onSave, onCancel }: AssessmentFormProps) {
  const [quizName, setQuizName] = useState('');
  const [questionCount, setQuestionCount] = useState<NumField>(5);
  const [questionMaxes, setQuestionMaxes] = useState<NumField[]>([5, 5, 5, 5, 5]);
  const [errors, setErrors] = useState<string[]>([]);

  function handleQuestionCountChange(next: NumField) {
    // Same guard as the old Setup.tsx (issues.md #1) — the array resize
    // below is what can't survive a bad number; the typed value itself is
    // always kept so validateConfig gets to report a real error on submit.
    setQuestionCount(next);
    if (next === '' || !Number.isInteger(next) || next < 1 || next > MAX_QUESTIONS) return;
    setQuestionMaxes((prev) => {
      const copy = [...prev];
      while (copy.length < next) copy.push(5);
      copy.length = next;
      return copy;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // idDigits comes from the section, never from this form — still run
    // through the same validator so a section with a genuinely bad digit
    // count (shouldn't happen, but nothing else re-checks it here) fails
    // loudly rather than producing a silently-broken Assessment.
    const result = validateConfig({
      quizName,
      idDigits: section.idDigits,
      questionCount: asNumber(questionCount),
      questionMaxes: questionMaxes.map(asNumber),
    });
    if (!result.valid || !result.config) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    onSave({
      quizName: result.config.quizName,
      questions: result.config.questions,
      totalMax: result.config.totalMax,
    });
  }

  return (
    <div className="page">
      <div className="app-header">
        <div>
          <span className="eyebrow">{section.courseCode}-{section.label}</span>
          <h1>New assessment</h1>
        </div>
      </div>

      <form className="card stack" onSubmit={handleSubmit}>
        <div className="field">
          <label className="field-label" htmlFor="quizName">
            Quiz name
          </label>
          <input
            id="quizName"
            className="input"
            value={quizName}
            onChange={(e) => setQuizName(e.target.value)}
            placeholder="e.g. Quiz 1…"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="questionCount">
            Number of questions
          </label>
          <input
            id="questionCount"
            className="input"
            type="number"
            inputMode="numeric"
            value={questionCount}
            onChange={(e) => handleQuestionCountChange(toNumField(e.target.value))}
          />
        </div>

        <div className="field">
          <span className="field-label">Max mark per question</span>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {questionMaxes.map((max, i) => (
              <label key={i} className="field" style={{ width: '4.5rem', gap: '4px' }}>
                <span className="field-hint">Q{i + 1}</span>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  value={max}
                  onChange={(e) => {
                    const next = [...questionMaxes];
                    next[i] = toNumField(e.target.value);
                    setQuestionMaxes(next);
                  }}
                  style={{ padding: '10px 8px', textAlign: 'center' }}
                />
              </label>
            ))}
          </div>
          <span className="field-hint">These must match the table pasted in your question paper.</span>
        </div>

        {errors.length > 0 && (
          <div className="banner banner-danger">
            {errors.map((err) => (
              <span key={err}>{err}</span>
            ))}
          </div>
        )}

        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary flex-1">
            Start scanning &rarr;
          </button>
        </div>
      </form>
    </div>
  );
}
