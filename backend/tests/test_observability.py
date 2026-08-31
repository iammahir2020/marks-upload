"""Structured logging, and the privacy property it must not break.

Step 11.7.3 requires that no recognised student ID and no image bytes ever
reach CloudWatch. Logging is the easiest way in the whole codebase to
violate that — one `logger.info(result)` while debugging and every scan's
ID sits in a log group for a month — so the important test here reads the
ACTUAL emitted output of a real scan and looks for the known ID, rather
than reviewing the call sites and trusting them.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import observability as obs  # noqa: E402
from app.main import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

TESTSET = Path(__file__).parent.parent.parent / "testset"

# The real, known contents of filled_file.jpeg — what must NOT appear.
KNOWN_STUDENT_ID = "2632711"

CONFIG = {
    "quizName": "observability",
    "idDigits": 7,
    "questions": [{"q": i, "max": 5.0} for i in range(1, 6)],
    "totalMax": 25.0,
}


# --- The scrubber ----------------------------------------------------------

def test_denied_keys_are_dropped_whatever_is_passed(capsys):
    obs.log_event("scan", status="ok", student_id="2632711", serial="07", total=11.0)
    line = json.loads(capsys.readouterr().out.strip())
    assert line["status"] == "ok"
    for leaked in ("student_id", "serial", "total"):
        assert leaked not in line


def test_a_long_digit_run_inside_a_string_is_redacted(capsys):
    """The denylist only catches keys someone thought of. This catches an
    ID smuggled inside a message, a path, or an exception string."""
    obs.log_event("scan", failure_reason="could not read 2632711 from /tmp/x")
    out = capsys.readouterr().out
    assert KNOWN_STUDENT_ID not in out
    assert obs.REDACTED in out


def test_nested_structures_are_scrubbed_too(capsys):
    obs.log_event("scan", detail={"student_id": "2632711", "note": "id 2632711 unreadable"})
    out = capsys.readouterr().out
    assert KNOWN_STUDENT_ID not in out


def test_short_numbers_survive_because_they_are_the_useful_part(capsys):
    """Timings, sizes and counts must stay readable — over-redacting would
    make the logs useless and push someone toward logging raw values."""
    obs.log_event("scan", ms_total=847, image_kb=166, questions=5, flagged=["q1"])
    line = json.loads(capsys.readouterr().out.strip())
    assert line["ms_total"] == 847
    assert line["image_kb"] == 166
    assert line["flagged"] == ["q1"]


def test_logging_never_raises(capsys):
    """Observability must not be able to fail a scan. An unserialisable
    value is swallowed, not propagated into the request path."""
    class Unserialisable:
        def __repr__(self):
            raise RuntimeError("boom")

    obs.log_event("scan", weird=Unserialisable())  # must not raise


def test_one_json_object_per_line(capsys):
    """CloudWatch Logs Insights parses JSON per log line — a multi-line
    payload would arrive as several unparseable events."""
    obs.log_event("scan", status="ok", flagged=["q1", "q2"])
    out = capsys.readouterr().out
    assert len(out.strip().splitlines()) == 1
    json.loads(out.strip())


# --- End to end, against a real scan ---------------------------------------

@pytest.fixture
def client():
    return TestClient(app)


def _scan(client, photo: Path):
    with open(photo, "rb") as f:
        return client.post(
            "/api/scan",
            files={"image": (photo.name, f, "image/jpeg")},
            data={"config": json.dumps(CONFIG)},
        )


def test_a_real_scan_logs_useful_facts(client, capsys):
    photo = TESTSET / "images" / "filled_file.jpeg"
    if not photo.exists():
        pytest.skip("filled_file.jpeg not present")

    resp = _scan(client, photo)
    assert resp.status_code == 200

    events = [
        json.loads(line)
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("{")
    ]
    scans = [e for e in events if e.get("event") == "scan"]
    assert len(scans) == 1, "exactly one scan event per request"

    scan = scans[0]
    assert scan["status"] == "ok"
    # Stage timings are the point: "scans are slow" is unactionable,
    # "detection is 2.1s" is not.
    for key in ("ms_detect", "ms_read_id", "ms_read_marks", "ms_total"):
        assert isinstance(scan[key], int)
    assert scan["questions"] == 5
    assert scan["image_kb"] > 0
    # Field NAMES are the useful signal and carry nothing sensitive.
    assert scan["flagged"] == ["q1"]


def test_a_real_scan_never_logs_the_student_id_or_image_bytes(client, capsys):
    """Step 11.7.3, checked against real output rather than by reading the
    call sites. filled_file.jpeg's ID is known, and the scan genuinely
    reads it correctly — so if it is anywhere in the logs, this fails."""
    photo = TESTSET / "images" / "filled_file.jpeg"
    if not photo.exists():
        pytest.skip("filled_file.jpeg not present")

    resp = _scan(client, photo)
    # The ID really was recognised — otherwise this test proves nothing.
    assert resp.json()["student_id"] == KNOWN_STUDENT_ID

    out = capsys.readouterr().out
    assert KNOWN_STUDENT_ID not in out, "the recognised student ID reached the logs"
    assert "\\xff\\xd8" not in out and "JFIF" not in out, "image bytes reached the logs"


def test_a_failed_scan_is_logged_with_its_reason(client, capsys):
    photo = TESTSET / "images" / "empty_file.jpeg"
    if not photo.exists():
        pytest.skip("empty_file.jpeg not present")

    _scan(client, photo)
    events = [
        json.loads(line)
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("{")
    ]
    scans = [e for e in events if e.get("event") == "scan"]
    assert scans, "a failed scan must still be logged — that is when logs matter most"
    assert scans[0]["status"] in {"ok", "failed"}
    if scans[0]["status"] == "failed":
        assert scans[0]["failure_reason"]
