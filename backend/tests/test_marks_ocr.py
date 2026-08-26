"""Tests for the local rate_limited/model_error fallback (marks_ocr.py).
No network, no Gemini — this module never touches either."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.marks_ocr import _parse_legal_mark, recognize_locally  # noqa: E402


def test_parse_legal_mark_accepts_a_legal_half_mark():
    assert _parse_legal_mark("4.5", 5.0) == 4.5


def test_parse_legal_mark_rejects_a_value_above_max():
    assert _parse_legal_mark("7", 5.0) is None


def test_parse_legal_mark_rejects_unparseable_text():
    assert _parse_legal_mark("4,5", 5.0) is None
    assert _parse_legal_mark("", 5.0) is None
    assert _parse_legal_mark(None, 5.0) is None


def test_recognize_locally_returns_none_when_nothing_is_recoverable(tmp_path):
    # An empty cells_dir — no serial.png, no marks_r1_c*.png at all.
    assert recognize_locally(tmp_path, [5.0, 5.0, 5.0]) is None
