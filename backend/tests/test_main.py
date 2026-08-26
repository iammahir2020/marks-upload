"""Step 4 tests (step.md step 4 Test section): TestClient, Gemini mocked.
The suite must not touch the network — only app.main.recognize (the one
function that calls Gemini) is ever mocked; detection and local ID OCR run
for real, since both are local and fast.
"""
import json
import sys
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.main import app  # noqa: E402
from app.marks import MarksResult  # noqa: E402

RATE_LIMITED_RESULT = MarksResult(status="failed", failure_reason="rate_limited")

client = TestClient(app)
TESTSET = Path(__file__).parent.parent.parent / "testset"

DEFAULT_CONFIG = {
    "quizName": "CSE211L Quiz 1",
    "idDigits": 7,
    "questions": [{"q": i, "max": 5.0} for i in range(1, 6)],
    "totalMax": 25.0,
}

FIXTURE_MARKS_RESULT = MarksResult(
    status="ok",
    serial="07",
    questions=[3.0, 2.5, 1.0, 0.0, 4.5],
    total=11.0,
    low_confidence_fields=[],
)


def _post(image_path: Path, config: dict = DEFAULT_CONFIG):
    with open(image_path, "rb") as f:
        return client.post(
            "/api/scan",
            files={"image": (image_path.name, f, "image/jpeg")},
            data={"config": json.dumps(config)},
        )


def _make_blank(path: Path):
    """Flat white — no lines at all, and low Laplacian variance: the
    detector should reject this as blurry, not table_not_found. Kept for
    the blurry-specific test."""
    img = np.full((700, 1000, 3), 255, dtype=np.uint8)
    cv2.imwrite(str(path), img)


def _make_noise(path: Path):
    """Random static — sharp (passes the blur check) but has no long
    straight lines anywhere, so no table rectangle can be found."""
    rng = np.random.default_rng(0)
    img = rng.integers(0, 255, (700, 1000, 3), dtype=np.uint8)
    cv2.imwrite(str(path), img)


def _make_wrong_column_count(path: Path, real_questions: int):
    """A real, well-formed grid — but drawn with fewer marks columns than
    the config will claim. Deterministic column_count_mismatch, unlike
    relying on noise to accidentally miscount a line."""
    img = np.full((700, 1000, 3), 255, dtype=np.uint8)

    def draw_table(x, y, col_widths, row_heights):
        xs = [x]
        for w in col_widths:
            xs.append(xs[-1] + w)
        ys = [y]
        for h in row_heights:
            ys.append(ys[-1] + h)
        for yy in ys:
            cv2.line(img, (x, yy), (x + sum(col_widths), yy), (0, 0, 0), 2)
        for xx in xs:
            cv2.line(img, (xx, y), (xx, y + sum(row_heights)), (0, 0, 0), 2)

    draw_table(60, 40, [110] + [55] * 7, [55])          # ID: label + 7 digits
    draw_table(60, 130, [110, 90], [55])                # Serial: label + value
    draw_table(60, 220, [90] * real_questions, [40, 110])  # Marks: fewer cols than config expects
    cv2.imwrite(str(path), img)


def test_table_not_found_never_calls_gemini(tmp_path):
    image_path = tmp_path / "noise.jpg"
    _make_noise(image_path)

    with patch("app.main.recognize") as mock_recognize:
        resp = _post(image_path)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["failure_reason"] == "table_not_found"
    mock_recognize.assert_not_called()


def test_blurry_never_calls_gemini(tmp_path):
    image_path = tmp_path / "blank.jpg"
    _make_blank(image_path)

    with patch("app.main.recognize") as mock_recognize:
        resp = _post(image_path)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["failure_reason"] == "blurry"
    mock_recognize.assert_not_called()


