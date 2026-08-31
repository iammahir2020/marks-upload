// Setup screen (plan.md §11, step.md step 5.3): quiz name, ID digits,
// question count, per-question max. Persists QuizConfig on submit and
// reloads it on start (step 5.4).
import { useEffect, useState } from 'react';
import { getAllRecords, loadConfig, resetAll, saveConfig } from './db';
import type { QuizConfig } from './types';
import { validateConfig } from './validateConfig';

interface SetupProps {
  onStart: (config: QuizConfig) => void;
  // Jump straight to the results table for records saved earlier. Setup
  // owns the entry point because this is where someone lands after
  // closing the app mid-session — the records are the thing they will
  // worry about first, so they are surfaced before anything else.
  onViewResults: (config: QuizConfig) => void;
}

const HOW_IT_WORKS = [
  {
    title: 'Set up the quiz once',
    detail: 'Tell it how many digits the student ID has, how many questions, and each question’s max mark.',
  },
  {
    title: 'Photograph each script',
    detail: 'Frame the marks grid at the top of the script and capture — the camera stays ready for the next one immediately.',
  },
  {
    title: 'Confirm what it read',
    detail: 'Each capture opens for review automatically. Fix anything wrong or left blank, then confirm.',
  },
  {
    title: 'Export when the class is done',
    detail: 'Every confirmed script is saved on this device. Download the whole session as one Excel file whenever you’re ready.',
  },
];

