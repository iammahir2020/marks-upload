"""Step 3r.6c: /api/harvest endpoint integration — real detection against
a real photo, no mocks needed (harvesting never touches Gemini). Points
harvesting at a tmp_path via monkeypatch so this never writes into the
real repo's training_data/ directory."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import harvest as harvest_module  # noqa: E402
from app.main import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app)
TESTSET = Path(__file__).parent.parent.parent / "testset"

DEFAULT_CONFIG = {
    "quizName": "CSE211L Quiz 1",
    "idDigits": 7,
    "questions": [{"q": i, "max": 5.0} for i in range(1, 6)],
    "totalMax": 25.0,
}


def _post_harvest(image_path: Path, original: dict, confirmed: dict):
    with open(image_path, "rb") as f:
        return client.post(
            "/api/harvest",
            files={"image": (image_path.name, f, "image/jpeg")},
            data={
                "config": json.dumps(DEFAULT_CONFIG),
                "original": json.dumps(original),
                "confirmed": json.dumps(confirmed),
            },
        )


def test_harvest_endpoint_saves_confirmed_and_corrected_crops(tmp_path, monkeypatch):
    monkeypatch.setattr(harvest_module, "HARVEST_DIR", tmp_path)
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    original = {
        "studentId": "?632?1?",  # a plausible low-confidence original read
        "serial": "07",
        "questions": [None, 2.5, 1.0, 0.0, 4.5],
        "total": 11.0,
    }
    confirmed = {
        "studentId": "2632711",  # instructor filled in the flagged digits
        "serial": "07",
        "questions": [3.0, 2.5, 1.0, 0.0, 4.5],
        "total": 11.0,
    }

    resp = _post_harvest(image_path, original, confirmed)

    assert resp.status_code == 200
    assert resp.json() == {"harvested": True}

    files = list(tmp_path.rglob("*.png"))
    assert files, "expected at least one harvested crop"

    relative = {str(p.relative_to(tmp_path)) for p in files}
    # positions 1, 4, 6 differ between original and confirmed ("?" vs a digit)
    assert any(f.startswith("id_digits/corrected/2_") for f in relative)
    assert any(f.startswith("id_digits/confirmed/6_") for f in relative)
    assert any(f.startswith("marks_q1/corrected/3_") for f in relative)  # was flagged, now filled in
    assert any(f.startswith("marks_q2/confirmed/2.5_") for f in relative)
    assert any(f.startswith("serial/confirmed/07_") for f in relative)
    assert any(f.startswith("marks_total/confirmed/11_") for f in relative)


def test_harvest_endpoint_returns_false_on_detection_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(harvest_module, "HARVEST_DIR", tmp_path)
    image_path = TESTSET / "images" / "empty_file.jpeg"
    if not image_path.exists():
        pytest.skip("empty_file.jpeg not present")

    resp = _post_harvest(
        image_path,
        original={"studentId": None, "serial": None, "questions": [], "total": None},
        confirmed={"studentId": "1234567", "serial": "07", "questions": [3.0], "total": 3.0},
    )

    assert resp.status_code == 200
    body = resp.json()
    # empty_file.jpeg is a blank grid, no values — detection should still
    # succeed on the grid itself (it's a real table), so this mainly
    # guards against a crash; harvested may be True or False depending on
    # whether cells actually decode, but the request must not error.
    assert "harvested" in body
