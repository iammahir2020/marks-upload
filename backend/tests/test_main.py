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
import os
import subprocess
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


def _tesseract_available() -> bool:
    """Most of the `remote`-path tests mock `app.id_ocr.read_id` and so
    need no binary at all. Two of them deliberately do not — they are
    about main.py's own wiring around a real ID read — and those cannot
    run without the Tesseract program itself, which is a separate install
    from the pip wrapper and is genuinely optional now that `cnn` is the
    default recognizer (CLAUDE.md, step 3r.6e).

    Skipping is the honest outcome there, the same as the existing
    `filled_file.jpeg not present` skips in this file: the test has
    nothing to say on a machine where the thing it exercises isn't
    installed. Failing instead would mean the suite reports a broken app
    on a correctly-configured default install."""
    from app.id_ocr import tesseract_missing_message

    return tesseract_missing_message() is None


requires_tesseract = pytest.mark.skipif(
    not _tesseract_available(),
    reason="the tesseract binary is not installed (only needed on RECOGNIZER=remote)",
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


@requires_tesseract
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


@requires_tesseract
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


# --- X-Ray tracing (step 11.8) ----------------------------------------------

def _xray_sdk_available() -> bool:
    try:
        import aws_xray_sdk  # noqa: F401
    except ImportError:
        return False
    return True


requires_xray_sdk = pytest.mark.skipif(
    not _xray_sdk_available(),
    reason="aws-xray-sdk is deploy-only (requirements-deploy.txt), not installed here",
)


def test_xray_disabled_by_default_no_import_needed():
    """The load-bearing property for this whole feature: XRAY_ENABLED is
    False unless a deployment sets it, and the middleware's very first
    line returns before touching `aws_xray_sdk` at all — so a laptop that
    has never even run `pip install -r requirements-deploy.txt` (i.e. every
    laptop, by design) can still run a scan. Needs no skip marker, because
    proving this works WITHOUT the package installed is the actual point;
    skipping it when the package is absent would test nothing."""
    assert main_module.config_module.XRAY_ENABLED is False
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")
    with patch("app.marks.recognize", return_value=FIXTURE_MARKS_RESULT), \
         patch("app.id_ocr.read_id", return_value=("2632711", [])):
        resp = _post(image_path)
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@requires_xray_sdk
def test_xray_enabled_never_breaks_a_scan_even_with_no_lambda_context(monkeypatch):
    """The real-world failure mode this guards against: XRAY_ENABLED=true
    with no actual Lambda invocation underneath it — exactly what would
    happen if the flag were ever accidentally set on local-stack.sh's
    container (which runs the deployed image via `docker run`, not a real
    Lambda `Invoke`) rather than only on the true Lambda function's own
    environment, where deploy.sh is the only thing that sets it.

    `aws_xray_sdk.begin_subsegment()` has no parent segment to attach to
    in that situation — verified directly against the installed SDK
    (log_event's own "cannot find the current segment" warning is the
    SDK's own logger, not this codebase's) — and returns None rather than
    raising. `trace`'s None-guards handle that already; this test is the
    end-to-end proof that a real request through TestClient still
    completes and returns a normal 200, not a 500, regardless."""
    monkeypatch.setattr(main_module.config_module, "XRAY_ENABLED", True)
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")
    with patch("app.marks.recognize", return_value=FIXTURE_MARKS_RESULT), \
         patch("app.id_ocr.read_id", return_value=("2632711", [])):
        resp = _post(image_path)
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@requires_xray_sdk
def test_xray_traces_a_request_that_guard_rejects(monkeypatch):
    """`trace` is registered LAST so Starlette makes it OUTERMOST, wrapping
    `guard` — so a request guard rejects with 413 still gets a real,
    correctly-statused trace instead of vanishing from the map.

    Asserted by spying on `begin_subsegment`, NOT by the response status.
    That distinction is the whole point and was got wrong first time: a
    413 comes back either way — if `guard` were outermost it would reject
    before `trace` ever ran, and the status assertion alone would still
    pass, pinning nothing. What only holds in the correct order is that
    the subsegment gets opened at all, and that it records 413 rather than
    the 200 the route would have returned."""
    monkeypatch.setattr(main_module.config_module, "XRAY_ENABLED", True)
    monkeypatch.setattr(main_module.config_module, "MAX_UPLOAD_BYTES", 10)
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    from aws_xray_sdk.core import xray_recorder

    opened: list[str] = []
    statuses: list[int] = []

    class _SpySegment:
        def put_http_meta(self, key, value):
            if key == "status":
                statuses.append(value)

        def add_exception(self, *a, **kw):
            pass

    def _spy_begin(name):
        opened.append(name)
        return _SpySegment()

    monkeypatch.setattr(xray_recorder, "begin_subsegment", _spy_begin)
    monkeypatch.setattr(xray_recorder, "end_subsegment", lambda *a, **kw: None)

    resp = _post(image_path)

    assert resp.status_code == 413
    # The discriminating assertions: both are false if guard wraps trace.
    assert opened == ["/api/scan"], "trace did not run — guard rejected first, so it is outermost"
    assert statuses == [413], f"trace recorded {statuses}, not the guard's real 413"


@requires_xray_sdk
def test_xray_enabled_does_not_force_boto3_to_import_at_cold_start():
    """The real incident (step 11.8, 2026-09-22): the first version of
    this feature called `aws_xray_sdk.core.patch(("boto3",))` eagerly at
    module import time, guarded only by XRAY_ENABLED. That call forces
    `botocore` to import immediately to have something to monkey-patch —
    and `botocore` alone added ~7s to `import app.main`, on top of an
    already-heavy chain (opencv, onnxruntime). In the real deployed
    Lambda that pushed cold-start init past the platform's ~10s
    init-phase timeout, and EVERY request broke, not just ones that
    touch S3 — confirmed directly in production logs
    (`INIT_REPORT ... Status: timeout`, then `app is not ready` forever).

    Fixed by moving the patch call to the one place boto3 itself is
    actually imported — `S3Store.__init__`, lazily, per /api/harvest
    request — so a plain `/api/scan` request, which never touches S3,
    pays nothing extra for X-Ray being enabled.

    A subprocess, not a direct `sys.modules` check, on purpose: this test
    runs inside the same pytest process as `test_stores.py`'s
    `stubbed_boto3` fixture and others that legitimately put `boto3`/
    `botocore` into `sys.modules` for their own tests — a same-process
    check would be a coin flip on test ORDER, not a real assertion. A
    fresh interpreter is the only way to observe cold-start import
    behaviour without inheriting whatever the rest of the suite already
    touched.
    """
    backend_dir = Path(__file__).parent.parent
    script = (
        "import sys; sys.path.insert(0, %r); "
        "import app.main; "
        "print('boto3=' + str('boto3' in sys.modules)); "
        "print('botocore=' + str('botocore' in sys.modules))"
    ) % str(backend_dir)
    env = {**os.environ, "XRAY_ENABLED": "true"}
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True, text=True, timeout=30, env=env,
    )
    assert result.returncode == 0, result.stderr
    assert "boto3=False" in result.stdout, result.stdout
    assert "botocore=False" in result.stdout, result.stdout


