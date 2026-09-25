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


# --- Weak decimal points, stray ink and wide glyphs (2026-09-25) -----------
# Measured on a practice page of written half marks (cnn/half_marks_accuracy.py):
# people put the point at mid-height, and a small pen dot can fall under the
# noise floor. These rules find such a point as WEAK — the decoder then tries
# the value with and without it (test_local_recognizer_resolve.py).

from cnn.segment import segment_cell_detail, split_wide  # noqa: E402

BIG_H, BIG_W = 240, 320  # roomy enough that a pen dot can sit under the noise floor


def big_cell() -> np.ndarray:
    return np.full((BIG_H, BIG_W, 3), 255, dtype=np.uint8)


def two_digits(img: np.ndarray) -> None:
    """Two outlined digits, 50x140 at thickness 4 — ink comparable to a real
    written digit rather than a solid block."""
    cv2.rectangle(img, (60, 50), (110, 190), (0, 0, 0), 4)
    cv2.rectangle(img, (190, 50), (240, 190), (0, 0, 0), 4)


def test_a_mid_height_dot_between_digits_is_a_weak_point():
    img = big_cell()
    two_digits(img)
    cv2.circle(img, (150, 110), 7, (0, 0, 0), -1)  # centre ~43% down the band
    glyphs = segment_cell_detail(img).glyphs
    assert [(g.is_decimal, g.weak) for g in glyphs] == [(False, False), (True, True), (False, False)]


def test_a_low_dot_is_still_a_strong_point():
    """The original lower-half rule is unchanged, and stays strong."""
    img = big_cell()
    two_digits(img)
    cv2.circle(img, (150, 175), 7, (0, 0, 0), -1)
    glyphs = segment_cell_detail(img).glyphs
    assert [(g.is_decimal, g.weak) for g in glyphs] == [(False, False), (True, False), (False, False)]


def test_a_dot_in_the_top_quarter_is_not_a_point():
    img = big_cell()
    two_digits(img)
    cv2.circle(img, (150, 62), 7, (0, 0, 0), -1)
    seg = segment_cell_detail(img)
    assert not any(g.is_decimal for g in seg.glyphs)
    assert seg.stray_between


def test_a_mid_height_dash_is_not_a_point():
    """A hyphen is small and between the digits, but not round."""
    img = big_cell()
    two_digits(img)
    cv2.line(img, (132, 115), (168, 115), (0, 0, 0), 5)
    seg = segment_cell_detail(img)
    assert not any(g.is_decimal for g in seg.glyphs)
    assert seg.stray_between


def test_a_mid_height_dot_after_the_last_digit_is_not_a_weak_point():
    """Every legal value has a digit on both sides of its point."""
    img = big_cell()
    two_digits(img)
    cv2.circle(img, (275, 110), 7, (0, 0, 0), -1)
    glyphs = segment_cell_detail(img).glyphs
    assert not any(g.weak for g in glyphs)


def test_a_pen_dot_under_the_noise_floor_is_rescued_between_digits():
    img = big_cell()
    two_digits(img)
    cv2.circle(img, (150, 170), 4, (0, 0, 0), -1)  # ~50 px: under the 67 px floor, ~3% of a digit
    seg = segment_cell_detail(img)
    points = [g for g in seg.glyphs if g.is_decimal]
    assert len(points) == 1 and points[0].weak


def test_a_paper_speck_is_neither_a_point_nor_stray_ink():
    img = big_cell()
    two_digits(img)
    img[150, 150] = 0  # one dark pixel
    seg = segment_cell_detail(img)
    assert not any(g.is_decimal for g in seg.glyphs)
    assert not seg.stray_between


def test_touching_digits_are_flagged_as_maybe_two():
    img = big_cell()
    # two outlined digits drawn touching: one component twice as wide as tall
    cv2.rectangle(img, (40, 70), (130, 170), (0, 0, 0), 4)
    cv2.rectangle(img, (130, 70), (220, 170), (0, 0, 0), 4)
    glyphs = segment_cell_detail(img).glyphs
    assert len(glyphs) == 1 and glyphs[0].maybe_two


def test_split_wide_cuts_at_the_asked_fraction_and_refuses_an_empty_side():
    img = big_cell()
    cv2.rectangle(img, (40, 70), (130, 170), (0, 0, 0), 4)
    cv2.rectangle(img, (130, 70), (220, 170), (0, 0, 0), 4)
    glyph = segment_cell_detail(img).glyphs[0]
    width = glyph.x1 - glyph.x0
    left, right = split_wide(glyph, 0.5)
    assert abs((left.x1 - left.x0) - width // 2) <= 1
    assert right.x1 == glyph.x1
    assert split_wide(glyph, 0.0) is None


def test_an_ordinary_digit_is_not_flagged_wide():
    img = big_cell()
    two_digits(img)
    assert not any(g.maybe_two for g in segment_cell_detail(img).glyphs)
