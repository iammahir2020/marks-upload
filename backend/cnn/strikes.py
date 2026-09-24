"""Synthetic crossed-out glyphs, for training the CROSSED_OUT class.

Real crossed-out examples are scarce (one practice page so far), so most
of the class is manufactured: take an EMNIST digit, draw a strike over it
in one of the ways people actually cross things out, and label the result
CROSSED_OUT.

The strike is drawn in "photo space" — the digit scaled up and inverted to
dark ink on light paper, the way a real crop looks — and the result goes
through preprocess.py's own `_to_canvas`, the exact function inference
uses. That matters twice over:

- a strike that runs past the digit changes the ink bounding box, so the
  digit shrinks on the final canvas exactly as a real crossed-out crop's
  would;
- `render_clean` sends the UNSTRUCK digits through the same path. If only
  struck samples went through `_to_canvas` (which binarizes) while clean
  ones stayed as EMNIST's soft grey, the model could learn "binarized
  means crossed out" instead of anything about strokes — a shortcut that
  would score perfectly in training and fail on every real crop.

Pure opencv/numpy, no torch, so it can be looked at and tested without a
training install.
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from cnn.preprocess import _to_canvas  # noqa: E402

SCALE = 3      # EMNIST's 28px -> 84px photo space
PAD = 18       # room for a strike to run past the digit, as real ones do
PAPER, INK = 235, 25


def _photo_space(digit28: np.ndarray, thin: int) -> np.ndarray:
    """EMNIST's white-on-black 28x28 -> a padded, dark-on-light grayscale
    image at SCALE, i.e. roughly what a photographed glyph crop looks
    like before preprocessing.

    `thin` erodes the stroke that many times. EMNIST's strokes are bolder
    than a ballpoint's — about 17% of glyph height against ~9% on the real
    practice pages — and a strike drawn to match a too-bold digit filled
    whole glyphs solid, which no real crossing-out looks like."""
    big = cv2.resize(digit28, None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_CUBIC)
    if thin:
        big = cv2.erode(big, np.ones((3, 3), np.uint8), iterations=thin)
    big = np.pad(big, PAD)
    return (PAPER - (big.astype(np.float32) / 255.0) * (PAPER - INK)).astype(np.uint8)


def _ink_box(img: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(img < (PAPER + INK) // 2)
    if len(xs) == 0:
        h, w = img.shape
        return w // 4, h // 4, 3 * w // 4, 3 * h // 4
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def _stroke_width(img: np.ndarray) -> int:
    """The digit's own pen width, so the strike matches it — a strike
    drawn in a visibly different pen would be a second shortcut."""
    ink = (img < (PAPER + INK) // 2).astype(np.uint8)
    if ink.sum() == 0:
        return 6
    dist = cv2.distanceTransform(ink, cv2.DIST_L2, 3)
    return int(np.clip(round(2 * np.percentile(dist[ink > 0], 90)), 4, 12))


def _line(img, box, angle_deg, offset, t, rng, overshoot=(0.95, 1.3)):
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    half = 0.5 * np.hypot(x1 - x0, y1 - y0) * rng.uniform(*overshoot)
    a = np.deg2rad(angle_deg)
    # offset shifts the line perpendicular to itself, for parallel strokes
    ox, oy = -np.sin(a) * offset, np.cos(a) * offset
    p = (int(cx + ox - half * np.cos(a)), int(cy + oy - half * np.sin(a)))
    q = (int(cx + ox + half * np.cos(a)), int(cy + oy + half * np.sin(a)))
    cv2.line(img, p, q, INK, t, cv2.LINE_AA)


def _diagonal(rng) -> float:
    return rng.choice([rng.uniform(20, 70), rng.uniform(110, 160)])


def _slashes(img, box, t, rng, min_lines=1):
    n = rng.integers(min_lines, 4)
    angle = _diagonal(rng)
    gap = (box[3] - box[1]) * rng.uniform(0.12, 0.25)
    for i in range(n):
        _line(img, box, angle + rng.normal(0, 4), (i - (n - 1) / 2) * gap, t, rng)


def _horizontal(img, box, t, rng, min_lines=1):
    n = rng.integers(min_lines, 3)
    gap = (box[3] - box[1]) * rng.uniform(0.12, 0.25)
    for i in range(n):
        _line(img, box, rng.uniform(-12, 12), (i - (n - 1) / 2) * gap, t, rng)


def _cross(img, box, t, rng):
    a = rng.uniform(25, 65)
    _line(img, box, a, 0, t, rng)
    _line(img, box, 180 - a + rng.normal(0, 6), 0, t, rng)


def _hatch(img, box, t, rng):
    n = rng.integers(3, 7)
    angle = rng.choice([_diagonal(rng), rng.uniform(-10, 10)])
    span = (box[3] - box[1]) * rng.uniform(0.6, 1.0)
    for i in range(n):
        _line(img, box, angle + rng.normal(0, 5), (i / (n - 1) - 0.5) * span, t, rng, (0.7, 1.1))


def _zigzag(img, box, t, rng):
    x0, y0, x1, y1 = box
    n = rng.integers(4, 11)
    ys = np.linspace(y0, y1, n) + rng.normal(0, (y1 - y0) * 0.05, n)
    xs = np.where(np.arange(n) % 2 == 0, x0, x1) + rng.normal(0, (x1 - x0) * 0.12, n)
    if rng.random() < 0.5:  # sideways zigzag: swap the roles
        xs, ys = np.linspace(x0, x1, n), np.where(np.arange(n) % 2 == 0, y0, y1) + rng.normal(0, (y1 - y0) * 0.1, n)
    pts = np.stack([xs, ys], axis=1).astype(np.int32)
    cv2.polylines(img, [pts], False, INK, t, cv2.LINE_AA)


def _loops(img, box, t, rng):
    """The spiralling scribble people use to black a digit out."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    turns = rng.uniform(1.5, 4)
    s = np.linspace(0, turns * 2 * np.pi, int(turns * 24))
    cx = x0 + w * (0.3 + 0.4 * s / s[-1]) if rng.random() < 0.5 else np.full_like(s, x0 + w / 2)
    cy = y0 + h / 2 + rng.normal(0, h * 0.05, len(s)).cumsum() * 0.2
    rx = w * rng.uniform(0.25, 0.6) * (1 + 0.15 * np.sin(s * 0.7))
    ry = h * rng.uniform(0.2, 0.5) * (1 + 0.15 * np.cos(s * 0.5))
    pts = np.stack([cx + rx * np.cos(s), cy + ry * np.sin(s)], axis=1).astype(np.int32)
    cv2.polylines(img, [pts], False, INK, t, cv2.LINE_AA)


