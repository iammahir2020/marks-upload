"""CNNRecognizer._resolve — how a mark cell's readings become either one
value or a set of one-tap choices (2026-09-25).

The rule under test: a single legal reading from real evidence is the
value; more than one is a tie for the instructor, never a pick. A WEAK
point (segment.py's mid-height or rescued dot) is real evidence tried both
ways; stray ink between digits only ever adds a choice.

Glyphs are built by hand and given near-certain digit probabilities, so
each case exercises the decision rule and nothing else.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.marks import legal_values  # noqa: E402
from app.recognizers.local import DEFAULT_MODEL_PATH, CNNRecognizer, _CellRead  # noqa: E402
from cnn.segment import Glyph  # noqa: E402

INK = np.zeros((10, 10, 3), dtype=np.uint8)


@pytest.fixture(scope="module")
def rec():
    if not DEFAULT_MODEL_PATH.exists():
        pytest.skip("digit_cnn.onnx not present")
    return CNNRecognizer()


def one_hot(d: int) -> np.ndarray:
    p = np.full(11, 0.001)
    p[d] = 0.99
    return p


def cell(*parts):
    """parts: digits as ints, "." for a strong point, "w." for a weak one."""
    glyphs, probs = [], {}
    for i, part in enumerate(parts):
        if isinstance(part, int):
            glyphs.append(Glyph(image=INK, x0=i * 10, x1=i * 10 + 9, is_decimal=False))
            probs[i] = one_hot(part)
        else:
            glyphs.append(Glyph(image=INK, x0=i * 10, x1=i * 10 + 9, is_decimal=True, weak=part == "w."))
    return glyphs, probs


def resolve(rec, parts, max_mark, stray=False) -> _CellRead:
    glyphs, probs = cell(*parts)
    return rec._resolve(glyphs, probs, legal_values(max_mark), stray)


def test_a_weak_point_resolves_when_only_one_reading_is_legal(rec):
    """"25" isn't a mark out of 5, so the weak dot settles it: 2.5."""
    assert resolve(rec, (2, "w.", 5), 5).value == 2.5


def test_a_weak_point_on_a_tie_offers_both(rec):
    """The instructor's own page: two "2.5"s whose dots were under the
    noise floor read as a confident 25. On a 25-mark Total both are legal."""
    read = resolve(rec, (2, "w.", 5), 25)
    assert read.value is None
    assert read.choices == (2.5, 25.0)
    assert read.had_ink


def test_a_strong_point_is_still_just_the_value(rec):
    """Unchanged behaviour: a clear point low in the band decides it."""
    assert resolve(rec, (2, ".", 5), 25).value == 2.5


def test_stray_ink_between_digits_turns_a_two_digit_read_into_a_tie(rec):
    """A lost point's direction: "1.5" read as 15 with a smudge between."""
    read = resolve(rec, (1, 5), 25, stray=True)
    assert read.value is None
    assert read.choices == (1.5, 15.0)


def test_without_stray_ink_a_two_digit_read_is_the_value(rec):
    assert resolve(rec, (1, 5), 25).value == 15.0


def test_stray_ink_alone_never_sets_a_value(rec):
    """On a 5-mark question "15" is illegal and only 1.5 is left — still a
    choice, not a value: a smudge is not a written point."""
    read = resolve(rec, (1, 5), 5, stray=True)
    assert read.value is None
    assert read.choices == (1.5,)
    assert read.suggestion == 1.5


def test_a_speck_taken_for_a_weak_point_does_not_break_a_whole_mark(rec):
    """"10" with a speck read as a point: "1.0" is no legal rendering."""
    assert resolve(rec, (1, "w.", 0), 10).value == 10.0


def test_a_lost_point_still_suggests_as_before(rec):
    """The pre-existing _missing_point path: "25" on a 5-mark question."""
    read = resolve(rec, (2, 5), 5)
    assert read.value is None
    assert read.suggestion == 2.5
    assert read.choices == (2.5,)


def test_read_marks_carries_choices_and_refuses_them_for_harvest(rec, tmp_path, monkeypatch):
    """A tie arrives as `choices`, and the field is unmatched — which is
    what keeps /api/harvest from labelling the crop with a guess (N31)."""
    tie = _CellRead(had_ink=True, choices=(1.5, 15.0))
    whole = _CellRead(value=3.0)
    monkeypatch.setattr(rec, "_decode_value_cell", lambda path, legal: tie if path.name.endswith("c1.png") else whole)
    monkeypatch.setattr(rec, "_decode_serial_cell", lambda path: _CellRead(value="7", had_ink=True))

    result = rec.read_marks(tmp_path, [5.0], has_serial=True)

    assert result.questions == [3.0]
    assert result.total is None
    assert result.choices == {"total": ["1.5", "15"]}
    assert "total" in result.unmatched_fields
    assert "total" in result.low_confidence_fields
