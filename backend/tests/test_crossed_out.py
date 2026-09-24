"""Step 15: what CNNRecognizer does with a crossed-out glyph.

These tests are about ROUTING — which field ends up blank, flagged,
crossed out or suggested — not about whether the model recognises a real
scribble; cnn/crossed_accuracy.py measures that against real handwriting.
So the model is replaced by a fake that calls any solid block CROSSED_OUT
and any thin stroke a 5, which makes every case deterministic.

Patched through `__globals__` for the reason test_local_recognizer_
unmatched.py records: another test re-imports app.recognizers.local, and
patching by module name can then hit a different module object than the
one CNNRecognizer's methods actually run against.
"""
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.recognizers.local import DEFAULT_MODEL_PATH, CNNRecognizer  # noqa: E402
from cnn.classes import CROSSED_OUT, NUM_CLASSES  # noqa: E402
from cnn.decode import decide_digit, is_crossed_out  # noqa: E402

CELL_H = 120
SLOT_W = 70  # horizontal room per glyph, so neighbours never merge


def _probs(cls: int) -> np.ndarray:
    p = np.full(NUM_CLASSES, 0.002)
    p[cls] = 1 - 0.002 * (NUM_CLASSES - 1)
    return p


def fake_glyph_probs(_session, canvas: np.ndarray) -> np.ndarray:
    """Solid ink fills most of its 28x28 canvas; a thin stroke fills little."""
    return _probs(CROSSED_OUT if (canvas > 0).mean() > 0.3 else 5)


def _cell(kinds: list[str]) -> np.ndarray:
    """kinds, left to right: "x" (a solid block — crossed out), "5" (a thin
    stroke — reads as 5), "." (a small dot low in the cell)."""
    img = np.full((CELL_H, SLOT_W * (len(kinds) + 1), 3), 255, dtype=np.uint8)
    for i, kind in enumerate(kinds):
        cx = SLOT_W * (i + 1)
        if kind == "x":
            cv2.rectangle(img, (cx - 18, 30), (cx + 18, 90), (0, 0, 0), -1)
        elif kind == "5":
            cv2.line(img, (cx, 30), (cx, 90), (0, 0, 0), 5)
        elif kind == ".":
            cv2.circle(img, (cx, 86), 5, (0, 0, 0), -1)
    return img


def _id_box(kind: str) -> np.ndarray:
    box = np.full((100, 80, 3), 255, dtype=np.uint8)
    if kind == "x":
        cv2.rectangle(box, (25, 25), (55, 75), (0, 0, 0), -1)
    else:
        cv2.line(box, (40, 25), (40, 75), (0, 0, 0), 5)
    return box


@pytest.fixture
def recognizer(monkeypatch):
    if not DEFAULT_MODEL_PATH.exists():
        pytest.skip("no trained model at cnn/checkpoints/digit_cnn.onnx")
    # read_id and read_marks' helpers live in the same module, so one
    # patch of the shared globals dict covers every call site.
    monkeypatch.setitem(CNNRecognizer.read_id.__globals__, "glyph_probs", fake_glyph_probs)
    return CNNRecognizer()


def _read(tmp_path, recognizer, serial, questions, total, maxes=None):
    cells = tmp_path / "cells"
    cells.mkdir()
    cv2.imwrite(str(cells / "serial.png"), _cell(serial))
    for i, q in enumerate(questions):
        cv2.imwrite(str(cells / f"marks_r1_c{i}.png"), _cell(q))
    cv2.imwrite(str(cells / f"marks_r1_c{len(questions)}.png"), _cell(total))
    return recognizer.read_marks(cells, maxes or [5.0] * len(questions))


def test_the_fake_model_reads_the_fixtures_the_way_these_tests_assume(tmp_path, recognizer):
    result = _read(tmp_path, recognizer, ["5"], [["5"]], ["5"])
    assert result.serial == "5"
    assert result.questions == [5.0]
    assert result.crossed_out_fields == []
    assert result.suggestions == {}


def test_a_struck_mark_with_a_correction_is_blank_flagged_and_suggested(tmp_path, recognizer):
    """The photo that started this: a 6 struck out, 5 written beside it.
    The 5 is offered, never stored."""
    result = _read(tmp_path, recognizer, ["5"], [["x", "5"]], [])
    assert result.questions == [None]
    assert "q1" in result.low_confidence_fields
    assert result.crossed_out_fields == ["q1"]
    assert result.suggestions == {"q1": "5"}
    # A crossed-out cell gets its own signal, not N31's "no legal value".
    assert "q1" not in result.unmatched_fields


def test_a_struck_mark_with_nothing_left_offers_no_suggestion(tmp_path, recognizer):
    result = _read(tmp_path, recognizer, ["5"], [["x"]], [])
    assert result.questions == [None]
    assert result.crossed_out_fields == ["q1"]
    assert "q1" not in result.suggestions


