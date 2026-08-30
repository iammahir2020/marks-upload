"""Glyph-level ONNX inference: turn one preprocessed 28x28 canvas into a
class-probability vector, with test-time augmentation (plan.md §16 —
inference is ~1ms, so averaging a few small perturbations is free and
measurably helps borderline cases). This is the one place onnxruntime
actually gets called; segment.py and decode.py stay pure so their own
tests never need a model.

Used by both cnn/accuracy.py (step 2r.4, single boxed ID digits) and
app/recognizers/local.py (step 3r.4, segmented serial/mark glyphs) — one
inference primitive, two different decoding strategies built on top of it
(decode.decide_digit for a single glyph, decode.decode_value for a
constrained multi-glyph cell).
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime

sys.path.insert(0, str(Path(__file__).parent.parent))
from cnn.decode import decide_digit  # noqa: E402

MNIST_MEAN, MNIST_STD = 0.1307, 0.3081  # must match train.py's own normalization exactly

# Small rotation/translation perturbations, cheap enough to run every
# time (plan.md §16) — identity plus 4 small variants, averaged.
TTA_OFFSETS = [
    (0.0, 0.0, 0.0),
    (-4.0, 0.0, 0.0),
    (4.0, 0.0, 0.0),
    (0.0, 1.0, 0.0),
    (0.0, 0.0, 1.0),
]


def _augment(canvas: np.ndarray, degrees: float, dx: float, dy: float) -> np.ndarray:
    if degrees == 0.0 and dx == 0.0 and dy == 0.0:
        return canvas
    center = (canvas.shape[1] / 2, canvas.shape[0] / 2)
    m = cv2.getRotationMatrix2D(center, degrees, 1.0)
    m[0, 2] += dx
    m[1, 2] += dy
    return cv2.warpAffine(canvas, m, (canvas.shape[1], canvas.shape[0]), borderValue=0)


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=-1, keepdims=True)


def glyph_probs(session: onnxruntime.InferenceSession, canvas: np.ndarray) -> np.ndarray:
    """One preprocessed 28x28 canvas -> a (10,) probability vector,
    averaged over TTA_OFFSETS' perturbations."""
    variants = [_augment(canvas, *offset) for offset in TTA_OFFSETS]
    batch = np.stack(variants).astype(np.float32) / 255.0
    batch = (batch - MNIST_MEAN) / MNIST_STD
    batch = batch[:, None, :, :]  # (N, 1, 28, 28)

    logits = session.run(None, {"input": batch})[0]
    return _softmax(logits).mean(axis=0)


def predict_digit(
    session: onnxruntime.InferenceSession,
    canvas: np.ndarray,
    confidence_floor: float,
    margin_floor: float,
) -> tuple[str | None, float, float]:
    """One canvas -> (digit-string or None, confidence, margin). Used
    directly where a cell holds exactly one glyph (the ID) or one glyph
    at a time within a segmented cell (serial's per-position decode)."""
    probs = glyph_probs(session, canvas)
    digit, confidence, margin = decide_digit(probs, confidence_floor, margin_floor)
    return (str(digit) if digit is not None else None), confidence, margin
