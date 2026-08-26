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

export function validateConfig(input: ConfigFormInput): ValidationResult {
  const errors: string[] = [];

  if (!input.quizName.trim()) {
    errors.push('Quiz name is required.');
  }

  if (!Number.isInteger(input.idDigits) || input.idDigits < 1) {
    errors.push('Student ID digits must be a positive whole number.');
  }

  if (!Number.isInteger(input.questionCount) || input.questionCount < 1) {
    errors.push('Number of questions must be at least 1.');
  }

  if (input.questionMaxes.length !== input.questionCount) {
    errors.push('Question count and the number of max-mark entries do not match.');
  }

  input.questionMaxes.forEach((max, i) => {
    if (typeof max !== 'number' || Number.isNaN(max) || max <= 0) {
      errors.push(`Q${i + 1} max must be a positive number.`);
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
