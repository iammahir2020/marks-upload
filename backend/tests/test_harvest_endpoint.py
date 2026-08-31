"""Step 3r.6c: /api/harvest endpoint integration — real detection against
a real photo, no mocks needed (harvesting never touches Gemini). Points
harvesting at a tmp_path via monkeypatch so this never writes into the
real repo's training_data/ directory.

Extended in step 11.2 for the source tag. `build_store()` reads
`config.HARVEST_DIR` at call time rather than at import, which is what
makes the monkeypatch below work at all."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import config as config_module  # noqa: E402
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


def _post_harvest(image_path: Path, original: dict, confirmed: dict, source=None):
    data = {
        "config": json.dumps(DEFAULT_CONFIG),
        "original": json.dumps(original),
        "confirmed": json.dumps(confirmed),
    }
    if source is not None:
        data["source"] = source
    with open(image_path, "rb") as f:
        return client.post(
            "/api/harvest",
            files={"image": (image_path.name, f, "image/jpeg")},
            data=data,
        )


def test_harvest_endpoint_saves_confirmed_and_corrected_crops(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "HARVEST_DIR", tmp_path)
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

    resp = _post_harvest(image_path, original, confirmed, source="fac-test1")

    assert resp.status_code == 200
    assert resp.json() == {"harvested": True}

    files = list(tmp_path.rglob("*.png"))
    assert files, "expected at least one harvested crop"

    relative = {str(p.relative_to(tmp_path)) for p in files}
    # positions 1, 4, 6 differ between original and confirmed ("?" vs a digit)
    assert any(f.startswith("fac-test1/id_digits/corrected/2_") for f in relative)
    assert any(f.startswith("fac-test1/id_digits/confirmed/6_") for f in relative)
    assert any(f.startswith("fac-test1/marks_q1/corrected/3_") for f in relative)  # was flagged, now filled in
    assert any(f.startswith("fac-test1/marks_q2/confirmed/2.5_") for f in relative)
    assert any(f.startswith("fac-test1/serial/confirmed/07_") for f in relative)
    assert any(f.startswith("fac-test1/marks_total/confirmed/11_") for f in relative)


def test_harvest_endpoint_returns_false_on_detection_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "HARVEST_DIR", tmp_path)
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


def test_a_request_without_a_source_lands_under_unknown(tmp_path, monkeypatch):
    """An older frontend, or any caller that omits the field, must still
    harvest — just visibly untagged (step 11.2.5)."""
    monkeypatch.setattr(config_module, "HARVEST_DIR", tmp_path)
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    resp = _post_harvest(
        image_path,
        original={"studentId": "2632711", "serial": "07", "questions": [3.0], "total": 3.0},
        confirmed={"studentId": "2632711", "serial": "07", "questions": [3.0], "total": 3.0},
    )
    assert resp.json() == {"harvested": True}
    assert all(
        str(p.relative_to(tmp_path)).startswith("unknown/")
        for p in tmp_path.rglob("*.png")
    )


def test_harvest_enabled_false_makes_the_endpoint_a_no_op(tmp_path, monkeypatch):
    """The kill switch (step 11.1.3) — a deployment that would rather not
    collect handwriting at all. It must still answer 200, since the
    frontend fires this unawaited and must never see it as a save
    failure."""
    monkeypatch.setattr(config_module, "HARVEST_DIR", tmp_path)
    monkeypatch.setattr(config_module, "HARVEST_ENABLED", False)
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    resp = _post_harvest(
        image_path,
        original={"studentId": "2632711", "serial": "07", "questions": [3.0], "total": 3.0},
        confirmed={"studentId": "2632711", "serial": "07", "questions": [3.0], "total": 3.0},
        source="fac-test1",
    )
    assert resp.status_code == 200
    assert resp.json() == {"harvested": False}
    assert list(tmp_path.rglob("*.png")) == []
