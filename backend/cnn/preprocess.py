"""MNIST-matched preprocessing (step.md step 2r.2, plan.md §16 "Model and
training"): turn one real, photographed digit crop into the exact 28x28
format EMNIST/MNIST images are in, so a model trained on EMNIST doesn't
have to generalize across a format mismatch on top of a handwriting-style
mismatch.

Deliberately kept free of torch — this is pure image processing (opencv +
numpy + scipy), reusable by training, the visual-inspection step below,
and eventually inference (step 3r.4) without forcing a torch import
anywhere that doesn't already need one.

Getting this exactly right matters more than any architecture choice
(plan.md §16): a model scoring 99% on EMNIST's own test set can perform
badly on real crops if this preprocessing doesn't match how MNIST/EMNIST
were actually built. The single most common way to get it subtly wrong is
centering the glyph by its bounding-box centre instead of its centre of
mass — it looks correct and costs several points of accuracy, because
that's not the distribution the model was trained on.
"""
from __future__ import annotations

import cv2
import numpy as np
from scipy import ndimage

INSET_FRAC = 0.12  # same fixed fraction id_ocr.py already established —
                     # the raw crop's edge is the cell's own ruled border,
                     # which reads as extra ink if left in (learn.md step 2).
CANVAS_SIZE = 28
TARGET_INK_SIZE = 20  # MNIST's own convention: longest side of the ink
                        # bounding box scaled to 20px, leaving a 4px margin
                        # on each side of the 28x28 canvas before centering.


# --- Is there anything in this cell at all? (issues.md N4) ----------------
#
# `segment_cell` guards blank cells for serial and marks, citing plan.md
# §16: "A classifier always outputs something; feed it a blank cell and it
# returns a confident wrong digit." The ID path had no equivalent, and the
# ID is the field with NO arithmetic check behind it — no sum, no second
# opinion — so a fabricated digit there has nothing downstream to catch it.
#
# What makes a blank cell dangerous rather than merely empty is Otsu:
# `_to_canvas` thresholds with THRESH_OTSU, which always splits the
# histogram, including a unimodal one. Blank paper therefore produces
# "ink" — noise — which gets bounding-boxed, scaled to 20px and classified
# like a real glyph. The only thing behind it was
# CONFIDENCE_FLOOR/MARGIN_FLOOR, calibrated in cnn/accuracy.py against real
# handwritten digits and never against input containing no digit at all.
#
# Ink is measured the way detection.py measures it — pixels at least
# CONTRAST_FLOOR (30/255) darker than the cell's own paper — rather than by
# a global threshold, because paper brightness varies per photo and per
# cell.
INK_CONTRAST_FLOOR = 30

# The test is the LARGEST CONNECTED COMPONENT, not total ink. Total ink was
# the first attempt and it separated the real data perfectly, but a lone
# speck of a few pixels also cleared it — a test caught that, not
# inspection. Asking "is there a blob big enough to be a stroke" is both
# stricter and the same question `segment_cell` already asks of a mark cell.
#
# Calibrated 2026-08-31 over every ID cell in testset/labels.json that
# detection reads successfully:
#
#     FILLED  n=168   min 0.00163   p5 0.02234   median 0.05360
#     BLANK   n=7     max 0.00041   (6 of 7 are exactly 0.0)
#
# 0.0015 separates them with nothing misclassified either way.
#
# It is deliberately its OWN constant despite currently equalling
# cnn/segment.py's NOISE_AREA_FRAC — the same reasoning detection.py already
# records for LABEL_COLUMN_NOISE_AREA_FRAC. The two answer a similar
# question ("stroke or noise?") on different inputs, and tuning segmentation
# for a decimal point should not silently move the ID's blank gate.
#
# Two honest caveats. The blank sample is n=7 from ONE photo
# (empty_file.jpeg, the only blank grid in the test set), so the 3.7x margin
# above blank rests on thin evidence. And the margin below the faintest real
# digit is only 1.09x — that digit, and the next three faintest, are all
# "1"s, which is structural: a single thin stroke is the least ink any digit
# can have. A "1" is what sets this constraint and is where to look first if
# it needs revisiting. The failure it would cause is the cheap one — "?"
# plus a flag, which the instructor fixes — not a fabricated digit.
MIN_GLYPH_AREA_FRAC = 0.0015


def has_ink(crop: np.ndarray) -> bool:
    """True if this cell holds a blob big enough to be a written digit.

    Callers treat False exactly as they treat a missing crop: "?" plus a
    flag, never a guess (plan.md §10).
    """
    if crop is None or crop.size == 0:
        return False
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    h, w = gray.shape[:2]
    dy, dx = int(h * INSET_FRAC), int(w * INSET_FRAC)
    inset = gray[dy:h - dy, dx:w - dx] if h > 2 * dy and w > 2 * dx else gray
    if inset.size == 0:
        return False

    # The cell's own paper, not a global constant: p90 rather than max, so a
    # single specular highlight cannot raise the bar for the whole cell.
    paper = float(np.percentile(inset, 90))
    mask = (((paper - inset.astype(int)) >= INK_CONTRAST_FLOOR) * 255).astype(np.uint8)

    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:  # label 0 is the background
        return False
    largest = max(stats[i, cv2.CC_STAT_AREA] for i in range(1, count))
    # bool(), not the numpy bool the comparison produces: this is annotated
    # `-> bool` and callers write `if not has_ink(crop)`. A np.bool_ works
    # there but fails an `is True` identity check, which is how the tests
    # caught it.
    return bool(largest / inset.size >= MIN_GLYPH_AREA_FRAC)


