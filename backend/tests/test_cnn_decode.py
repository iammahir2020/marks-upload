"""Step 3r's constrained-decoder tests (step.md step 3r, Test section).
Pure numpy — no network, no onnxruntime, no trained model — fed synthetic
probability vectors directly, exactly as the spec asks for."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.marks import legal_values  # noqa: E402
from cnn.decode import _digits_of, decide_digit, decode_serial, decode_value  # noqa: E402


def one_hot(digit: int, confidence: float = 0.98) -> np.ndarray:
    probs = np.full(10, (1 - confidence) / 9)
    probs[digit] = confidence
    return probs


def test_decoder_returns_the_legal_value_its_glyphs_encode():
    """A clean '4' then '5' with a decimal point present must decode to
    the legal value 4.5, not the illegal 45.

    `has_decimal_at=1`, not 0: the index is the point's position in the
    left-to-right GLYPH sequence, so for [4][.][5] it is 1. This argument
    said 0 until 2026-08-31 — an input the real pipeline never produces,
    which passed only because the decoder compared decimal *presence* and
    threw the index away (issues.md N24). Verified against a real
    segment_cell run: [digit, decimal, digit] -> decimal_index 1."""
    glyph_probs = [one_hot(4), one_hot(5)]
    value, score = decode_value(glyph_probs, has_decimal_at=1, legal_values=legal_values(5.0))
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


def test_a_leading_zero_still_decodes_a_single_digit_mark():
    """A student writing '03' for a 3-mark answer, or '05' for a 5-mark
    one, is a completely ordinary thing to do — and before this, it could
    never decode: `_fmt(3)` is '3', one digit, so a 2-glyph '03' reading
    failed the length check against every legal value and the cell was
    flagged unmatched despite a perfectly legible read. `_digit_candidates`
    fixes this by also trying each legal value with a leading zero
    prepended."""
    value, score = decode_value([one_hot(0), one_hot(3)], has_decimal_at=None, legal_values=legal_values(5.0))
    assert value == 3.0
    assert score > 0.9

    value, score = decode_value([one_hot(0), one_hot(5)], has_decimal_at=None, legal_values=legal_values(5.0))
    assert value == 5.0
    assert score > 0.9


def test_a_leading_zero_still_decodes_a_half_mark():
    """The same padding, but for a half mark written as '01.5' — an
    unlikely write in practice, but the fix is a general one (shift the
    expected decimal position along with the padding) rather than special-
    cased to whole numbers, so it's worth pinning directly."""
    glyph_probs = [one_hot(0), one_hot(1), one_hot(5)]
    value, score = decode_value(glyph_probs, has_decimal_at=2, legal_values=legal_values(5.0))
    assert value == 1.5
    assert score > 0.9


def test_leading_zero_padding_does_not_invent_a_false_match():
    """A confident, UNPADDED two-glyph read — '1' then '3' — must not be
    quietly reinterpreted as a padded '3' just because a padded candidate
    with that length exists. The padded '0' position still has to score
    as an actual zero; a confident '1' there should score too low to win,
    same as any other wrong-digit candidate."""
    glyph_probs = [one_hot(1), one_hot(3)]
    value, score = decode_value(glyph_probs, has_decimal_at=None, legal_values=legal_values(5.0))
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


def test_decode_serial_marks_only_the_uncertain_position():
    """issues.md N32: a confident glyph next to an uncertain one used to
    discard the whole field. Measured over real serials, that threw away
    a leading zero read at 1.00 confidence because its partner scored
    0.78 — 11 of 17 serials survived where 14 of 17 were correct at raw
    argmax. The fix mirrors `read_id`'s own contract exactly: a '?' at
    the uncertain position, the confident glyph kept. `isValidSerial`
    already rejects a string containing '?', so this still blocks Confirm
    without any change to the data model or the frontend."""
    ambiguous = np.full(10, 0.01)
    ambiguous[4] = 0.11
    ambiguous[9] = 0.10
    glyph_probs = [one_hot(0), ambiguous]
    serial, confidence = decode_serial(glyph_probs, confidence_floor=0.5, margin_floor=0.3)
    assert serial == "0?"


def test_decode_serial_marks_every_uncertain_position_independently():
    """Two uncertain glyphs around one confident one — each gets its own
    '?', not a single field-wide flag."""
    ambiguous = np.full(10, 0.01)
    ambiguous[4] = 0.11
    ambiguous[9] = 0.10
    glyph_probs = [ambiguous, one_hot(7), ambiguous]
    serial, confidence = decode_serial(glyph_probs, confidence_floor=0.5, margin_floor=0.3)
    assert serial == "?7?"


def test_decode_serial_of_no_glyphs_is_none_not_empty_string():
    serial, confidence = decode_serial([], confidence_floor=0.5, margin_floor=0.3)
    assert serial is None


# --- issues.md N24: the decimal's POSITION, not just its presence ---------


def test_digits_of_reports_where_the_point_sits():
    assert _digits_of(4.0) == ([4], None)
    assert _digits_of(4.5) == ([4, 5], 1)
    assert _digits_of(12.5) == ([1, 2, 5], 2)
    assert _digits_of(0.5) == ([0, 5], 1)


def test_a_misplaced_decimal_no_longer_matches():
    """The failure the old presence-only check could not see.

    Three glyphs reading 1,2,5 with the point after the FIRST digit is
    "1.25" — not a legal mark. "12.5" is, and its point sits after the
    second. Presence-only accepted either, because both "have a decimal".
    """
    probs = [one_hot(1), one_hot(2), one_hot(5)]
    legal = {12.5}

    assert decode_value(probs, 2, legal, floor=0.1)[0] == 12.5   # 12.5 — correct
    assert decode_value(probs, 1, legal, floor=0.1)[0] is None   # 1.25 — refused


def test_two_legal_values_differing_only_in_point_position_are_told_apart():
    # The case that makes this more than tidiness: same digits, same
    # length, same "has a decimal" — only the position separates them.
    probs = [one_hot(1), one_hot(2), one_hot(5)]
    legal = {1.25, 12.5}

    assert decode_value(probs, 1, legal, floor=0.1)[0] == 1.25
    assert decode_value(probs, 2, legal, floor=0.1)[0] == 12.5


def test_whole_numbers_still_require_no_point_at_all():
    probs = [one_hot(4)]
    assert decode_value(probs, None, {4.0, 4.5}, floor=0.1)[0] == 4.0
    assert decode_value(probs, 0, {4.0}, floor=0.1)[0] is None
