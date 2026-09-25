"""issues.md N39/N47 — the upload gate in app/imagecheck.py and main.py.

The real photos are the first thing checked: a gate that rejected a real
capture would be worse than the attack it stops.
"""
import json
import struct
import sys
import time
import zlib
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import imagecheck  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
TESTSET = Path(__file__).parent.parent.parent / "testset"
CONFIG = {
    "quizName": "q", "idDigits": 7, "totalMax": 25.0,
    "questions": [{"q": i, "max": 5.0} for i in range(1, 6)],
}


def real_photos():
    return sorted((TESTSET / "images").glob("*.jp*g")) + sorted(
        (Path(__file__).parent / "fixtures" / "layout_b").glob("*.jpg"))


def png_claiming(width: int, height: int) -> bytes:
    """A PNG whose header claims width x height, with a tiny real body —
    the audit's shape: next to nothing on the wire, huge once decoded."""
    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return imagecheck.PNG_SIGNATURE + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\0")) + chunk(b"IEND", b"")


def post(data: bytes, name="capture.jpg"):
    return client.post("/api/scan", files={"image": (name, data, "image/jpeg")},
                       data={"config": json.dumps(CONFIG)})


@pytest.mark.parametrize("photo", real_photos(), ids=lambda p: p.name)
def test_every_real_photo_passes_with_its_true_size(photo):
    info = imagecheck.sniff(photo.read_bytes())
    h, w = cv2.imread(str(photo)).shape[:2]
    assert (info.kind, info.width, info.height) == ("jpeg", w, h)


def test_a_progressive_jpeg_and_a_png_are_read_correctly():
    img = np.zeros((123, 456, 3), np.uint8)
    progressive = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_PROGRESSIVE, 1])[1].tobytes()
    assert imagecheck.sniff(progressive) == imagecheck.ImageInfo("jpeg", 456, 123)
    assert imagecheck.sniff(cv2.imencode(".png", img)[1].tobytes()) == imagecheck.ImageInfo("png", 456, 123)


def test_a_tiny_file_claiming_a_huge_image_is_refused_before_decoding():
    """The N39 attack: ~100 bytes claiming 10000x10000. Refused with 413,
    without detection ever running, and in far less time than a scan."""
    bomb = png_claiming(10000, 10000)
    assert len(bomb) < 200
    with patch("app.main.detect_any_orientation") as detect:
        started = time.perf_counter()
        resp = post(bomb, "capture.png")
        elapsed = time.perf_counter() - started
    assert resp.status_code == 413
    detect.assert_not_called()
    assert elapsed < 1.0


def test_a_long_thin_image_is_refused_even_under_the_pixel_budget():
    assert post(png_claiming(20000, 100), "capture.png").status_code == 413


def test_a_4k_capture_is_allowed():
    """A phone that ignores the 1920x1080 hint and sends 4K must still scan."""
    img = np.full((2160, 3840, 3), 255, np.uint8)
    resp = post(cv2.imencode(".jpg", img)[1].tobytes())
    assert resp.status_code == 200


@pytest.mark.parametrize("ext", [".tiff", ".bmp", ".ppm", ".webp"])
def test_other_formats_opencv_would_decode_are_refused(ext):
    """N47: each of these is a real, valid image that cv2.imread would
    happily decode — the point is that they never reach it."""
    ok, buf = cv2.imencode(ext, np.zeros((20, 20, 3), np.uint8))
    assert ok
    with patch("app.main.detect_any_orientation") as detect:
        resp = post(buf.tobytes(), "capture" + ext)
    assert resp.status_code == 415
    detect.assert_not_called()


def test_a_truncated_jpeg_is_refused_as_damaged():
    photo = real_photos()[0].read_bytes()
    assert post(photo[:120]).status_code == 400


def test_the_harvest_endpoint_is_gated_too(monkeypatch, tmp_path):
    from app import config as config_module
    monkeypatch.setattr(config_module, "HARVEST_ENABLED", True)
    monkeypatch.setattr(config_module, "HARVEST_DIR", tmp_path)
    resp = client.post("/api/harvest", files={"image": ("c.png", png_claiming(10000, 10000), "image/png")},
                       data={"config": json.dumps(CONFIG), "original": "{}", "confirmed": "{}"})
    assert resp.status_code == 413
    assert not list(tmp_path.rglob("*"))