def preprocess_for_cnn(crop: np.ndarray) -> np.ndarray:
    """One real ID-digit crop (BGR or grayscale), straight off the
    template's own boxed cell -> a 28x28 uint8 grayscale image, white ink
    on black, MNIST-normalized. The 12% inset here trims the cell's own
    ruled border, which otherwise reads as extra ink (learn.md step 2) —
    appropriate for this input shape specifically, a whole labelled cell
    with a visible border on every side.

    Do not reuse this for an already-segmented glyph (cnn/segment.py's
    output) — use `glyph_to_canvas` instead. Found the hard way (step
    3r): a segmented glyph is already a tight crop of just the ink, with
    no border to trim, and running it through this function's inset a
    second time clips real strokes off the edges — a real "3" came out
    looking enough like a "2" to be misread with high confidence. See
    learn.md step 3r.
    """
    h, w = crop.shape[:2]
    dy, dx = int(h * INSET_FRAC), int(w * INSET_FRAC)
    inset = crop[dy:h - dy, dx:w - dx] if h > 2 * dy and w > 2 * dx else crop
    return _to_canvas(inset)


def glyph_to_canvas(glyph: np.ndarray) -> np.ndarray:
    """An already-segmented glyph (cnn/segment.py's `Glyph.image` — tight
    to the ink, no cell border present) -> the same 28x28 MNIST-normalized
    canvas `preprocess_for_cnn` produces, but skipping the border inset
    that function applies, since there is no border here to trim."""
    return _to_canvas(glyph)


def _to_canvas(inset: np.ndarray) -> np.ndarray:
    """Shared core: Otsu binarize, crop to the ink bounding box, scale to
    20px, paste onto a 28x28 canvas centred by centre of mass. Takes an
    image that's already had any appropriate border trimmed (or none, for
    an already-tight glyph) — see the two public entry points above."""
    gray = cv2.cvtColor(inset, cv2.COLOR_BGR2GRAY) if inset.ndim == 3 else inset

    # THRESH_BINARY_INV, not id_ocr.py's THRESH_BINARY: a real crop is dark
    # ink on light paper, but EMNIST/MNIST's convention is white ink on a
    # black background — inverting here is what makes the two comparable
    # at all, not an arbitrary choice.
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    ys, xs = np.nonzero(bw)
    if len(xs) == 0:
        return np.zeros((CANVAS_SIZE, CANVAS_SIZE), dtype=np.uint8)

    x0, x1 = xs.min(), xs.max() + 1
    y0, y1 = ys.min(), ys.max() + 1
    ink = bw[y0:y1, x0:x1]

    ih, iw = ink.shape
    scale = TARGET_INK_SIZE / max(ih, iw)
    new_w, new_h = max(1, round(iw * scale)), max(1, round(ih * scale))
    resized = cv2.resize(ink, (new_w, new_h), interpolation=cv2.INTER_AREA)

    canvas = np.zeros((CANVAS_SIZE, CANVAS_SIZE), dtype=np.uint8)

    # Centre by centre of mass, not bounding-box centre (plan.md §16's own
    # emphasis) — this is literally how MNIST itself was constructed, and
    # the model's whole training distribution assumes it.
    com_y, com_x = ndimage.center_of_mass(resized)
    if np.isnan(com_y) or np.isnan(com_x):
        # resize produced an all-zero image (can happen for a hairline
        # glyph shrunk below the resample kernel's support) — fall back to
        # geometric centering rather than pasting at a NaN offset.
        com_y, com_x = new_h / 2.0, new_w / 2.0

    top = int(round(CANVAS_SIZE / 2.0 - com_y))
    left = int(round(CANVAS_SIZE / 2.0 - com_x))

    # Clip the paste region — an off-centre glyph's centre of mass can push
    # part of it past the canvas edge (rare, but a bounding-box-sized 20px
    # glyph off-centre by even a few px can just clip a corner).
    src_top = max(0, -top)
    src_left = max(0, -left)
    dst_top = max(0, top)
    dst_left = max(0, left)
    copy_h = min(new_h - src_top, CANVAS_SIZE - dst_top)
    copy_w = min(new_w - src_left, CANVAS_SIZE - dst_left)
    if copy_h > 0 and copy_w > 0:
        canvas[dst_top:dst_top + copy_h, dst_left:dst_left + copy_w] = (
            resized[src_top:src_top + copy_h, src_left:src_left + copy_w]
        )

    return canvas