export default function Setup({ onStart, onViewResults }: SetupProps) {
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<QuizConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const [quizName, setQuizName] = useState('');
  const [idDigits, setIdDigits] = useState(7);
  const [questionCount, setQuestionCount] = useState(5);
  const [questionMaxes, setQuestionMaxes] = useState<number[]>([5, 5, 5, 5, 5]);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    // Records and config are read together: a half-finished session is
    // both, and showing one without the other would be misleading.
    Promise.all([loadConfig(), getAllRecords()]).then(([config, records]) => {
      if (config) {
        setSaved(config);
        setQuizName(config.quizName);
        setIdDigits(config.idDigits);
        setQuestionCount(config.questions.length);
        setQuestionMaxes(config.questions.map((q) => q.max));
      }
      setSavedCount(records.length);
      setLoaded(true);
    });
  }, []);

  async function handleReset() {
    await resetAll();
    setConfirmingReset(false);
    setSavedCount(0);
    setSaved(null);
    setEditing(false);
    // Back to an empty form, not to a form still holding the old quiz's
    // values — "start fresh" has to mean it.
    setQuizName('');
    setIdDigits(7);
    setQuestionCount(5);
    setQuestionMaxes([5, 5, 5, 5, 5]);
    setErrors([]);
  }

  function handleQuestionCountChange(next: number) {
    setQuestionCount(next);
    setQuestionMaxes((prev) => {
      const copy = [...prev];
      while (copy.length < next) copy.push(5);
      copy.length = Math.max(next, 0);
      return copy;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = validateConfig({ quizName, idDigits, questionCount, questionMaxes });
    if (!result.valid || !result.config) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    await saveConfig(result.config);
    setSaved(result.config);
    setEditing(false);
    onStart(result.config);
  }

  if (!loaded) return null;

  return (
    <div className="page">
      <div className="app-header">
        <div>
          <span className="eyebrow">Script Mark Scanner</span>
          <h1>{saved && !editing ? saved.quizName : 'Set up this quiz'}</h1>
        </div>
      </div>

      {/*
        Renders above the quiz config on purpose. Someone reopening the app
        mid-session wants to know their scans are still there before they
        care about anything else — and if they have forgotten a session was
        open, this is the only place the app would ever tell them.
      */}
      {savedCount > 0 && (
        <div className="card stack-sm">
          <div className="row-between">
            {/*
              Wording kept distinct from the "saved on this device" line in
              HOW_IT_WORKS below, which describes the app's behaviour in
              general. This one is a count of real records right now, and
              two identical phrases meaning different things on one screen
              is a genuine reading hazard, not just a test-matcher problem.
            */}
            <span>
              <strong>
                {savedCount} {savedCount === 1 ? 'script' : 'scripts'}
              </strong>{' '}
              already scanned
            </span>
            {saved && (
              <button className="btn btn-secondary btn-sm" onClick={() => onViewResults(saved)}>
                View
              </button>
            )}
          </div>
          <span className="field-hint">
            From an earlier session. Starting a new scan adds to these rather than replacing
            them — reset first if this is a different class.
          </span>
          {!confirmingReset && (
            <div className="row">
              <button className="btn btn-danger btn-sm" onClick={() => setConfirmingReset(true)}>
                Reset everything
              </button>
            </div>
          )}
        </div>
      )}

      {confirmingReset && (
        <div className="banner banner-danger" role="alert">
          <p>
            This deletes {savedCount} saved {savedCount === 1 ? 'record' : 'records'} and the
            quiz setup — there's no undo. Make sure you've exported the Excel file first.
          </p>
          <div className="banner-actions">
            <button className="btn btn-danger-solid btn-sm" onClick={handleReset}>
              Yes, delete everything
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmingReset(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {saved && !editing ? (
        <div className="card stack">
          <div className="stack-sm">
            <div className="row-between">
              <span className="muted text-sm">Student ID digits</span>
              <span>{saved.idDigits}</span>
            </div>
            <div className="row-between">
              <span className="muted text-sm">Questions</span>
              <span>{saved.questions.length}</span>
            </div>
            <hr className="divider" />
            {saved.questions.map((q) => (
              <div className="row-between" key={q.q}>
                <span className="muted text-sm">Q{q.q}</span>
                <span>{q.max}</span>
              </div>
            ))}
            <hr className="divider" />
            <div className="row-between">
              <span style={{ fontWeight: 600 }}>Total</span>
              <span style={{ fontWeight: 600 }}>{saved.totalMax}</span>
            </div>
          </div>
          <div className="row">
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="btn btn-primary btn-block" onClick={() => onStart(saved)}>
              Start scanning &rarr;
            </button>
          </div>
        </div>
      ) : (
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
              placeholder="e.g. CSE211L Quiz 1…"
              autoComplete="off"
            />
          </div>

          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label" htmlFor="idDigits">
                Student ID digits
              </label>
              <input
                id="idDigits"
                className="input"
                type="number"
                inputMode="numeric"
                value={idDigits}
                onChange={(e) => setIdDigits(Number(e.target.value))}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label" htmlFor="questionCount">
                Number of questions
              </label>
              <input
                id="questionCount"
                className="input"
                type="number"
                inputMode="numeric"
                value={questionCount}
                onChange={(e) => handleQuestionCountChange(Number(e.target.value))}
              />
            </div>
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
                      next[i] = Number(e.target.value);
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

          <button type="submit" className="btn btn-primary btn-block">
            Start scanning &rarr;
          </button>
        </form>
      )}

      <details className="disclosure" open={!saved}>
        <summary>How this works</summary>
        <div className="disclosure-body">
          <ol className="steps-list">
            {HOW_IT_WORKS.map((step, i) => (
              <li key={step.title}>
                <span className="step-number">{i + 1}</span>
                <span className="step-text">
                  <strong>{step.title}</strong>
                  <span>{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-sm muted">
            Your marks stay on this device until you export them — there’s no account and no
            copy kept anywhere else. A photo that can’t be read clearly is always flagged for
            you to fix rather than guessed at.
          </p>
          <p className="text-sm muted">
            <strong>What’s kept to improve recognition.</strong> The photograph itself is
            never stored — it’s read and then discarded. What is saved is the individual
            cells it was cut into: one digit or one mark per image, each labelled with the
            value you confirmed. These are used to train and tune the handwriting
            recognition so it reads better over time. They carry no name, nothing that links
            them back to a student, and no way to reassemble a whole student ID from them.
          </p>
        </div>
      </details>

      {/*
        Step 11.5.1 — deliberately OUTSIDE the <details> above, which
        collapses once a quiz config exists. Someone using this for the
        tenth time would otherwise never see it again, and they are the
        person whose students' handwriting is actually being collected.
        One line, always visible, plain wording.
      */}
      <p className="text-sm muted data-note">
        Scripts are never stored. Individual cells — one digit or mark each — are kept with
        the values you confirm, and used to train and tune handwriting recognition.
      </p>
    </div>
  );
}
