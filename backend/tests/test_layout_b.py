"""Step 16 (plan.md §21): the no-Serial-box paper layout, and the rule that
the existing layout must not move.

The fixtures in fixtures/layout_b/ are REAL layout A photos with the
Serial box inpainted away and a Name/Section table drawn above the ID row
(make_layout_b.py). Their ID and marks cells are the original pixels, so
a hasSerial=false scan must read exactly what the unmodified app read
from the source photo — expected.json holds that read.

The broader "layout A did not move" proof is not a unit test: it is
step.md 16.13's before/after diff of detect(), detect_any_orientation(),
every cell crop and /api/scan over all of testset/. The tests below pin
the specific promises: an absent hasSerial means True, and every
setting/paper mismatch fails loudly.
"""
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import config as config_module  # noqa: E402
from app import marks, marks_ocr  # noqa: E402
from app.detection import detect, detect_any_orientation  # noqa: E402
from app.main import app  # noqa: E402
from app.models import QuizConfig  # noqa: E402

client = TestClient(app)
FIXTURES = Path(__file__).parent / "fixtures" / "layout_b"
TESTSET = Path(__file__).parent.parent.parent / "testset"
EXPECTED = json.loads((FIXTURES / "expected.json").read_text())["fixtures"]
CASES = sorted(EXPECTED.items())
IDS = [name for name, _ in CASES]


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    """This module makes ~17 real requests. main.py's limiter is one
    in-memory window shared by the whole test process (30/min per client),
    so leaving it on here spends the budget of whichever test runs next —
    test_observability.py got 429s. Nothing here tests rate limiting."""
    monkeypatch.setattr(config_module, "RATE_LIMIT_ENABLED", False)


def _config(maxes, has_serial=None):
    cfg = {
        "quizName": "Quiz 1",
        "idDigits": 7,
        "totalMax": sum(maxes),
        "questions": [{"q": i + 1, "max": m} for i, m in enumerate(maxes)],
    }
    if has_serial is not None:
        cfg["hasSerial"] = has_serial
    return cfg


def _scan(path: Path, config: dict):
    with open(path, "rb") as f:
        return client.post(
            "/api/scan",
            files={"image": (path.name, f, "image/jpeg")},
            data={"config": json.dumps(config)},
        )


# --- The model default ------------------------------------------------------


def test_has_serial_defaults_to_true_when_the_field_is_absent():
    quiz = QuizConfig.model_validate(_config([5.0, 5.0]))
    assert quiz.hasSerial is True


# --- Detection --------------------------------------------------------------


@pytest.mark.parametrize("name,expected", CASES, ids=IDS)
def test_layout_b_detects_with_serial_off(tmp_path, name, expected):
    result = detect(FIXTURES / name, len(expected["maxes"]), 7, tmp_path, has_serial=False)

    assert result["status"] == "ok", result["failure_reason"]
    assert [t["type"] for t in result["tables"]] == ["marks", "id"]
    assert result["config"]["has_serial"] is False
    cells = {p.name for p in (tmp_path / "cells").iterdir()}
    assert "serial.png" not in cells
    assert {f"id_d{i}.png" for i in range(1, 8)} <= cells


@pytest.mark.parametrize("name,expected", CASES, ids=IDS)
def test_layout_b_with_serial_on_fails_loudly(tmp_path, name, expected):
    """The ID row is now the closest box to the marks table, so it is taken
    as the Serial and cannot have 2 columns — a mismatch, never a misread."""
    result = detect_any_orientation(FIXTURES / name, len(expected["maxes"]), 7, tmp_path)
    assert result["status"] == "failed"
    assert result["failure_reason"] == "column_count_mismatch"


@pytest.mark.parametrize("name,expected", CASES, ids=IDS)
def test_layout_a_with_serial_off_fails_loudly(tmp_path, name, expected):
    """The reverse mismatch: the real Serial box is taken as the ID."""
    source = TESTSET / "images" / expected["source"]
    if not source.exists():
        pytest.skip(f"{expected['source']} not present")
    result = detect_any_orientation(source, len(expected["maxes"]), 7, tmp_path, has_serial=False)
    assert result["status"] == "failed"
    assert result["failure_reason"] == "column_count_mismatch"


def test_default_result_json_has_no_has_serial_key(tmp_path):
    """A default run's result.json must stay byte-identical to what it was
    before step 16, so the key is only written when the setting is off."""
    source = TESTSET / "images" / "filled_file.jpeg"
    if not source.exists():
        pytest.skip("filled_file.jpeg not present")
    result = detect(source, 5, 7, tmp_path)
    assert "has_serial" not in result["config"]


# --- Through the real endpoint ----------------------------------------------


