"""QuizConfig's bounds and cross-field rules (issues.md N2, #10, #14).

The first test in this file is the unusual one: it reads the **TypeScript**
source and asserts the frontend's bounds equal the Python ones. Two copies
of three numbers in two languages cannot be shared, so the only honest
options are "document the pairing and hope" or "pin it with a test". This
is the second. Without it the drift is silent and the symptom is remote: a
quiz the Setup form accepts and the API rejects, discovered mid-class.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.models import (
    MAX_ID_DIGITS,
    MAX_MARK_PER_QUESTION,
    MAX_QUESTIONS,
    MAX_QUIZ_NAME_LENGTH,
    QuizConfig,
)

VALIDATE_CONFIG_TS = (
    Path(__file__).resolve().parent.parent.parent / "frontend" / "src" / "validateConfig.ts"
)


def _ts_const(name: str) -> float:
    """Pull `export const NAME = <number>;` out of the TypeScript source."""
    source = VALIDATE_CONFIG_TS.read_text()
    match = re.search(rf"export const {name}\s*=\s*([0-9.]+)\s*;", source)
    assert match, f"{name} not found in {VALIDATE_CONFIG_TS.name} — was it renamed?"
    return float(match.group(1))


@pytest.mark.skipif(not VALIDATE_CONFIG_TS.exists(), reason="frontend source not present")
@pytest.mark.parametrize(
    "ts_name, py_value",
    [
        ("MAX_ID_DIGITS", MAX_ID_DIGITS),
        ("MAX_QUESTIONS", MAX_QUESTIONS),
        ("MAX_MARK_PER_QUESTION", MAX_MARK_PER_QUESTION),
        ("MAX_QUIZ_NAME_LENGTH", MAX_QUIZ_NAME_LENGTH),
    ],
)
def test_frontend_and_backend_bounds_have_not_drifted(ts_name, py_value):
    assert _ts_const(ts_name) == py_value, (
        f"{ts_name} disagrees between validateConfig.ts and app/models.py. "
        "These are one bound expressed twice; change both."
    )


def config(**overrides):
    base = {
        "quizName": "CSE211L Quiz 1",
        "idDigits": 7,
        "questions": [{"q": 1, "max": 5}, {"q": 2, "max": 5}],
        "totalMax": 10,
    }
    base.update(overrides)
    return base


# --- N2: bounds ------------------------------------------------------------


def test_an_absurd_max_is_refused_before_legal_values_can_allocate_it():
    # The attack: legal_values() materialises 2*max+1 entries, reached from
    # both recognizers. 1e9 asks for two billion floats.
    with pytest.raises(ValidationError):
        QuizConfig.model_validate(config(questions=[{"q": 1, "max": 1e9}], totalMax=1e9))


def test_a_zero_or_negative_max_is_refused():
    for bad in (0, -5):
        with pytest.raises(ValidationError):
            QuizConfig.model_validate(config(questions=[{"q": 1, "max": bad}], totalMax=bad))


def test_id_digits_is_bounded_at_both_ends():
    for bad in (0, MAX_ID_DIGITS + 1):
        with pytest.raises(ValidationError):
            QuizConfig.model_validate(config(idDigits=bad))


def test_an_empty_or_oversized_question_list_is_refused():
    with pytest.raises(ValidationError):
        QuizConfig.model_validate(config(questions=[], totalMax=1))
    many = [{"q": i + 1, "max": 1} for i in range(MAX_QUESTIONS + 1)]
    with pytest.raises(ValidationError):
        QuizConfig.model_validate(config(questions=many, totalMax=len(many)))


def test_an_unbounded_quiz_name_is_refused():
    with pytest.raises(ValidationError):
        QuizConfig.model_validate(config(quizName="x" * (MAX_QUIZ_NAME_LENGTH + 1)))


# --- #10: q-order ----------------------------------------------------------


def test_out_of_order_questions_are_refused_not_silently_reordered():
    # main.py maps by ARRAY ORDER and relabels q=i+1, so accepting this
    # would write Q2's mark into the Q1 column — each value still passing
    # its own legal-value check, against the wrong question's set.
    with pytest.raises(ValidationError, match="in order"):
        QuizConfig.model_validate(
            config(questions=[{"q": 2, "max": 5}, {"q": 1, "max": 5}])
        )


def test_questions_not_starting_at_one_are_refused():
    with pytest.raises(ValidationError, match="in order"):
        QuizConfig.model_validate(
            config(questions=[{"q": 3, "max": 5}, {"q": 4, "max": 5}])
        )


def test_duplicate_question_numbers_are_refused():
    with pytest.raises(ValidationError, match="in order"):
        QuizConfig.model_validate(
            config(questions=[{"q": 1, "max": 5}, {"q": 1, "max": 5}])
        )


# --- #14: totalMax ---------------------------------------------------------


def test_a_total_max_disagreeing_with_the_sum_is_refused():
    # The review screen validates its Total field against config.totalMax
    # while the backend recomputes sum(question_maxes). Two numbers that
    # must agree, previously with nothing checking that they did.
    with pytest.raises(ValidationError, match="totalMax"):
        QuizConfig.model_validate(config(totalMax=25))


def test_a_correct_total_max_is_accepted_including_half_marks():
    cfg = QuizConfig.model_validate(
        config(questions=[{"q": 1, "max": 2.5}, {"q": 2, "max": 2.5}], totalMax=5)
    )
    assert cfg.totalMax == 5


def test_an_ordinary_quiz_still_validates():
    cfg = QuizConfig.model_validate(config())
    assert [q.q for q in cfg.questions] == [1, 2]
    assert cfg.totalMax == 10
