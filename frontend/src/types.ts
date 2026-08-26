// Matches backend/app/models.py's QuizConfig and plan.md §8 exactly.

export interface QuestionConfig {
  q: number;
  max: number;
}

export interface QuizConfig {
  quizName: string;
  idDigits: number;
  questions: QuestionConfig[];
  totalMax: number;
}

export interface QuestionValue {
  q: number;
  value: number | null;
}

export interface StudentRecord {
  id: string; // client-generated uuid
  studentId: string | null;
  serial: string | null; // normalized: leading zeros stripped
  questions: QuestionValue[];
  total: number | null;
  confirmed: boolean;
  capturedAt: string;
}
