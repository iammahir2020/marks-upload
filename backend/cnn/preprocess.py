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
