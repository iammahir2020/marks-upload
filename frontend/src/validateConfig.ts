// Pure validation logic, kept separate from the form component so it's
// directly unit-testable (step.md step 5 Test section) without a DOM.
import type { QuizConfig } from './types';

export interface ConfigFormInput {
  quizName: string;
  idDigits: number;
  questionCount: number;
  questionMaxes: number[]; // must have length === questionCount
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  config?: QuizConfig;
}

// Upper bounds (issues.md N19 + N2). These are facts about a printed marks
// grid, not arbitrary limits: the template physically cannot hold more.
//
// These four are ONE HALF OF A PAIR. `backend/app/models.py` carries the
// same numbers, and `backend/tests/test_models.py` reads THIS FILE and
// asserts they still agree — two copies of a constant in two languages is
// exactly what drifts silently, and the symptom would be a quiz this form
// happily produces and the API rejects, discovered mid-class. Change one,
// change the other; the test will catch you if you forget.
export const MAX_ID_DIGITS = 15;
export const MAX_QUESTIONS = 30;
export const MAX_MARK_PER_QUESTION = 100;
export const MAX_QUIZ_NAME_LENGTH = 200;

export function validateConfig(input: ConfigFormInput): ValidationResult {
  const errors: string[] = [];

  if (!input.quizName.trim()) {
    errors.push('Quiz name is required.');
  } else if (input.quizName.trim().length > MAX_QUIZ_NAME_LENGTH) {
    errors.push(`Quiz name must be ${MAX_QUIZ_NAME_LENGTH} characters or fewer.`);
  }

  if (!Number.isInteger(input.idDigits) || input.idDigits < 1) {
    errors.push('Student ID digits must be a positive whole number.');
  } else if (input.idDigits > MAX_ID_DIGITS) {
    errors.push(`Student ID digits must be ${MAX_ID_DIGITS} or fewer.`);
  }

  if (!Number.isInteger(input.questionCount) || input.questionCount < 1) {
    errors.push('Number of questions must be a whole number, at least 1.');
  } else if (input.questionCount > MAX_QUESTIONS) {
    errors.push(`Number of questions must be ${MAX_QUESTIONS} or fewer.`);
  }

  if (input.questionMaxes.length !== input.questionCount) {
    errors.push('Question count and the number of max-mark entries do not match.');
  }

  input.questionMaxes.forEach((max, i) => {
    if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) {
      errors.push(`Q${i + 1} max must be a positive number.`);
    } else if (max > MAX_MARK_PER_QUESTION) {
      errors.push(`Q${i + 1} max must be ${MAX_MARK_PER_QUESTION} or less.`);
    }
  });

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const totalMax = input.questionMaxes.reduce((sum, m) => sum + m, 0);

  return {
    valid: true,
    errors: [],
    config: {
      quizName: input.quizName.trim(),
      idDigits: input.idDigits,
      questions: input.questionMaxes.map((max, i) => ({ q: i + 1, max })),
      totalMax,
    },
  };
}
