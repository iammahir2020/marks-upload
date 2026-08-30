"""Data models (step.md step 4.1), matching plan.md §8 exactly."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class QuestionMark(BaseModel):
    q: int
    value: float | None = None  # one of 0, 0.5, 1, ..., max; None if unreadable


class ScanResult(BaseModel):
    status: Literal["ok", "failed"]
    failure_reason: str | None = None
    # "table_not_found" | "column_count_mismatch" | "blurry"
    # | "rate_limited" | "model_error"
    student_id: str | None = None
    serial: str | None = None
    questions: list[QuestionMark] = []
    total: QuestionMark | None = None
    low_confidence_fields: list[str] = []


class QuestionConfig(BaseModel):
    q: int
    max: float


class QuizConfig(BaseModel):
    quizName: str
    idDigits: int
    questions: list[QuestionConfig]
    totalMax: float


class HarvestFields(BaseModel):
    """One side (original or confirmed) of a /api/harvest request (step.md
    step 3r.6c). `questions` is positional (index 0 = Q1), not keyed by
    `q` the way ScanResult's QuestionMark is — the frontend already has
    both shapes and reshaping to positional here keeps `harvest()`'s own
    signature simple."""
    studentId: str | None = None
    serial: str | None = None
    questions: list[float | None] = []
    total: float | None = None
