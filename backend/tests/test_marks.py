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

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.detection import detect  # noqa: E402
from app.marks import (  # noqa: E402
    ScanPayload,
    build_composite,
    check_blocked,
    legal_values,
    validate_payload,
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
