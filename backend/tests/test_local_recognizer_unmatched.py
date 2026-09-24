"""issues.md N31/N33: CNNRecognizer's `_decode_value_cell` distinguishes a
genuinely blank cell from one with ink that matched no legal value. Uses
the real trained model (`cnn/checkpoints/digit_cnn.onnx`, committed) and a
synthetic cell image built the same way `test_cnn_segment.py` does — the
one deliberate shortcut is forcing `legal_vals=set()`, so `decode_value`
can never find a candidate regardless of what the model reads. That keeps
this test about the had-ink/no-ink distinction, not about digit accuracy,
which `cnn/marks_accuracy.py` already measures against real photos.
"""
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.recognizers.local import DEFAULT_MODEL_PATH, CNNRecognizer  # noqa: E402

CELL_H, CELL_W = 120, 160


def _blank_cell() -> np.ndarray:
    return np.full((CELL_H, CELL_W, 3), 255, dtype=np.uint8)


def _inked_cell() -> np.ndarray:
    """One thin vertical stroke — a plain "1". This was a solid filled
    rectangle until step 15, which is exactly what a heavily scribbled-out
    glyph looks like: once the model gained a CROSSED_OUT class, that ink
    could route to crossed_out_fields instead of unmatched_fields, and
    these tests would fail for a reason unrelated to what they check."""
    img = _blank_cell()
    cv2.line(img, (80, 30), (80, 90), (0, 0, 0), 6)
    return img


@pytest.fixture
def recognizer():
    if not DEFAULT_MODEL_PATH.exists():
        pytest.skip("no trained model at cnn/checkpoints/digit_cnn.onnx")
    return CNNRecognizer()


def test_blank_cell_has_no_ink(tmp_path, recognizer):
    path = tmp_path / "marks_r1_c0.png"
    cv2.imwrite(str(path), _blank_cell())
    read = recognizer._decode_value_cell(path, legal_vals=set())
    assert read.value is None
    assert read.had_ink is False


def test_inked_cell_with_no_legal_candidate_has_ink(tmp_path, recognizer):
    """The N31 case in miniature: something was written (a real glyph
    segments out), but there is nothing it could legally match — here
    because `legal_values` is deliberately empty, in the real app because
    the ink is a digit outside the question's range. Either way the
    field must be marked `had_ink=True` so N31's harvest refusal fires."""
    path = tmp_path / "marks_r1_c0.png"
    cv2.imwrite(str(path), _inked_cell())
    read = recognizer._decode_value_cell(path, legal_vals=set())
    assert read.value is None
    assert read.had_ink is True
    assert read.crossed_out is False


def test_missing_crop_file_has_no_ink(tmp_path, recognizer):
    """A missing file is the pre-existing "?"/None case, not the N31
    case — nothing to mislabel, so had_ink must stay False."""
    read = recognizer._decode_value_cell(tmp_path / "does_not_exist.png", legal_vals=set())
    assert read.value is None
    assert read.had_ink is False


def test_read_marks_reports_unmatched_fields_for_an_inked_no_match_cell(tmp_path, recognizer, monkeypatch):
    """End to end through read_marks: an inked, unmatchable q1 lands in
    both low_confidence_fields (existing behaviour) AND unmatched_fields
    (N31's new signal); a genuinely blank q2 lands in neither.

    `legal_values` is monkeypatched to always return an empty set — the
    same deterministic "no candidate could ever match" trick used above,
    so this test is about read_marks correctly ASSEMBLING both lists, not
    about whether the real model happens to misread a specific stroke.

    Patched via `read_marks.__globals__` rather than
    `monkeypatch.setattr(app.recognizers.local, ...)`: `test_cnn_preprocess
    .py`'s `test_the_app_does_not_import_the_accuracy_harness` pops
    `app.recognizers.local` from `sys.modules` and re-imports it fresh
    (issues.md N16's own regression test), which — when that test runs
    earlier in the same session — leaves `sys.modules['app.recognizers.
    local']` pointing at a DIFFERENT module object than the one this
    file's `CNNRecognizer` was already bound to at collection time.
    Patching by name then silently patches the wrong module's globals.
    `__globals__` is the actual dict the method's code runs against, so
    it is correct regardless of what sys.modules holds by then."""
    monkeypatch.setitem(CNNRecognizer.read_marks.__globals__, "legal_values", lambda max_mark: set())

    cells_dir = tmp_path / "cells"
    cells_dir.mkdir()
    cv2.imwrite(str(cells_dir / "marks_r1_c0.png"), _inked_cell())
    cv2.imwrite(str(cells_dir / "marks_r1_c1.png"), _blank_cell())
    cv2.imwrite(str(cells_dir / "marks_r1_c2.png"), _blank_cell())  # total

    result = recognizer.read_marks(cells_dir, question_maxes=[5.0, 5.0])

    assert "q1" in result.unmatched_fields
    assert "q2" not in result.unmatched_fields
    assert "q1" in result.low_confidence_fields
    assert "q2" in result.low_confidence_fields  # still flagged (blank), just not "unmatched"
    assert "total" not in result.unmatched_fields  # blank total, same as q2
