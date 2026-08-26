// Setup screen (plan.md §11, step.md step 5.3): quiz name, ID digits,
// question count, per-question max. Persists QuizConfig on submit and
// reloads it on start (step 5.4).
import { useEffect, useState } from 'react';
import { loadConfig, saveConfig } from './db';
import type { QuizConfig } from './types';
import { validateConfig } from './validateConfig';

interface SetupProps {
  onStart: (config: QuizConfig) => void;
}

export default function Setup({ onStart }: SetupProps) {
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<QuizConfig | null>(null);
  const [editing, setEditing] = useState(false);

  const [quizName, setQuizName] = useState('');
  const [idDigits, setIdDigits] = useState(7);
  const [questionCount, setQuestionCount] = useState(5);
  const [questionMaxes, setQuestionMaxes] = useState<number[]>([5, 5, 5, 5, 5]);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    loadConfig().then((config) => {
      if (config) {
        setSaved(config);
        setQuizName(config.quizName);
        setIdDigits(config.idDigits);
        setQuestionCount(config.questions.length);
        setQuestionMaxes(config.questions.map((q) => q.max));
      }
      setLoaded(true);
    });
  }, []);

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

  if (saved && !editing) {
    return (
      <div>
        <h1>{saved.quizName}</h1>
        <p>Student ID digits: {saved.idDigits}</p>
        <p>Questions: {saved.questions.length}</p>
        <ul>
          {saved.questions.map((q) => (
            <li key={q.q}>
              Q{q.q}: {q.max}
            </li>
          ))}
        </ul>
        <p>Total: {saved.totalMax}</p>
        <button onClick={() => setEditing(true)}>Edit</button>
        <button onClick={() => onStart(saved)}>Start scanning →</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>
        Quiz name
        <input value={quizName} onChange={(e) => setQuizName(e.target.value)} />
      </label>

      <label>
        Student ID digits
        <input
          type="number"
          value={idDigits}
          onChange={(e) => setIdDigits(Number(e.target.value))}
        />
      </label>

      <label>
        Number of questions
        <input
          type="number"
          value={questionCount}
          onChange={(e) => handleQuestionCountChange(Number(e.target.value))}
        />
      </label>

      {questionMaxes.map((max, i) => (
        <label key={i}>
          Q{i + 1} max
          <input
            type="number"
            value={max}
            onChange={(e) => {
              const next = [...questionMaxes];
              next[i] = Number(e.target.value);
              setQuestionMaxes(next);
            }}
          />
        </label>
      ))}

      <p>These must match the table pasted in your question paper.</p>

      {errors.length > 0 && (
        <ul>
          {errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}

      <button type="submit">Start scanning →</button>
    </form>
  );
}
