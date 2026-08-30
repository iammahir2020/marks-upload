"""Step 3r's constrained-decoder tests (step.md step 3r, Test section).
Pure numpy — no network, no onnxruntime, no trained model — fed synthetic
probability vectors directly, exactly as the spec asks for."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.marks import legal_values  # noqa: E402
from cnn.decode import decide_digit, decode_serial, decode_value  # noqa: E402


def one_hot(digit: int, confidence: float = 0.98) -> np.ndarray:
    probs = np.full(10, (1 - confidence) / 9)
    probs[digit] = confidence
    return probs


def test_decoder_returns_the_legal_value_its_glyphs_encode():
    """A clean '4' then '5' with a decimal point present must decode to
    the legal value 4.5, not the illegal 45."""
    glyph_probs = [one_hot(4), one_hot(5)]
    value, score = decode_value(glyph_probs, has_decimal_at=0, legal_values=legal_values(5.0))
    assert value == 4.5
    assert score > 0.9


def test_decoder_never_returns_an_illegal_value():
    """The same two glyphs, read as a whole number (no decimal point
    segmented) — '45' is not in a 5-mark question's legal set, and must
    never be returned, by construction rather than after-the-fact
    validation (plan.md §16's whole point)."""
    glyph_probs = [one_hot(4), one_hot(5)]
    value, score = decode_value(glyph_probs, has_decimal_at=None, legal_values=legal_values(5.0))
    assert value is None
    assert value not in (45, "45")


def test_decoder_rejects_every_candidate_length_mismatch():
    """Even a single, extremely confident glyph can't match a two-digit
    legal value — length has to match exactly."""
    glyph_probs = [one_hot(4, confidence=0.999)]
    value, score = decode_value(glyph_probs, has_decimal_at=None, legal_values={4.5, 40.0})
    assert value is None


def test_decoder_picks_the_best_scoring_whole_number():
    glyph_probs = [one_hot(3)]
    value, score = decode_value(glyph_probs, has_decimal_at=None, legal_values=legal_values(5.0))
    assert value == 3.0


def test_ambiguous_low_margin_input_flags_rather_than_guesses():
    """A near-tie between two digits (e.g. a smudged 4 vs 9) must not be
    silently resolved to whichever is a hair ahead — plan.md §16's
    'confidence, and when to flag' exists for exactly this case."""
    probs = np.full(10, 0.01)
    probs[4] = 0.5
    probs[9] = 0.48  # top two nearly tied
    digit, confidence, margin = decide_digit(probs, confidence_floor=0.3, margin_floor=0.2)
    assert digit is None


def test_confident_and_clear_input_is_not_flagged():
    probs = one_hot(7, confidence=0.95)
    digit, confidence, margin = decide_digit(probs, confidence_floor=0.5, margin_floor=0.3)
    assert digit == 7


def test_decode_serial_concatenates_confident_glyphs():
    glyph_probs = [one_hot(0), one_hot(7)]
    serial, confidence = decode_serial(glyph_probs, confidence_floor=0.5, margin_floor=0.3)
    assert serial == "07"


def test_decode_serial_flags_the_whole_field_if_any_glyph_is_uncertain():
    """One bad glyph among several good ones must not produce a
    partially-guessed string — the data model represents an unreadable
    serial as fully blank-and-flagged, not '0?'."""
    ambiguous = np.full(10, 0.01)
    ambiguous[4] = 0.11
    ambiguous[9] = 0.10
    glyph_probs = [one_hot(0), ambiguous]
    serial, confidence = decode_serial(glyph_probs, confidence_floor=0.5, margin_floor=0.3)
    assert serial is None


def test_decode_serial_of_no_glyphs_is_none_not_empty_string():
    serial, confidence = decode_serial([], confidence_floor=0.5, margin_floor=0.3)
    assert serial is None
