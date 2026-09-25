"""Blur vs darkness vs shadow (2026-09-25).

The old blur check (Laplacian variance < 50) measured brightness as much as
focus, so a sharp photo taken in a dim room failed as "blurry". Its first
replacement (a contrast-normalised score, floor 0.115) then rejected sharp
photos from the instructor's own phone. Neither gate protected anything: soft
photos read, flag, or don't find a grid — never a wrong unflagged value. So
every photo is now tried, and "blurry" only explains a scan whose grid could
not be found. These tests take a real photo, change only its lighting or
focus, and go through /api/scan.
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


def test_a_heavy_shadow_is_not_read_in_full_and_says_the_light_is_uneven(photo):
    """At 0.85 the shaded marks table goes unread (a partial scan), the ID
    still reads with the doubtful digit flagged, and the note says why."""
    body = scan(shadow(photo, 0.85))
    assert body["status"] == "failed" or body["table_mismatches"]
    assert body["lighting"] == "uneven"
    if body["student_id"]:
        assert all(got in (want, "?") for got, want in zip(body["student_id"], "2632711"))


def test_a_shadow_that_defeats_the_reader_is_blamed_on_the_light_not_blur(photo):
    """A deep shadow flattens contrast and would score as blurry; the note
    that helps is the one about light."""
    body = scan(shadow(photo, 0.95))
    assert body["status"] == "failed"
    assert body["failure_reason"] != "blurry"
    assert body["lighting"] == "uneven"


def test_an_out_of_focus_photo_is_still_blurry(photo):
    body = scan(cv2.GaussianBlur(photo, (0, 0), 3))
    assert body["status"] == "failed"
    assert body["failure_reason"] == "blurry"


def test_a_slightly_soft_photo_is_read_not_rejected(photo):
    """Scores ~0.04 — far below the 0.115 floor that rejected the
    instructor's sharp phone photos — and reads normally."""
    soft = cv2.GaussianBlur(photo, (0, 0), 1.0)
    assert detection._sharpness(cv2.cvtColor(soft, cv2.COLOR_BGR2GRAY)) < 0.115
    body = scan(soft)
    assert body["status"] == "ok"


@pytest.mark.skipif(not BLURRY.exists(), reason="real_class_10.jpeg not present")
def test_the_photo_labelled_blurry_is_read_correctly():
    """real_class_10 was rejected as blurry from the start. Tried, it reads:
    every mark, the total and the serial right, and the ID right except
    where a digit is flagged "?" — never a wrong digit."""
    config = {"quizName": "q", "idDigits": 7, "totalMax": 15.0,
              "questions": [{"q": i, "max": 5.0} for i in range(1, 4)]}
    data = BLURRY.read_bytes()
    body = client.post("/api/scan", files={"image": ("c.jpg", data, "image/jpeg")},
                       data={"config": json.dumps(config)}).json()
    assert body["status"] == "ok"
    assert [q["value"] for q in body["questions"]] == [1.0, 1.0, 1.0]
    assert body["total"]["value"] == 3.0
    assert body["serial"] == "129"
    assert all(got in (want, "?") for got, want in zip(body["student_id"], "6692127"))


PRIVATE = Path(__file__).parent.parent.parent / "testset" / "private"


@pytest.mark.parametrize("name", ["phone_fail_1.jpg", "phone_fail_3.jpg", "phone_fail_4.jpg"])
def test_the_instructors_rejected_phone_photos_now_scan(name):
    """Sharp, well-lit photos from the instructor's own phone, rejected live
    by the 0.115 floor. Real scripts, so they live in gitignored
    testset/private/ and this skips wherever they don't exist."""
    path = PRIVATE / name
    if not path.exists():
        pytest.skip(f"{name} is private (testset/private/) and not on this machine")
    config = {"quizName": "q", "idDigits": 7, "totalMax": 15.0,
              "questions": [{"q": i, "max": 5.0} for i in range(1, 4)]}
    body = client.post("/api/scan", files={"image": ("c.jpg", path.read_bytes(), "image/jpeg")},
                       data={"config": json.dumps(config)}).json()
    assert body["status"] == "ok"


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
    assert detection._sharpness(g(photo)) >= detection.BLUR_DIAGNOSIS_FLOOR


def test_a_flat_image_has_zero_sharpness():
    assert detection._sharpness(np.full((50, 50), 200, np.uint8)) == 0.0
