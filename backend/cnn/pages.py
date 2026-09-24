"""Photographed practice pages -> labelled glyph crops, for training.

A practice page is loose digits written in rows on plain paper — no
template. The row a glyph sits in is its label, so nothing is tagged by
hand: a row of 7s labels itself, and so does a row of crossed-out
scribbles, whose underlying digit never matters. This is how the
CROSSED_OUT class (classes.py) got real examples at all.

The pages and their manifest live in training_data/pages/, gitignored —
real handwriting, same as the harvested crops. The manifest,
pages.json, looks like:

    {"pages": [
      {"file": "clean_rows_01.jpg", "box": [x0, y0, x1, y1],
       "rows": ["0", "1", "2", ...]},
      {"file": "crossed_01.jpg", "box": [...],
       "rows": ["x", "x", ...], "holdout_rows": [10, 11, 12]}
    ]}

Each `rows` entry describes one physical row, top to bottom:

    null          skip the row (e.g. already covered by another photo)
    "x"           every glyph in the row is crossed out
    "7"           every glyph in the row is a 7
    "78912345"    one label per glyph, left to right; a "-" in place of
                  a digit skips that one glyph (a crop the binding cut
                  through, or a 1 written so it looks more like a 7 —
                  trained as a 1, it would teach the model 7s are 1s)

`box` is the page area in pixels, keeping the spiral binding and the desk
out of the crop. A row whose glyph count disagrees with its label string
is skipped with a warning rather than guessed at — the same posture as
column_count_mismatch, one level down.

Pure opencv/numpy, no torch: cnn/crossed_accuracy.py reads the held-out
rows through here without needing a training install.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from cnn.classes import CROSSED_OUT  # noqa: E402

PAGES_DIR = Path(__file__).resolve().parent.parent / "training_data" / "pages"

# Ink is grouped into glyphs by dilating first, so a glyph written in two
# strokes (a 4, a 5's separate top bar) comes out as one crop. The kernel
# is a fraction of the page's median glyph height rather than a pixel
# constant, for the same reason detection is proportional: photos are
# taken at different distances. 0.14 measured on the first four pages
# (~50-74px glyphs, 9-10px kernel): whole glyphs, no neighbours joined.
GROUP_KERNEL_FRAC = 0.14

# A blob shorter than this fraction of the row's median height is a
# fragment (a pen lift the dilation didn't bridge, a speck), not a glyph.
# Dropping it matters more than it looks: kept, it would be trained as a
# full example of the row's label.
FRAGMENT_HEIGHT_FRAC = 0.4

# Blobs whose centres sit within this fraction of the median glyph height
# of a row's running mean y belong to that row.
ROW_TOLERANCE_FRAC = 0.6


@dataclass
class LabelledGlyph:
    image: np.ndarray  # BGR crop, tight to the ink plus a small margin
    label: int         # 0-9, or CROSSED_OUT
    page: str
    row: int
    holdout: bool


def _ink_mask(gray: np.ndarray) -> np.ndarray:
    # Adaptive, not Otsu over the whole page: lighting falls off across a
    # phone photo of a full sheet far more than across one template cell.
    bw = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 51, 20
    )
    return cv2.morphologyEx(bw, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))


def cut_page(page: np.ndarray) -> list[list[np.ndarray]]:
    """A cropped page image -> its glyph crops, as rows (top to bottom) of
    glyphs (left to right)."""
    gray = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY) if page.ndim == 3 else page
    ink = _ink_mask(gray)

    # A first, undilated pass only to measure glyph height for the kernel.
    n, _, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    heights = [stats[i][3] for i in range(1, n) if stats[i][4] > 50]
    if not heights:
        return []
    k = max(3, int(round(np.median(heights) * GROUP_KERNEL_FRAC)))

    grouped = cv2.dilate(ink, np.ones((k, k), np.uint8))
    n, _, stats, centroids = cv2.connectedComponentsWithStats(grouped, connectivity=8)
    blobs = [(stats[i], centroids[i]) for i in range(1, n) if stats[i][4] > 4 * k * k]
    if not blobs:
        return []
    median_h = float(np.median([s[3] for s, _ in blobs]))

    blobs.sort(key=lambda b: b[1][1])
    rows: list[list] = []
    for blob in blobs:
        if rows and abs(blob[1][1] - np.mean([b[1][1] for b in rows[-1]])) < median_h * ROW_TOLERANCE_FRAC:
            rows[-1].append(blob)
        else:
            rows.append([blob])

    out = []
    for row in rows:
        row_h = float(np.median([s[3] for s, _ in row]))
        row = [b for b in row if b[0][3] >= row_h * FRAGMENT_HEIGHT_FRAC]
        row.sort(key=lambda b: b[1][0])
        crops = []
        for s, _ in row:
            x, y, w, h = int(s[0]), int(s[1]), int(s[2]), int(s[3])
            crops.append(page[max(0, y):y + h, max(0, x):x + w])
        out.append(crops)
    return out


def _row_labels(spec: str | None, count: int) -> list[int | None] | None:
    if spec is None:
        return None
    if spec == "x":
        return [CROSSED_OUT] * count
    if len(spec) == 1:
        return [int(spec)] * count
    if len(spec) != count:
        return None
    return [None if c == "-" else int(c) for c in spec]


def load_pages(pages_dir: Path = PAGES_DIR) -> list[LabelledGlyph]:
    manifest_path = pages_dir / "pages.json"
    if not manifest_path.exists():
        return []
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    glyphs: list[LabelledGlyph] = []
    for entry in manifest["pages"]:
        image = cv2.imread(str(pages_dir / entry["file"]))
        if image is None:
            print(f"pages: cannot read {entry['file']}, skipped", file=sys.stderr)
            continue
        x0, y0, x1, y1 = entry["box"]
        rows = cut_page(image[y0:y1, x0:x1])
        specs = entry["rows"]
        if len(rows) != len(specs):
            print(
                f"pages: {entry['file']} has {len(rows)} rows, manifest says "
                f"{len(specs)} — whole page skipped",
                file=sys.stderr,
            )
            continue
        holdout = set(entry.get("holdout_rows", []))
        for r, (crops, spec) in enumerate(zip(rows, specs)):
            labels = _row_labels(spec, len(crops))
            if labels is None:
                if spec is not None:
                    print(
                        f"pages: {entry['file']} row {r + 1} has {len(crops)} glyphs, "
                        f"label '{spec}' has {len(spec)} — row skipped",
                        file=sys.stderr,
                    )
                continue
            for crop, label in zip(crops, labels):
                if label is None:
                    continue
                glyphs.append(LabelledGlyph(crop, label, entry["file"], r, r in holdout))
    return glyphs
