"""read_cell (issues.md N18).

`cv2.imread` returns None rather than raising for a file it cannot decode,
and five call sites across three modules then did `.shape` on it — an
AttributeError escaping a route handler as a 500, where the honest answer is
the one this project gives everywhere else: flag the field, let the
instructor retake or type it.
"""
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.cells import read_cell  # noqa: E402


def test_a_real_crop_reads(tmp_path):
    path = tmp_path / "id_d1.png"
    cv2.imwrite(str(path), np.full((40, 30, 3), 200, np.uint8))
    image = read_cell(path)
    assert image is not None
    assert image.shape[:2] == (40, 30)


def test_a_missing_crop_is_none(tmp_path):
    assert read_cell(tmp_path / "nope.png") is None


def test_a_truncated_png_is_none_not_a_crash(tmp_path):
    """The case none of the five call sites handled. `exists()` was the
    check they all used, and these files are written moments earlier by the
    same request — so "missing" was covered and "present but corrupt" was
    not."""
    path = tmp_path / "id_d1.png"
    cv2.imwrite(str(path), np.full((40, 30, 3), 200, np.uint8))
    data = path.read_bytes()
    path.write_bytes(data[: len(data) // 3])
    assert read_cell(path) is None


def test_an_empty_file_is_none(tmp_path):
    path = tmp_path / "id_d1.png"
    path.write_bytes(b"")
    assert read_cell(path) is None


def test_a_file_that_is_not_an_image_at_all_is_none(tmp_path):
    path = tmp_path / "id_d1.png"
    path.write_text("this is not a png")
    assert read_cell(path) is None
