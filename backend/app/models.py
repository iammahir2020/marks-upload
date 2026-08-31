"""Data models (step.md step 4.1), matching plan.md §8 exactly.

**The bounds below are one half of a pair.** `frontend/src/validateConfig.ts`
carries the same three numbers, and `tests/test_models.py` reads that file
and asserts they still agree — because two copies of a constant in two
languages is exactly the kind of thing that drifts silently, and the failure
mode is a config the form happily produces and the API rejects (or worse,
the reverse). Change one, change the other, and the test will tell you if
you forget.

Why they exist at all (issues.md N2): `max` was an unbounded `float`, and
`marks.legal_values()` materialises `2*max + 1` entries — verified reached
from the CNN path too, not just Gemini's — so `max: 1e9` asks for two
billion floats and OOM-kills the function. These are facts about a printed
marks grid, not arbitrary limits: the template physically cannot hold more.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

# --- Bounds. Keep in step with frontend/src/validateConfig.ts -------------
MAX_ID_DIGITS = 15
MAX_QUESTIONS = 30
MAX_MARK_PER_QUESTION = 100.0
MAX_QUIZ_NAME_LENGTH = 200

# Deliberately generous, and deliberately NOT the place semantic validation
# happens. `original` carries the recognizer's raw output, which legitimately
# contains "?" for a position it could not read (both recognizers promise
# that), so a digits-only pattern here would reject every flagged scan and
# silently stop harvesting exactly the crops worth collecting. Shape checking
# for a serial lives in marks.validate_payload; path safety lives in
# harvest._sanitize_value, at the point of use.
MAX_HARVEST_FIELD_LENGTH = 32


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
    q: int = Field(ge=1, le=MAX_QUESTIONS)
    max: float = Field(gt=0, le=MAX_MARK_PER_QUESTION)


class QuizConfig(BaseModel):
    quizName: str = Field(max_length=MAX_QUIZ_NAME_LENGTH)
    idDigits: int = Field(ge=1, le=MAX_ID_DIGITS)
    questions: list[QuestionConfig] = Field(min_length=1, max_length=MAX_QUESTIONS)
    totalMax: float = Field(gt=0)

    @model_validator(mode="after")
    def _questions_are_in_q_order(self) -> "QuizConfig":
        """`q` must be 1..n, in order (issues.md #10).

        `main.py` derives `question_maxes` from this list's ARRAY ORDER and
        relabels results as `q=i+1`, so an out-of-order `q` silently writes
        one question's mark into another's column — each value still passing
        its own legal-value check, just against the wrong question's set.
        Nothing caught that; it was prevented only by `validateConfig.ts`
        always building the list in order, which is a convention on the
        client, not a guarantee on a public endpoint.

        Fail loudly rather than sorting into place: a caller that sent them
        out of order has a different idea of the mapping than we do, and
        quietly picking ours is how Q4's mark ends up in the Q3 column.
        """
        actual = [q.q for q in self.questions]
        expected = list(range(1, len(self.questions) + 1))
        if actual != expected:
            raise ValueError(
                f"questions must be numbered 1..{len(self.questions)} in order, got {actual}"
            )
        return self

    @model_validator(mode="after")
    def _total_max_agrees_with_the_questions(self) -> "QuizConfig":
        """`totalMax` must equal the sum of the per-question maxima
        (issues.md #14).

        It was required in every payload and read nowhere — `marks.py` and
        `recognizers/local.py` each independently recompute
        `sum(question_maxes)`. So a `totalMax` disagreeing with the real sum
        went unnoticed, while the REVIEW SCREEN validates its Total field
        against `config.totalMax`. Two numbers that must agree, with nothing
        checking they do, and the client trusting one while the server
        trusts the other.

        Checked here rather than dropped from the model, because the
        frontend genuinely needs the value and computing it twice is how
        they diverge. If a "best 4 of 5" scheme ever arrives, this is the
        assumption to revisit — deliberately, not by accident.
        """
        expected = sum(q.max for q in self.questions)
        if abs(self.totalMax - expected) > 1e-9:
            raise ValueError(
                f"totalMax ({self.totalMax}) must equal the sum of question maxima ({expected})"
            )
        return self


class HarvestFields(BaseModel):
    """One side (original or confirmed) of a /api/harvest request (step.md
    step 3r.6c). `questions` is positional (index 0 = Q1), not keyed by
    `q` the way ScanResult's QuestionMark is — the frontend already has
    both shapes and reshaping to positional here keeps `harvest()`'s own
    signature simple.

    Length-capped but not pattern-matched — see MAX_HARVEST_FIELD_LENGTH."""
    studentId: str | None = Field(default=None, max_length=MAX_HARVEST_FIELD_LENGTH)
    serial: str | None = Field(default=None, max_length=MAX_HARVEST_FIELD_LENGTH)
    questions: list[float | None] = Field(default=[], max_length=MAX_QUESTIONS)
    total: float | None = None