def test_column_count_mismatch_never_calls_gemini(tmp_path):
    image_path = tmp_path / "wrong_cols.jpg"
    _make_wrong_column_count(image_path, real_questions=4)  # config below expects 5

    with patch("app.main.recognize") as mock_recognize:
        resp = _post(image_path)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["failure_reason"] == "column_count_mismatch"
    mock_recognize.assert_not_called()


def test_known_good_image_matches_cli_values():
    """filled_file.jpeg's real values, per testset/labels.json and the
    live Gemini run cached in tests/fixtures/filled_file_gemini_response.json.
    read_id is mocked too — this test is about whether main.py wires the
    pipeline correctly, not whether Tesseract's calibration has drifted
    (that's id_ocr_accuracy.py's job)."""
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    with patch("app.main.recognize", return_value=FIXTURE_MARKS_RESULT) as mock_recognize, \
         patch("app.main.read_id", return_value=("2632711", [])) as mock_read_id:
        resp = _post(image_path)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["student_id"] == "2632711"
    assert body["serial"] == "07"
    assert [q["value"] for q in body["questions"]] == [3.0, 2.5, 1.0, 0.0, 4.5]
    assert body["total"]["value"] == 11.0
    assert body["low_confidence_fields"] == []
    mock_recognize.assert_called_once()
    mock_read_id.assert_called_once()


def test_two_consecutive_requests_do_not_influence_each_other():
    """Different configs, same image, back to back — the second request's
    result must not be contaminated by the first's temp output."""
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    config_a = dict(DEFAULT_CONFIG, questions=[{"q": i, "max": 5.0} for i in range(1, 6)])
    config_b = dict(DEFAULT_CONFIG, quizName="Different Quiz", idDigits=6)  # wrong idDigits on purpose

    with patch("app.main.recognize", return_value=FIXTURE_MARKS_RESULT):
        resp_a = _post(image_path, config_a)
        resp_b = _post(image_path, config_b)  # wrong idDigits -> should fail on its own terms
        resp_c = _post(image_path, config_a)  # back to the correct config

    assert resp_a.status_code == resp_b.status_code == resp_c.status_code == 200
    assert resp_a.json()["status"] == "ok"
    assert resp_b.json()["status"] == "failed"  # 6-digit config against a 7-digit ID table
    assert resp_c.json()["status"] == "ok"
    # resp_c must be identical to resp_a — not affected by resp_b's failure
    assert resp_c.json() == resp_a.json()


def test_rate_limited_falls_back_to_local_ocr():
    """When Gemini fails, main.py should try marks_ocr.recognize_locally
    before giving up — a rate-limited session shouldn't force the
    instructor to hand-type every field for every remaining script."""
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    fallback_result = MarksResult(
        status="ok",
        serial="07",
        questions=[3.0, None, 1.0, 0.0, 4.5],
        total=11.0,
        low_confidence_fields=["serial", "q1", "q2", "q3", "q4", "q5", "total"],
    )

    with patch("app.main.recognize", return_value=RATE_LIMITED_RESULT), \
         patch("app.main.recognize_locally", return_value=fallback_result) as mock_fallback, \
         patch("app.main.read_id", return_value=("2632711", [])):
        resp = _post(image_path)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["serial"] == "07"
    assert [q["value"] for q in body["questions"]] == [3.0, None, 1.0, 0.0, 4.5]
    # every fallback field is flagged, per marks_ocr.py's design — the
    # instructor should double-check all of it, not just the blank q2
    assert set(body["low_confidence_fields"]) >= {"serial", "q2", "total"}
    mock_fallback.assert_called_once()


def test_rate_limited_with_nothing_recoverable_still_fails_honestly():
    """If the local fallback can't recover anything either, this must
    still surface as a failed scan with the original reason — not a
    deceptively normal-looking "ok" result that's just all blank."""
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    with patch("app.main.recognize", return_value=RATE_LIMITED_RESULT), \
         patch("app.main.recognize_locally", return_value=None) as mock_fallback:
        resp = _post(image_path)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["failure_reason"] == "rate_limited"
    mock_fallback.assert_called_once()
