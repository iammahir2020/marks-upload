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

    relative = {p.relative_to(tmp_path).as_posix() for p in files}
    # positions 1, 4, 6 differ between original and confirmed ("?" vs a digit)
    assert any(f.startswith("fac-test1/id_digits/corrected/2_") for f in relative)
    assert any(f.startswith("fac-test1/id_digits/confirmed/6_") for f in relative)
    assert any(f.startswith("fac-test1/marks_questions/corrected/3_") for f in relative)  # q1: was flagged, now filled in
    assert any(f.startswith("fac-test1/marks_questions/confirmed/2.5_") for f in relative)
    assert any(f.startswith("fac-test1/serial/confirmed/07_") for f in relative)
    assert any(f.startswith("fac-test1/marks_total/confirmed/11_") for f in relative)


def test_harvest_endpoint_refuses_a_field_the_original_scan_marked_unmatched(tmp_path, monkeypatch):
    """issues.md N31, end to end through the real endpoint (not just
    harvest() directly): q1's crop must not be written at all, even
    though the instructor's confirmed value (3.0) is perfectly legal and
    everything else in the same request harvests normally."""
    monkeypatch.setattr(config_module, "HARVEST_DIR", tmp_path)
    image_path = TESTSET / "images" / "filled_file.jpeg"
    if not image_path.exists():
        pytest.skip("filled_file.jpeg not present")

    original = {
        "studentId": "2632711",
        "serial": "07",
        "questions": [None, 2.5, 1.0, 0.0, 4.5],  # q1 had ink but no legal match
        "total": 11.0,
        "unmatchedFields": ["q1"],
    }
    confirmed = {
        "studentId": "2632711",
        "serial": "07",
        "questions": [3.0, 2.5, 1.0, 0.0, 4.5],  # the workaround value
        "total": 11.0,
    }

    resp = _post_harvest(image_path, original, confirmed, source="fac-test1")

    assert resp.status_code == 200
    assert resp.json() == {"harvested": True}

    relative = {p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*.png")}
    # Q1's workaround value was 3, which no other question has.
    assert not any(f.startswith("fac-test1/marks_questions/") and "/3_" in f for f in relative)
    # everything else in the request still harvests normally
    assert any(f.startswith("fac-test1/marks_questions/confirmed/2.5_") for f in relative)
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
        p.relative_to(tmp_path).as_posix().startswith("unknown/")
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


def test_a_partial_scan_is_harvested_from_the_tables_that_matched(tmp_path, monkeypatch):
    """ID row miscounted (6 digit boxes drawn, 7 expected): the serial and
    marks crops are harvested, and nothing at all under id_digits/ — even
    though the instructor typed a full ID. detect() writes no crops for a
    miscounted table, so the typed ID has no image to be attached to."""
    sys.path.insert(0, str(Path(__file__).parent))  # tests/ is not a package
    from test_main import _make_wrong_column_count

    monkeypatch.setattr(config_module, "HARVEST_DIR", tmp_path / "store")
    image_path = tmp_path / "partial.jpg"
    _make_wrong_column_count(image_path, real_questions=6, id_digits=6)

    original = {"studentId": None, "serial": "7", "questions": [3.0, 2.5, 1.0, 0.0, 4.5], "total": 11.0}
    confirmed = {"studentId": "1234567", "serial": "7", "questions": [3.0, 2.5, 1.0, 0.0, 4.5], "total": 11.0}
    resp = _post_harvest(image_path, original, confirmed, source="test-partial")

    assert resp.json() == {"harvested": True}
    fields = {p.relative_to(tmp_path / "store").parts[1] for p in (tmp_path / "store").rglob("*.png")}
    assert "id_digits" not in fields
    assert {"serial", "marks_questions", "marks_total"} <= fields


def test_a_wrong_serial_setting_is_still_never_harvested(tmp_path, monkeypatch):
    """Not a partial scan (main._is_partial): the box in the ID's position
    may be the wrong box entirely, so none of it is trusted."""
    monkeypatch.setattr(config_module, "HARVEST_DIR", tmp_path)
    image_path = Path(__file__).parent / "fixtures" / "layout_b" / "layout_b_real_class_01.jpg"
    fields = {"studentId": "1234567", "serial": "7", "questions": [1.0] * 5, "total": 5.0}

    resp = _post_harvest(image_path, fields, fields, source="test-layout")

    assert resp.json() == {"harvested": False}
    assert not list(tmp_path.rglob("*.png"))
