"""Blur vs darkness vs shadow (2026-09-25).

The old blur check (Laplacian variance < 50) measured brightness as much as
focus, so a sharp photo taken in a dim room failed as "blurry" — the
instructor hit it live, and on the testset 18 of 28 photos at half
brightness were rejected though detection read all 28. These tests take a
real photo, change only its lighting or focus, and go through /api/scan.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import detection  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
PHOTO = Path(__file__).parent.parent.parent / "testset" / "images" / "filled_file.jpeg"
BLURRY = Path(__file__).parent.parent.parent / "testset" / "images" / "real_class_10.jpeg"
CONFIG = {"quizName": "q", "idDigits": 7, "totalMax": 25.0,
          "questions": [{"q": i, "max": 5.0} for i in range(1, 6)]}

pytestmark = pytest.mark.skipif(not PHOTO.exists(), reason="filled_file.jpeg not present")


def scan(img: np.ndarray) -> dict:
    data = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tobytes()
    return client.post("/api/scan", files={"image": ("c.jpg", data, "image/jpeg")},
                       data={"config": json.dumps(CONFIG)}).json()


def dim(img: np.ndarray, factor: float, noise: float) -> np.ndarray:
    rng = np.random.default_rng(0)
    return np.clip(img.astype(np.float32) * factor + rng.normal(0, noise, img.shape), 0, 255).astype(np.uint8)


def shadow(img: np.ndarray, strength: float) -> np.ndarray:
    h, w = img.shape[:2]
    mask = np.zeros((h, w), np.float32)
    cv2.ellipse(mask, (int(w * 0.35), int(h * 0.55)), (int(w * 0.28), int(h * 0.35)), 0, 0, 360, 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), w * 0.06)[..., None]
    return np.clip(img * (1 - strength * mask), 0, 255).astype(np.uint8)


@pytest.fixture(scope="module")
def photo() -> np.ndarray:
    return cv2.imread(str(PHOTO))


def test_a_dim_but_sharp_photo_is_read_not_called_blurry(photo):
    """The live failure: the same sharp photo with half the light. The old
    check rejected it as blurry; the grid is perfectly readable."""
    dark = dim(photo, 0.5, 0)
    # Measured on the JPEG the server actually receives, as the old check saw it.
    sent = cv2.imdecode(cv2.imencode(".jpg", dark, [cv2.IMWRITE_JPEG_QUALITY, 92])[1], cv2.IMREAD_GRAYSCALE)
    assert cv2.Laplacian(sent, cv2.CV_64F).var() < 50  # the OLD check rejected this as blurry
    body = scan(dark)
    assert body["status"] == "ok"
    assert body["lighting"] is None


def test_a_very_dark_photo_fails_and_says_it_is_too_dark(photo):
    body = scan(dim(photo, 0.2, 5))
    assert body["status"] == "failed"
    assert body["lighting"] == "too_dark"


def test_a_heavy_shadow_fails_and_says_the_light_is_uneven(photo):
    body = scan(shadow(photo, 0.85))
    assert body["status"] == "failed"
    assert body["lighting"] == "uneven"


def test_an_out_of_focus_photo_is_still_blurry(photo):
    body = scan(cv2.GaussianBlur(photo, (0, 0), 3))
    assert body["status"] == "failed"
    assert body["failure_reason"] == "blurry"


@pytest.mark.skipif(not BLURRY.exists(), reason="real_class_10.jpeg not present")
def test_the_real_blurry_photo_is_still_rejected():
    body = scan(cv2.imread(str(BLURRY)))
    assert body["failure_reason"] == "blurry"


def test_a_good_photo_carries_no_lighting_note(photo):
    body = scan(photo)
    assert body["status"] == "ok"
    assert body["lighting"] is None


def test_darkening_raises_sharpness_instead_of_lowering_it(photo):
    """Why the new measure can't mistake darkness for blur: dividing by the
    photo's own contrast cancels exposure, and noise only adds edges."""
    g = lambda im: cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    assert detection._sharpness(g(dim(photo, 0.5, 0))) >= 0.95 * detection._sharpness(g(photo))
    assert detection._sharpness(g(dim(photo, 0.5, 3))) >= detection._sharpness(g(photo))
    assert detection._sharpness(g(photo)) >= detection.SHARPNESS_FLOOR


def test_a_flat_image_has_zero_sharpness():
    assert detection._sharpness(np.full((50, 50), 200, np.uint8)) == 0.0
