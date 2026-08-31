"""read_digit's two-pass fallback (step 2, issues.md #3).

No Tesseract binary required: `_best_candidate` is stubbed, because the
subject here is the ACCEPTANCE LOGIC around the two passes, not Tesseract's
own reading. That distinction is the whole finding — the fallback was built
for one measured failure mode and only ever exercised against it.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import id_ocr  # noqa: E402
from app.id_ocr import CONFIDENCE_FLOOR, FALLBACK_CONFIDENCE_FLOOR  # noqa: E402


@pytest.fixture
def two_passes(monkeypatch):
    """Stub the whitelist pass and the fallback pass independently."""
    def install(whitelist_result, fallback_result):
        calls = {"n": 0}

        def fake(_prepared, config):
            calls["n"] += 1
            return whitelist_result if "whitelist" in config else fallback_result

        monkeypatch.setattr(id_ocr, "_best_candidate", fake)
        monkeypatch.setattr(id_ocr, "_prepare", lambda crop: crop)
    return install


CROP = np.zeros((40, 40, 3), dtype=np.uint8)


def test_a_confident_whitelist_read_is_taken_directly(two_passes):
    two_passes(("7", CONFIDENCE_FLOOR + 10), (None, -1.0))
    assert id_ocr.read_digit(CROP)[0] == "7"


def test_a_digit_read_by_the_FALLBACK_pass_is_accepted(two_passes):
    """The finding, in one test.

    The whitelist pass scores below CONFIDENCE_FLOOR, so the fallback runs
    and reads the crop correctly — as the actual digit — well above
    FALLBACK_CONFIDENCE_FLOOR. The old check was `fallback_text in
    DIGIT_LOOKALIKES`, whose keys are all LETTERS, so this fell through to
    `return None` and a correct, confident read was thrown away as "?".
    """
    two_passes(("7", CONFIDENCE_FLOOR - 5), ("7", FALLBACK_CONFIDENCE_FLOOR + 10))
    digit, conf = id_ocr.read_digit(CROP)
    assert digit == "7"
    assert conf >= FALLBACK_CONFIDENCE_FLOOR


@pytest.mark.parametrize("letter, digit", [("D", "0"), ("l", "1"), ("S", "5"), ("B", "8")])
def test_the_measured_lookalike_cases_still_map(two_passes, letter, digit):
    # The case the fallback was originally built for — a real "0" read as
    # "D" at 86%, a real "1" read as "l" at 90% — must keep working.
    two_passes((None, -1.0), (letter, FALLBACK_CONFIDENCE_FLOOR + 5))
    assert id_ocr.read_digit(CROP)[0] == digit


def test_a_low_confidence_fallback_is_still_refused(two_passes):
    # Widening what the fallback ACCEPTS must not widen how confident it
    # has to be. Flag, never guess.
    two_passes((None, -1.0), ("7", FALLBACK_CONFIDENCE_FLOOR - 1))
    assert id_ocr.read_digit(CROP)[0] is None


def test_an_unmappable_letter_is_still_refused(two_passes):
    two_passes((None, -1.0), ("x", FALLBACK_CONFIDENCE_FLOOR + 20))
    assert id_ocr.read_digit(CROP)[0] is None


def test_a_multi_character_fallback_is_refused(two_passes):
    two_passes((None, -1.0), ("77", FALLBACK_CONFIDENCE_FLOOR + 20))
    assert id_ocr.read_digit(CROP)[0] is None
