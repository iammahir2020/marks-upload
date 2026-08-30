"""Segmentation for serial and mark cells (step.md step 3r.1/3r.2, plan.md
§16 "Segmentation"). The ID needs none of this — the template already
gives one digit per box (step 2/2r) — but a serial or mark cell holds
several glyphs in one box, so they have to be pulled apart before the
digit CNN (step 2r) can read them one at a time.

Pure opencv/numpy — no torch, no onnxruntime. This module only decides
*where* the glyphs are; step 2r's `preprocess_for_cnn` and the model
itself decide *what* they are.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

INSET_FRAC = 0.12  # same fraction id_ocr.py/preprocess.py already use —
                     # trims the cell's own ruled border before anything
                     # else, so it never reads as an extra component.
NOISE_AREA_FRAC = 0.0015  # a component below this fraction of the (inset)
                            # cell's area is noise (a speck of paper
                            # texture, a scanning artifact), not a stroke.
                            # Calibrated from a real miss, not guessed: an
                            # initial 0.01 dropped a real handwritten
                            # decimal point (58px, ~0.36% of a real cell's
                            # area) outright, silently turning "2.5" into
                            # an undecodable two-digit reading with no
                            # decimal (step 3r.5 — see learn.md). Lowered
                            # with margin below that real dot's size while
                            # still comfortably above single-pixel specks.
OVERLAP_MERGE_FRAC = 0.5  # merge two components if their x-ranges overlap
                            # by more than this fraction of the narrower
                            # one's width (plan.md §16's own figure for a
                            # disconnected-stroke glyph like a two-part 4).
CENTER_OFFSET_MERGE_FRAC = 0.36  # ...and only if their x-centres are close
                                   # relative to the wider one's width — two
                                   # pieces of one broken stroke are drawn
                                   # in place, roughly stacked (similar
                                   # centre); a decimal point sits beside a
                                   # digit, offset toward one edge. A first
                                   # attempt at this same idea used height
                                   # ratio instead of centre offset and
                                   # broke a genuine disconnected "5" (see
                                   # git history) — measured directly on
                                   # both real cases instead this time: a
                                   # real decimal-beside-"2" case measured
                                   # 0.44, a real disconnected-"5" case
                                   # measured 0.28. Provisional the same way
                                   # every threshold here is (n=2) — expect
                                   # this to move as more real cases turn up.
DECIMAL_HEIGHT_FRAC = 0.35  # a component shorter than this fraction of the
                              # tallest surviving component's height is a
                              # candidate decimal point, not a small digit.
                              # Anchored to the *tallest* component, not the
                              # median: a stray mark elsewhere in the cell
                              # (whiteboard marker artifacts, not paper/pen
                              # noise) can drag a median down enough to make
                              # a real decimal point measure as "too tall to
                              # be a dot" by comparison — the tallest
                              # component is always a real digit's own full
                              # height regardless of how many stray
                              # components exist alongside it (see learn.md
                              # step 3r's follow-up).
DECIMAL_LOWER_BAND_FRAC = 0.5  # and its centroid must sit in the lower
                                 # half of the glyph band — geometry
                                 # alone, no model, no training data
                                 # (plan.md §16). Relaxed from an initial
                                 # "lower third" after a real handwritten
                                 # decimal point (step 3r.5) landed at
                                 # ~60% down a [19,82]px band — a
                                 # hand-drawn dot between two digits sits
                                 # closer to mid-height than a printed
                                 # period does, and "lower third" missed
                                 # it by half a pixel of centroid position
                                 # (see learn.md step 3r).


@dataclass
class Glyph:
    image: np.ndarray   # cropped BGR/gray glyph, in the inset cell's own coordinates
    x0: int
    x1: int
    is_decimal: bool


def _merge_overlapping(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """boxes: (x0, y0, x1, y1), already sorted left to right. Merges any
    two whose x-ranges overlap by more than OVERLAP_MERGE_FRAC of the
    narrower one's width AND whose x-centres are close relative to the
    wider one's width — a disconnected stroke (a two-part 4 or 5)
    produces two components that are really one glyph (plan.md §16's own
    example, and the single most common segmentation failure to get
    wrong), while a decimal point sitting close enough to a digit to
    overlap it in x is a different glyph entirely and must not be merged
    away before it ever reaches decimal classification."""
    merged: list[tuple[int, int, int, int]] = []
    for box in boxes:
        if not merged:
            merged.append(box)
            continue
        px0, py0, px1, py1 = merged[-1]
        x0, y0, x1, y1 = box
        overlap = min(px1, x1) - max(px0, x0)
        narrower_width = min(px1 - px0, x1 - x0)

        prev_center, this_center = (px0 + px1) / 2, (x0 + x1) / 2
        wider_width = max(px1 - px0, x1 - x0)
        center_offset_frac = abs(prev_center - this_center) / wider_width if wider_width > 0 else 0

        should_merge = (
            narrower_width > 0
            and overlap / narrower_width > OVERLAP_MERGE_FRAC
            and center_offset_frac <= CENTER_OFFSET_MERGE_FRAC
        )
        if should_merge:
            merged[-1] = (min(px0, x0), min(py0, y0), max(px1, x1), max(py1, y1))
        else:
            merged.append(box)
    return merged


def segment_cell(cell: np.ndarray) -> list[Glyph]:
    """One cell crop (a serial, mark, or total answer box) -> its
    individual glyphs, left to right, each tagged digit-vs-decimal-point.

    Returns an empty list for a blank cell — checked *before* any
    per-component classification, mirroring id_ocr.py's own "a blank
    input should never produce an arbitrary glyph shape" posture (plan.md
    §16: "A classifier always outputs something; feed it a blank cell and
    it returns a confident wrong digit").
    """
    h, w = cell.shape[:2]
    dy, dx = int(h * INSET_FRAC), int(w * INSET_FRAC)
    inset = cell[dy:h - dy, dx:w - dx] if h > 2 * dy and w > 2 * dx else cell

    gray = cv2.cvtColor(inset, cv2.COLOR_BGR2GRAY) if inset.ndim == 3 else inset
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(bw, connectivity=8)
    cell_area = inset.shape[0] * inset.shape[1]
    noise_floor = cell_area * NOISE_AREA_FRAC

    boxes = []  # (x0, y0, x1, y1), label 0 is the background
    for label in range(1, num_labels):
        x, y, cw, ch, area = stats[label]
        if area < noise_floor:
            continue
        boxes.append((x, y, x + cw, y + ch))

    if not boxes:
        return []

    boxes.sort(key=lambda b: b[0])
    boxes = _merge_overlapping(boxes)

    heights = [y1 - y0 for _, y0, _, y1 in boxes]
    max_height = float(max(heights))
    band_top = min(y0 for _, y0, _, _ in boxes)
    band_bottom = max(y1 for _, _, _, y1 in boxes)
    band_height = max(band_bottom - band_top, 1)

    glyphs = []
    for x0, y0, x1, y1 in boxes:
        height = y1 - y0
        centroid_y = (y0 + y1) / 2.0
        lower_third_start = band_top + band_height * (1 - DECIMAL_LOWER_BAND_FRAC)
        is_decimal = (
            max_height > 0
            and height < max_height * DECIMAL_HEIGHT_FRAC
            and centroid_y >= lower_third_start
        )
        glyphs.append(Glyph(image=inset[y0:y1, x0:x1], x0=x0, x1=x1, is_decimal=is_decimal))

    return glyphs