STYLES = [_slashes, _horizontal, _cross, _hatch, _zigzag, _loops]

# A 1 struck by ONE straight line is a 7, a 4 or a plus sign; a 7 struck by
# one horizontal line is a continental 7. Labelled CROSSED_OUT, those would
# teach the model to flag genuine digits written that way. Humans can't
# tell them apart either, so these two digits only ever get two or more
# lines from the single-line styles.
SINGLE_LINE_AMBIGUOUS = {1, 7}


def _thinning(rng: np.random.Generator) -> int:
    return int(rng.choice([0, 1, 1, 2]))


# Share of clean 7s given a continental crossbar. EMNIST is American
# handwriting and has almost none, so the first CROSSED_OUT model called a
# real barred 7 in testset/ (real_class_13's serial "07") crossed out at
# P=0.79 — a 1 or 7 with a line through it is precisely what the class
# learns from. Teaching it the barred 7 as a 7 is the fix; a higher floor
# would only have hidden it.
BARRED_SEVEN_FRACTION = 0.35


def _crossbar(img: np.ndarray, t: int, rng: np.random.Generator) -> None:
    """A short bar across a 7's stem at mid-height, the way it is written
    in much of the world: centred on the stem, not spanning the glyph."""
    x0, y0, x1, y1 = _ink_box(img)
    y = int(y0 + (y1 - y0) * rng.uniform(0.45, 0.6))
    cols = np.nonzero(img[y] < (PAPER + INK) // 2)[0]
    cx = int(cols.mean()) if len(cols) else (x0 + x1) // 2
    half = int((x1 - x0) * rng.uniform(0.2, 0.35))
    tilt = int(rng.normal(0, 2))
    cv2.line(img, (cx - half, y + tilt), (cx + half, y - tilt), INK, t, cv2.LINE_AA)


def render_clean(digit28: np.ndarray, digit: int, rng: np.random.Generator) -> np.ndarray:
    """An EMNIST digit through the same photo-space + `_to_canvas` path as
    a struck one, unstruck. See the module docstring for why this exists."""
    img = _photo_space(digit28, _thinning(rng))
    if digit == 7 and rng.random() < BARRED_SEVEN_FRACTION:
        _crossbar(img, max(3, int(_stroke_width(img) * rng.uniform(0.6, 1.0))), rng)
    return _to_canvas(img)


def render_struck(digit28: np.ndarray, digit: int, rng: np.random.Generator) -> np.ndarray:
    """An EMNIST digit (whose label is `digit`) with one or two strike
    styles drawn over it, as the 28x28 canvas inference would produce for
    a real crop of it."""
    img = _photo_space(digit28, _thinning(rng))
    box = _ink_box(img)
    t = max(3, int(_stroke_width(img) * rng.uniform(0.6, 1.0)))
    min_lines = 2 if digit in SINGLE_LINE_AMBIGUOUS else 1
    for i in range(1 if rng.random() < 0.65 else 2):
        style = STYLES[rng.integers(len(STYLES))]
        if style in (_slashes, _horizontal):
            style(img, box, t, rng, min_lines=min_lines if i == 0 else 1)
        else:
            style(img, box, t, rng)
    return _to_canvas(img)