@pytest.mark.parametrize("name,expected", CASES, ids=IDS)
def test_layout_b_scan_reads_what_the_layout_a_photo_read(name, expected):
    resp = _scan(FIXTURES / name, _config(expected["maxes"], has_serial=False))
    assert resp.status_code == 200
    body = resp.json()

    assert body["status"] == "ok"
    assert body["student_id"] == expected["student_id"]
    assert [q["value"] for q in body["questions"]] == expected["questions"]
    assert body["total"]["value"] == expected["total"]
    # No Serial box: empty, and nothing to be unsure about.
    assert body["serial"] is None
    assert "serial" not in body["low_confidence_fields"]
    assert "serial" not in body["crossed_out_fields"]
    assert "serial" not in body["suggestions"]


def test_a_request_without_has_serial_scans_exactly_like_has_serial_true():
    """An older frontend never sends the field. Its scans must not change."""
    source = TESTSET / "images" / "filled_file.jpeg"
    if not source.exists():
        pytest.skip("filled_file.jpeg not present")
    maxes = [5.0] * 5
    absent = _scan(source, _config(maxes))
    explicit = _scan(source, _config(maxes, has_serial=True))
    assert absent.status_code == explicit.status_code == 200
    assert absent.json() == explicit.json()
    assert absent.json()["status"] == "ok"


def test_no_serial_harvest_writes_no_serial_crop_whatever_is_sent(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "HARVEST_DIR", tmp_path)
    name, expected = CASES[0]
    fields = {
        "studentId": expected["student_id"],
        "serial": "07",  # sent anyway — must be ignored
        "questions": expected["questions"],
        "total": expected["total"],
    }
    with open(FIXTURES / name, "rb") as f:
        resp = client.post(
            "/api/harvest",
            files={"image": (name, f, "image/jpeg")},
            data={
                "config": json.dumps(_config(expected["maxes"], has_serial=False)),
                "original": json.dumps(fields),
                "confirmed": json.dumps(fields),
                "source": "test-layout-b",
            },
        )
    assert resp.json() == {"harvested": True}
    written = {p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*.png")}
    assert written, "the ID and marks crops should still be harvested"
    assert not any("/serial/" in p for p in written)


def test_cnn_ignores_a_serial_crop_that_exists_when_off(tmp_path):
    from app.recognizers.local import CNNRecognizer

    cells = _cells_with_serial(tmp_path)
    recognizer = CNNRecognizer()
    on = recognizer.read_marks(cells, [5.0] * 5)
    off = recognizer.read_marks(cells, [5.0] * 5, has_serial=False)
    assert on.serial is not None  # the crop really is readable
    assert off.serial is None
    assert "serial" not in off.low_confidence_fields
    # Everything else is read identically.
    assert (off.questions, off.total) == (on.questions, on.total)


# --- The remote (Gemini/Tesseract) path, without a network ------------------


def _cells_with_serial(tmp_path) -> Path:
    """Real crops from a layout A photo, so serial.png genuinely exists —
    the no-serial branch must ignore it rather than rely on its absence."""
    source = TESTSET / "images" / "filled_file.jpeg"
    if not source.exists():
        pytest.skip("filled_file.jpeg not present")
    result = detect(source, 5, 7, tmp_path)
    assert result["status"] == "ok"
    cells = tmp_path / "cells"
    assert (cells / "serial.png").exists()
    return cells


def test_composite_leaves_out_the_serial_tile_when_off(tmp_path):
    cells = _cells_with_serial(tmp_path)
    _, labels_on = marks.build_composite(cells, 5)
    _, labels_off = marks.build_composite(cells, 5, has_serial=False)
    assert labels_on[0] == "serial"
    assert labels_off == labels_on[1:]


def test_prompt_is_unchanged_by_default_and_drops_the_serial_line_when_off():
    maxes = [5.0, 5.0]
    assert marks.build_prompt(maxes) == marks.build_prompt(maxes, has_serial=True)
    assert "serial" in marks.build_prompt(maxes)
    assert "serial" not in marks.build_prompt(maxes, has_serial=False)


def test_validate_payload_discards_a_serial_it_was_never_shown():
    payload = marks.ScanPayload(serial="12", questions=[5.0], total=5.0)
    result = marks.validate_payload(payload, [5.0], has_serial=False)
    assert result.serial is None
    assert "serial" not in result.low_confidence_fields
    # and the default still reads and keeps it
    assert marks.validate_payload(payload, [5.0]).serial == "12"


def test_local_ocr_fallback_skips_the_serial_when_off(tmp_path, monkeypatch):
    cells = _cells_with_serial(tmp_path)
    opened = []
    monkeypatch.setattr(marks_ocr, "_read_field", lambda path, _wl: opened.append(path.name) or "3")
    result = marks_ocr.recognize_locally(cells, [5.0] * 5, has_serial=False)
    assert result is not None
    assert result.serial is None
    assert "serial" not in result.low_confidence_fields
    assert "serial.png" not in opened
