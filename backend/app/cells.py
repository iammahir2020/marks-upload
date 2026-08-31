"""Reading the cell crops `detection.py` writes (issues.md N18).

One function, in one place, because the same two-line mistake was made at
five call sites across three modules: `cv2.imread` returns **None** rather
than raising for a file that exists but cannot be decoded, and every caller
then did `crop.shape` on it. That is an `AttributeError` escaping a route
handler — a 500 — where the honest answer is the one this project gives
everywhere else: treat the field as unreadable, flag it, and let the
instructor retake or type it.

`path.exists()` is not the check. These files were written moments earlier
by this same request, so "missing" is the case the callers already handled;
"present but truncated, zero-length, or not a PNG" is the case none of them
did.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def read_cell(path: Path) -> np.ndarray | None:
    """A cell crop as BGR, or None if it is missing or undecodable.

    Callers must treat None the same way they already treat a missing crop
    — flag, never guess.
    """
    if not path.exists():
        return None
    image = cv2.imread(str(path))
    if image is None or image.size == 0:
        return None
    return image
