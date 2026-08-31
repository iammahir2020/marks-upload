"""Constrained decoding (step.md step 3r.3, plan.md §16 "Constrained
decoding"). Pure numpy — no torch, no onnxruntime, no network — so it can
be unit-tested directly against synthetic probability vectors, exactly as
step.md's own Test section for this step asks for.

This is what makes local recognition beat the Gemini path rather than
merely match it (plan.md §16): don't parse a classifier's output into a
string and validate afterward. Score every legal value directly against
the per-glyph probabilities, so an illegal reading (a `45` where only
`4.5` is legal) can never be produced in the first place — not rejected
after the fact, simply never a candidate.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.marks import _fmt  # noqa: E402

DECODE_FLOOR = 0.3  # plan.md §16's own starting point for the joint
                      # per-cell decode score — provisional in the same
                      # sense every other floor in this project is,
                      # pending real-photo calibration (step 3r.5).


def decide_digit(
    probs: np.ndarray, confidence_floor: float, margin_floor: float
) -> tuple[int | None, float, float]:
    """One glyph's (10,) class-probability vector -> (class index or None,
    confidence, margin). Two signals, per plan.md §16 "Confidence, and
    when to flag": the top class's own probability, and its margin over
    the runner-up — a near-tie is worse than a confident-but-imperfect
    top score even at the same max probability. Below either floor,
    flag rather than guess (None) — mirrors id_ocr.py's own posture,
    applied to a different recognizer.
    """
    order = np.argsort(probs)[::-1]
    top, second = float(probs[order[0]]), float(probs[order[1]])
    confidence, margin = top, top - second
    if confidence < confidence_floor or margin < margin_floor:
        return None, confidence, margin
    return int(order[0]), confidence, margin


def _digits_of(value: float) -> tuple[list[int], int | None]:
    """value -> (digit list, where a decimal point sits among the glyphs).

    e.g. 4.0 -> ([4], None), 4.5 -> ([4, 5], 1), 12.5 -> ([1, 2, 5], 2).

    The index is the position the point occupies in the LEFT-TO-RIGHT glyph
    sequence, which is also the count of digits before it — the same thing
    `segment_cell` reports as `is_decimal`'s index. Returning the position
    rather than a bare "has a decimal" flag is issues.md N24: the old
    version returned a bool, so the decoder could only check that a decimal
    existed, never that it was in the right place.

    Deliberately not plan.md §16's illustrative `f"{value}".replace(".", "")`:
    Python's default float formatting always renders a whole number as
    "4.0", not "4", so copied literally that would require a *two*-glyph
    reading with no decimal point to ever match a whole mark, when a real
    handwritten "4" is one glyph. `_fmt` already exists in marks.py to
    produce the same minimal form the instructor actually writes (it builds
    the Gemini prompt's legal-value list), so reusing it keeps both
    recognizers' idea of "how a legal value is written" identical rather
    than diverging by accident.
    """
    s = _fmt(value)
    decimal_at = s.index(".") if "." in s else None
    digits = [int(c) for c in s if c != "."]
    return digits, decimal_at


def decode_value(
    glyph_probs: list[np.ndarray],
    has_decimal_at: int | None,
    legal_values: set[float],
    floor: float = DECODE_FLOOR,
) -> tuple[float | None, float]:
    """Score every value in `legal_values` directly against the segmented
    glyphs' probability vectors (product of per-digit class
    probabilities) and return the best-scoring one — or None, to flag,
    if even the best score is below `floor`. A smudged "4.5" that a
    free-form parser might read as "45" resolves correctly by
    construction here, because "45" is never a candidate for a
    5-mark question in the first place (plan.md §16).
    """
    best_value: float | None = None
    best_score = 0.0

    for value in legal_values:
        digits, expects_decimal_at = _digits_of(value)
        if len(digits) != len(glyph_probs):
            continue
        # WHERE the point is, not merely whether there is one (issues.md
        # N24). The old check compared presence only and discarded the
        # index, which is harmless against today's legal sets — every
        # x and x.5 of the same digit count puts the point in the same
        # place — and silently wrong the moment two legal values share
        # their digits and differ only in point position. A quarter-mark
        # or two-decimal scheme does exactly that.
        if expects_decimal_at != has_decimal_at:
            continue

        score = 1.0
        for digit, probs in zip(digits, glyph_probs):
            score *= float(probs[digit])

        if score > best_score:
            best_value, best_score = value, score

    if best_value is None or best_score < floor:
        return None, best_score
    return best_value, best_score


def decode_serial(
    glyph_probs: list[np.ndarray], confidence_floor: float, margin_floor: float
) -> tuple[str | None, float]:
    """Serial has no decimal point and no small enumerable legal set the
    way a mark does — plan.md §16 describes its legal set as "every
    integer the class could plausibly use," which for an unconstrained,
    independent-per-position digit string is mathematically the same
    search as just taking each glyph's own best-scoring digit: there is
    no cross-digit constraint to exploit the way there is for a 5-mark
    question's ~11 legal values. So this decodes each glyph independently
    via the same confidence/margin floors, and flags the *whole* serial
    (returns None) if any single glyph is uncertain — matching this
    project's data model, which represents an unreadable serial as one
    None-and-flagged field, not a partially-filled string with a
    stray "?" in it.

    Returns the plain digit string as segmented (e.g. "07") — leading-zero
    stripping for comparison purposes is `validateMarks.ts`'s job on the
    frontend, not this function's; every other recognizer (Gemini, the
    Tesseract fallback) also returns the raw string it read.
    """
    if not glyph_probs:
        return None, 0.0

    digits = []
    min_confidence = 1.0
    for probs in glyph_probs:
        digit, confidence, margin = decide_digit(probs, confidence_floor, margin_floor)
        if digit is None:
            return None, min(min_confidence, confidence)
        digits.append(str(digit))
        min_confidence = min(min_confidence, confidence)

    return "".join(digits), min_confidence
