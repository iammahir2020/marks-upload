"""Step 3r's segmentation tests (step.md step 3r, Test section). Pure
opencv/numpy — no network, no model — against synthetic cell images built
directly in this file."""
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from cnn.segment import segment_cell  # noqa: E402

CELL_H, CELL_W = 120, 160


def blank_cell() -> np.ndarray:
    return np.full((CELL_H, CELL_W, 3), 255, dtype=np.uint8)


def draw_stroke(img: np.ndarray, x0: int, y0: int, x1: int, y1: int, thickness: int = 6) -> None:
    cv2.line(img, (x0, y0), (x1, y1), (0, 0, 0), thickness)


def test_blank_cell_returns_no_glyphs():
    """A classifier always outputs something; feeding it a blank cell
    would return a confident wrong digit (plan.md §16) — segmentation has
    to catch this before the model ever sees it."""
    assert segment_cell(blank_cell()) == []


def test_two_separate_digits_segment_into_two_glyphs():
    img = blank_cell()
    # two well-separated vertical strokes, standing in for "0" and "7"
    cv2.rectangle(img, (25, 30), (45, 90), (0, 0, 0), -1)
    cv2.rectangle(img, (100, 30), (120, 90), (0, 0, 0), -1)
    glyphs = segment_cell(img)
    assert len(glyphs) == 2
    assert glyphs[0].x0 < glyphs[1].x0  # left to right


def test_disconnected_stroke_glyph_merges_into_one():
    """A '4' or '5' written with a lifted pen produces two components
    that overlap heavily in x — plan.md §16 calls this the single most
    common segmentation failure to get wrong."""
    img = blank_cell()
    # two blobs overlapping ~70% in x-range, simulating one disconnected glyph
    cv2.rectangle(img, (40, 20), (80, 55), (0, 0, 0), -1)
    cv2.rectangle(img, (50, 60), (90, 95), (0, 0, 0), -1)
    glyphs = segment_cell(img)
    assert len(glyphs) == 1


def test_specks_of_noise_are_dropped():
    img = blank_cell()
    cv2.rectangle(img, (40, 30), (60, 90), (0, 0, 0), -1)  # one real digit
    cv2.circle(img, (120, 20), 1, (0, 0, 0), -1)  # a tiny speck elsewhere
    glyphs = segment_cell(img)
    assert len(glyphs) == 1


def test_decimal_point_classified_by_geometry_not_a_model():
    """A small component low in the glyph band, well short of the digits'
    own height, should be flagged as the decimal point — pure geometry,
    no training data needed (plan.md §16). Sized well above the noise
    floor (unlike the single-pixel speck in test_specks_of_noise_are_dropped)
    but well below the digits' own height — a real decimal point, not noise."""
    img = blank_cell()
    cv2.rectangle(img, (30, 20), (55, 90), (0, 0, 0), -1)  # a tall digit
    cv2.rectangle(img, (70, 20), (95, 90), (0, 0, 0), -1)  # a second tall digit
    cv2.circle(img, (110, 85), 9, (0, 0, 0), -1)           # a real-sized dot, low in the band
    glyphs = segment_cell(img)
    assert len(glyphs) == 3
    assert [g.is_decimal for g in glyphs] == [False, False, True]