@requires_xray_sdk
def test_xray_syncs_the_trace_env_var_from_the_incoming_header(monkeypatch):
    """The second real incident (step 11.8): every subsegment this
    middleware opened was silently discarded in the real deployed Lambda,
    on every request, because aws-xray-sdk's Lambda-context detection
    re-reads `_X_AMZN_TRACE_ID` from the environment, and Lambda Web
    Adapter forks uvicorn once at cold start — the forked child's
    environment is a private copy from that moment, never refreshed per
    invocation the way Lambda updates the platform process's own. Fixed
    by copying the fresh per-request `X-Amzn-Trace-Id` HTTP header (which
    LWA does forward correctly, on every call) into the environment
    before asking the recorder for a subsegment.

    This cannot be tested end-to-end without a real Lambda Web Adapter
    fork — that part is only verifiable against the real deployment,
    which it was (see CLAUDE.md's step 11.8 account). What IS testable
    and deterministic: that the header, when present, actually lands in
    `os.environ['_X_AMZN_TRACE_ID']` before the recorder is asked for
    anything — the one part of this fix that is this codebase's own
    responsibility rather than the platform's."""
    monkeypatch.setattr(main_module.config_module, "XRAY_ENABLED", True)
    monkeypatch.delenv("_X_AMZN_TRACE_ID", raising=False)
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    fake_trace_header = "Root=1-00000000-000000000000000000000000;Parent=0000000000000000;Sampled=1"
    with open(image_path, "rb") as f:
        resp = client.post(
            "/api/scan",
            files={"image": (image_path.name, f, "image/jpeg")},
            data={"config": json.dumps(DEFAULT_CONFIG)},
            headers={"X-Amzn-Trace-Id": fake_trace_header},
        )
    assert resp.status_code == 200
    # The middleware's `finally` ends the subsegment but does not clear
    # the env var it set — matching real Lambda behaviour, where the
    # platform itself owns clearing/replacing it between invocations, not
    # application code.
    assert os.environ.get("_X_AMZN_TRACE_ID") == fake_trace_header
