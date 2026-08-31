"""Step 3's unit-testable core (step.md step 3 Test section) — no network,
no API key. These are the ones that matter most:

- legal-value rejection (7 on a 5-mark question, 4.25, -1, None)
- the ID-exclusion assertion (step 3.1)
- block/finish-reason handling on a mocked response
"""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import numpy as np
import cv2

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.detection import detect  # noqa: E402
from app.marks import (  # noqa: E402
    MAX_SERIAL_DIGITS,
    ScanPayload,
    build_composite,
    build_prompt,
    check_blocked,
    legal_values,
    validate_payload,
    validate_serial,
)

TESTSET = Path(__file__).parent.parent.parent / "testset"
QUESTION_MAXES = [5.0, 5.0, 5.0, 5.0, 5.0]


def test_legal_values_half_mark_steps():
    assert legal_values(5.0) == {0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0}


@pytest.mark.parametrize("bad_value", [7.0, 4.25, -1.0])
def test_validate_payload_rejects_illegal_values(bad_value):
    payload = ScanPayload(serial="07", questions=[bad_value, 3.0, 3.0, 3.0, 3.0], total=15.0)
    result = validate_payload(payload, QUESTION_MAXES)
    assert result.questions[0] is None
    assert "q1" in result.low_confidence_fields
    # untouched questions still pass through
    assert result.questions[1] == 3.0


def test_validate_payload_rejects_none():
    payload = ScanPayload(serial="07", questions=[None, 3.0, 3.0, 3.0, 3.0], total=12.0)
    result = validate_payload(payload, QUESTION_MAXES)
    assert result.questions[0] is None
    assert "q1" in result.low_confidence_fields


def test_validate_payload_accepts_legal_half_marks():
    payload = ScanPayload(serial="07", questions=[3.0, 2.5, 1.0, 0.0, 4.5], total=11.0)
    result = validate_payload(payload, QUESTION_MAXES)
    assert result.questions == [3.0, 2.5, 1.0, 0.0, 4.5]
    assert result.total == 11.0
    assert result.low_confidence_fields == []


def test_validate_payload_rejects_illegal_total():
    # legal totals for 5x5 are 0, 0.5, ..., 25 — 25.3 is not one of them
    payload = ScanPayload(serial="07", questions=[5.0, 5.0, 5.0, 5.0, 5.0], total=25.3)
    result = validate_payload(payload, QUESTION_MAXES)
    assert result.total is None
    assert "total" in result.low_confidence_fields


def test_validate_payload_flags_missing_serial():
    payload = ScanPayload(serial=None, questions=[3.0, 2.5, 1.0, 0.0, 4.5], total=11.0)
    result = validate_payload(payload, QUESTION_MAXES)
    assert "serial" in result.low_confidence_fields


def test_build_composite_never_includes_id_crop(tmp_path):
    """The privacy property as a real test, not a read of the code
    (step.md 3.1) — run real detection, then confirm the composite it
    builds is provably free of any id_d*.png."""
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    result = detect(image_path, questions=5, id_digits=7, out_dir=tmp_path)
    assert result["status"] == "ok"

    cells_dir = tmp_path / "cells"
    id_crops_before = sorted(p.name for p in cells_dir.glob("id_d*.png"))
    assert id_crops_before, "sanity check: id crops should exist in cells_dir"

    composite, labels = build_composite(cells_dir, questions=5)
    assert composite is not None
    # labels must be exactly serial + Q1..Q5 + Total — never an id label
    assert labels == ["serial", "Q1", "Q2", "Q3", "Q4", "Q5", "Total"]
    assert all("id" not in label.lower() for label in labels)


def test_check_blocked_flags_empty_response():
    response = SimpleNamespace(prompt_feedback=None, candidates=[], parsed=None)
    assert check_blocked(response) == "model_error"


def test_check_blocked_flags_safety_block():
    from google.genai import types

    response = SimpleNamespace(
        prompt_feedback=SimpleNamespace(block_reason=types.BlockedReason.SAFETY),
        candidates=[],
        parsed=None,
    )
    assert check_blocked(response) == "model_error"


def test_check_blocked_flags_non_stop_finish_reason():
    from google.genai import types

    response = SimpleNamespace(
        prompt_feedback=None,
        candidates=[SimpleNamespace(finish_reason=types.FinishReason.SAFETY)],
        parsed=None,
    )
    assert check_blocked(response) == "model_error"


def test_check_blocked_passes_clean_response():
    from google.genai import types

    response = SimpleNamespace(
        prompt_feedback=None,
        candidates=[SimpleNamespace(finish_reason=types.FinishReason.STOP)],
        parsed=ScanPayload(serial="07", questions=[3.0, 2.5, 1.0, 0.0, 4.5], total=11.0),
    )
    assert check_blocked(response) is None


