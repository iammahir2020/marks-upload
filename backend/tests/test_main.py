"""Step 4 tests (step.md step 4 Test section): TestClient, Gemini mocked.
The suite must not touch the network — only app.marks.recognize (the one
function that calls Gemini) is ever mocked; detection and local ID OCR run
for real, since both are local and fast.

Since step.md step 2r.0, main.py calls recognition only through the
Recognizer protocol (app/recognizers/), so these mocks patch the
underlying modules (app.marks, app.id_ocr, app.marks_ocr) directly rather
than app.main — main.py no longer imports those names itself, it goes
through RemoteRecognizer, which references them by module attribute for
exactly this reason.
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
import app.main as main_module  # noqa: E402
from app.main import app  # noqa: E402
from app.marks import MarksResult  # noqa: E402
from app.recognizers.remote import RemoteRecognizer  # noqa: E402

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


@pytest.fixture
def force_remote_recognizer(monkeypatch):
    """These tests mock app.marks.recognize / app.id_ocr.read_id /
    app.marks_ocr.recognize_locally, which only has any effect if
    RemoteRecognizer is the recognizer main.py actually calls through —
    pin it explicitly so these tests stay correct regardless of whatever
    RECOGNIZER env var (or main.py's own default) happens to be set
    to when the suite runs."""
    monkeypatch.setattr(main_module, "recognizer", RemoteRecognizer())


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


@pytest.mark.parametrize(
    "make_image, expected_reason",
    [
        (_make_noise, "table_not_found"),
        (_make_blank, "blurry"),
        (lambda p: _make_wrong_column_count(p, real_questions=4), "column_count_mismatch"),
    ],
)
def test_detection_failure_never_calls_recognizer(tmp_path, make_image, expected_reason):
    """No recognizer is ever reached after a detection failure (step.md
    step 2r.0.4) — parameterized rather than duplicated per failure reason,
    since the property is about the pipeline's early exit and applies the
    same way regardless of which Recognizer implementation is selected.
    Asserted against app.marks.recognize (the one network call either path
    could reach) rather than a specific Recognizer method, so this stays
    true unchanged once a second (CNN) implementation exists."""
    image_path = tmp_path / "image.jpg"
    make_image(image_path)

    with patch("app.marks.recognize") as mock_recognize:
        resp = _post(image_path)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["failure_reason"] == expected_reason
    mock_recognize.assert_not_called()


def test_known_good_image_matches_cli_values(force_remote_recognizer):
    """filled_file.jpeg's real values, per testset/labels.json and the
    live Gemini run cached in tests/fixtures/filled_file_gemini_response.json.
    read_id is mocked too — this test is about whether main.py wires the
    pipeline correctly, not whether Tesseract's calibration has drifted
    (that's id_ocr_accuracy.py's job)."""
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    with patch("app.marks.recognize", return_value=FIXTURE_MARKS_RESULT) as mock_recognize, \
         patch("app.id_ocr.read_id", return_value=("2632711", [])) as mock_read_id:
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


def test_two_consecutive_requests_do_not_influence_each_other(force_remote_recognizer):
    """Different configs, same image, back to back — the second request's
    result must not be contaminated by the first's temp output."""
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    config_a = dict(DEFAULT_CONFIG, questions=[{"q": i, "max": 5.0} for i in range(1, 6)])
    config_b = dict(DEFAULT_CONFIG, quizName="Different Quiz", idDigits=6)  # wrong idDigits on purpose

    with patch("app.marks.recognize", return_value=FIXTURE_MARKS_RESULT):
        resp_a = _post(image_path, config_a)
        resp_b = _post(image_path, config_b)  # wrong idDigits -> should fail on its own terms
        resp_c = _post(image_path, config_a)  # back to the correct config

    assert resp_a.status_code == resp_b.status_code == resp_c.status_code == 200
    assert resp_a.json()["status"] == "ok"
    assert resp_b.json()["status"] == "failed"  # 6-digit config against a 7-digit ID table
    assert resp_c.json()["status"] == "ok"
    # resp_c must be identical to resp_a — not affected by resp_b's failure
    assert resp_c.json() == resp_a.json()


def test_rate_limited_falls_back_to_local_ocr(force_remote_recognizer):
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

    with patch("app.marks.recognize", return_value=RATE_LIMITED_RESULT), \
         patch("app.marks_ocr.recognize_locally", return_value=fallback_result) as mock_fallback, \
         patch("app.id_ocr.read_id", return_value=("2632711", [])):
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


def test_rate_limited_with_nothing_recoverable_still_fails_honestly(force_remote_recognizer):
    """If the local fallback can't recover anything either, this must
    still surface as a failed scan with the original reason — not a
    deceptively normal-looking "ok" result that's just all blank."""
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    with patch("app.marks.recognize", return_value=RATE_LIMITED_RESULT), \
         patch("app.marks_ocr.recognize_locally", return_value=None) as mock_fallback:
        resp = _post(image_path)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["failure_reason"] == "rate_limited"
    mock_fallback.assert_called_once()


# --- issues.md #8: a bad config is a 400, not a 500 -----------------------


@pytest.mark.parametrize(
    "bad_config, expect",
    [
        ("not json at all", "config"),
        ('{"quizName":"q","idDigits":7,"questions":[{"q":1,"max":1e9}],"totalMax":1000000000}', "config"),
        ('{"quizName":"q","idDigits":7,"questions":[{"q":2,"max":5},{"q":1,"max":5}],"totalMax":10}', "order"),
        ('{"quizName":"q","idDigits":7,"questions":[{"q":1,"max":5},{"q":2,"max":5}],"totalMax":25}', "totalmax"),
        ('{"quizName":"q","idDigits":99999,"questions":[{"q":1,"max":5}],"totalMax":5}', "config"),
    ],
)
def test_a_bad_config_is_rejected_as_a_client_error(tmp_path, bad_config, expect):
    """A pydantic.ValidationError raised inside a route body has no default
    handler, so every one of these used to surface as a bare 500 — including
    the new N2/#10/#14 rules, whose whole point is telling a caller what is
    wrong with their config."""
    image_path = tmp_path / "image.jpg"
    _make_noise(image_path)
    with open(image_path, "rb") as fh:
        response = client.post(
            "/api/scan",
            files={"image": ("scan.jpg", fh, "image/jpeg")},
            data={"config": bad_config},
        )
    assert response.status_code == 400, response.text
    assert expect in response.json()["detail"].lower()


def test_a_good_config_is_still_accepted(tmp_path):
    """The bounds and cross-field rules must not reject an ordinary quiz.
    Detection fails on this noise image, which is fine — the point is that
    it got past validation to reach detection at all."""
    image_path = tmp_path / "image.jpg"
    _make_noise(image_path)
    with open(image_path, "rb") as fh:
        response = client.post(
            "/api/scan",
            files={"image": ("scan.jpg", fh, "image/jpeg")},
            data={"config": '{"quizName":"q","idDigits":7,'
                            '"questions":[{"q":1,"max":5},{"q":2,"max":5}],"totalMax":10}'},
        )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "failed"