def test_what_remains_must_still_be_a_legal_value(tmp_path, recognizer):
    """Struck glyph dropped, "55" left, on a 5-mark question: 55 is not
    legal, so there is nothing to suggest."""
    result = _read(tmp_path, recognizer, ["5"], [["x", "5", "5"]], [])
    assert result.questions == [None]
    assert "q1" not in result.suggestions


def test_a_decimal_point_stranded_by_a_struck_value_suggests_nothing(tmp_path, recognizer):
    """ "2.5" struck out glyph by glyph, then "5" written: the point that
    survives sits before every remaining digit, where no legal value puts
    one."""
    result = _read(tmp_path, recognizer, ["5"], [["x", ".", "x", "5"]], [])
    assert result.questions == [None]
    assert "q1" not in result.suggestions


def test_a_struck_total_is_handled_like_a_question(tmp_path, recognizer):
    result = _read(tmp_path, recognizer, ["5"], [["5"]], ["x", "5"])
    assert result.total is None
    assert "total" in result.crossed_out_fields
    assert result.suggestions == {"total": "5"}


def test_a_struck_serial_is_blank_and_suggests_the_rest(tmp_path, recognizer):
    result = _read(tmp_path, recognizer, ["x", "5", "5"], [["5"]], ["5"])
    assert result.serial is None
    assert "serial" in result.low_confidence_fields
    assert result.crossed_out_fields == ["serial"]
    assert result.suggestions == {"serial": "55"}


def test_a_struck_id_box_is_a_question_mark_not_a_digit(tmp_path, recognizer):
    cells = tmp_path / "cells"
    cells.mkdir()
    for i, kind in enumerate(["5", "5", "x", "5"], start=1):
        cv2.imwrite(str(cells / f"id_d{i}.png"), _id_box(kind))
    result = recognizer.read_id(cells, 4)
    assert result.student_id == "55?5"
    assert result.low_confidence_fields == ["student_id"]
    assert result.crossed_out_fields == ["student_id"]


def test_a_clean_id_reports_nothing_crossed_out(tmp_path, recognizer):
    cells = tmp_path / "cells"
    cells.mkdir()
    for i in range(1, 4):
        cv2.imwrite(str(cells / f"id_d{i}.png"), _id_box("5"))
    result = recognizer.read_id(cells, 3)
    assert result.student_id == "555"
    assert result.crossed_out_fields == []


# --- the decode rules underneath ------------------------------------------


def test_decide_digit_never_returns_the_crossed_out_class_as_a_digit():
    digit, confidence, _margin = decide_digit(_probs(CROSSED_OUT), 0.5, 0.1)
    assert digit is None
    assert confidence > 0.9


def test_is_crossed_out_uses_the_floor():
    p = np.full(NUM_CLASSES, 0.0)
    p[CROSSED_OUT], p[3] = 0.6, 0.4
    assert is_crossed_out(p, 0.5)
    assert not is_crossed_out(p, 0.7)


def test_a_ten_class_vector_is_never_crossed_out():
    """An older 10-output model has no such class; the check must degrade
    to "not crossed out", not index past the end."""
    assert not is_crossed_out(np.full(10, 0.1), 0.5)


# --- A lost decimal point: "2 5" read as 2.5 (2026-09-24) ------------------
#
# Not a crossed-out case, but the same one-tap suggestion channel: a pen dot
# too small for segment.py's noise floor, or merged into a digit, leaves a
# half mark as two plain digit glyphs.


def test_a_half_mark_whose_point_was_lost_is_suggested_not_stored(tmp_path, recognizer):
    """ "5 5" on a 10-mark question: 55 is illegal, 5.5 is legal. The
    field stays blank and flagged unmatched (so harvest still refuses it),
    with 5.5 offered."""
    result = _read(tmp_path, recognizer, ["5"], [["5", "5"]], [], maxes=[10.0])
    assert result.questions == [None]
    assert "q1" in result.unmatched_fields
    assert result.suggestions == {"q1": "5.5"}
    assert result.crossed_out_fields == []


def test_no_point_suggestion_when_the_half_mark_would_be_illegal_too(tmp_path, recognizer):
    """ "5 5" on a 5-mark question: neither 55 nor 5.5 is legal."""
    result = _read(tmp_path, recognizer, ["5"], [["5", "5"]], [])
    assert result.questions == [None]
    assert "q1" not in result.suggestions


def test_no_point_suggestion_when_a_point_was_already_found(tmp_path, recognizer):
    """The fallback is only for a point that went missing. "5 . 5 5" has
    one, in a place no legal value puts it, and stays a plain unmatched."""
    result = _read(tmp_path, recognizer, ["5"], [["5", ".", "5", "5"]], [], maxes=[10.0])
    assert result.questions == [None]
    assert "q1" not in result.suggestions


def test_a_lost_point_on_the_total_is_suggested_too(tmp_path, recognizer):
    result = _read(tmp_path, recognizer, ["5"], [["5"]], ["5", "5"], maxes=[10.0])
    assert result.total is None
    assert result.suggestions == {"total": "5.5"}