# --- issues.md N21: the serial gets checked like everything else ----------


@pytest.mark.parametrize("bad", ["abc", "1.5", "-1", "", "   ", "12345", "7a", "../x"])
def test_a_serial_that_is_not_a_serial_is_blanked_and_flagged(bad):
    # It had NO check: every mark went through legal_values, the serial went
    # through nothing, so whatever Gemini returned reached ScanResult, the
    # review screen, IndexedDB, the Excel export and /api/harvest's key path.
    result = validate_payload(
        ScanPayload(serial=bad, questions=[4.0], total=4.0), [5.0]
    )
    assert result.serial is None
    assert "serial" in result.low_confidence_fields


@pytest.mark.parametrize("good, expected", [("7", "7"), ("07", "07"), ("1234", "1234"), (" 22 ", "22")])
def test_a_real_serial_survives_with_its_leading_zeros(good, expected):
    # "07" is what is written on the paper. Stripping leading zeros is
    # validateMarks.ts's normalizeSerial at comparison time, not this
    # function's job — the harvested crop label has to match the picture.
    result = validate_payload(
        ScanPayload(serial=good, questions=[4.0], total=4.0), [5.0]
    )
    assert result.serial == expected
    assert "serial" not in result.low_confidence_fields


def test_validate_serial_matches_the_frontend_rule():
    # The other half is validateMarks.ts's isValidSerial. Same length bound,
    # same digits-only rule — see MAX_SERIAL_DIGITS in both files.
    assert MAX_SERIAL_DIGITS == 4
    assert validate_serial("9999") == "9999"
    assert validate_serial("10000") is None


# --- issues.md #9: the composite and the prompt must agree ----------------


def _fake_cells(tmp_path, names):
    cells = tmp_path / "cells"
    cells.mkdir()
    blank = np.full((40, 40, 3), 255, dtype=np.uint8)
    for name in names:
        cv2.imwrite(str(cells / name), blank)
    return cells


def test_a_missing_mark_crop_fails_instead_of_shifting_every_later_tile(tmp_path):
    """build_prompt unconditionally describes all N questions plus the
    total. If a crop is missing, the composite has fewer tiles than the
    prompt describes, so every tile after the gap means something else —
    and Gemini can return a confident, legal-looking value for a question
    it was never shown. validate_payload cannot catch that; it range-checks
    a value, it cannot know the picture lacked the question."""
    cells = _fake_cells(tmp_path, ["serial.png", "marks_r1_c0.png", "marks_r1_c2.png"])
    composite, labels = build_composite(cells, questions=2)
    assert composite is None
    assert labels == []


def test_a_missing_serial_crop_also_fails(tmp_path):
    cells = _fake_cells(tmp_path, ["marks_r1_c0.png", "marks_r1_c1.png", "marks_r1_c2.png"])
    assert build_composite(cells, questions=2)[0] is None


def test_a_complete_set_of_tiles_still_builds(tmp_path):
    cells = _fake_cells(
        tmp_path, ["serial.png", "marks_r1_c0.png", "marks_r1_c1.png", "marks_r1_c2.png"]
    )
    composite, labels = build_composite(cells, questions=2)
    assert composite is not None
    assert labels == ["serial", "Q1", "Q2", "Total"]


def test_the_tile_count_matches_what_build_prompt_describes(tmp_path):
    """The two halves of the pair, asserted against each other rather than
    against a hardcoded number."""
    maxes = [5.0, 5.0, 5.0]
    cells = _fake_cells(
        tmp_path,
        ["serial.png"] + [f"marks_r1_c{c}.png" for c in range(len(maxes) + 1)],
    )
    _, labels = build_composite(cells, questions=len(maxes))
    prompt = build_prompt(maxes)
    for label in labels:
        if label != "serial":
            assert f'"{label}"' in prompt


# --- issues.md #13: one client, not one per request -----------------------


def test_the_genai_client_is_built_once_and_reused(monkeypatch):
    """It was constructed per request — wasted setup on the slowest stage
    of the pipeline, across dozens of scans in a class."""
    import app.marks as marks_module

    monkeypatch.setattr(marks_module, "_client", None)
    built = {"n": 0}

    class FakeClient:
        def __init__(self):
            built["n"] += 1

    fake_genai = SimpleNamespace(Client=FakeClient)
    monkeypatch.setitem(sys.modules, "google", SimpleNamespace(genai=fake_genai))
    monkeypatch.setitem(sys.modules, "google.genai", fake_genai)

    first = marks_module._get_client()
    second = marks_module._get_client()

    assert built["n"] == 1
    assert first is second

    monkeypatch.setattr(marks_module, "_client", None)
