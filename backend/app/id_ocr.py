"""Local student ID recognition (step.md step 2). Runs entirely on the
laptop, never sends a crop anywhere — this is *why* it's local, not just
how (plan.md §12: the student ID is what makes a photo personally
identifying, so it never reaches Gemini).

Has no arithmetic guard and no second opinion the way marks do (no sum
check exists for a 7-digit ID) — flag uncertainty rather than guess.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytesseract

OEM = 3
PSM = 8  # "single word" — stack-reference.md suggested 10 ("single character"),
         # but measured against a real photo, 10 completely failed to recognize
         # two clean, legible digits ("6" and "1") that 8 read correctly, with
         # every other digit unaffected — see learn.md step 2.
WHITELIST = "0123456789"
CONFIDENCE_FLOOR = 35.0  # stack-reference.md suggested 60 as a starting point;
                          # against the one real photo measured so far, correct
                          # reads landed at 39-41 confidence under psm 8, so 60
                          # rejected every correct digit. Lowered to let those
                          # through. This is calibrated from a single photo and
                          # is exactly as provisional as that implies — see
                          # learn.md step 2. Revisit once more real, differently-
                          # handwritten photos exist.

# tessedit_char_whitelist doesn't make the LSTM engine reconsider within the
# digit alphabet when its best unconstrained guess is a letter — it just
# drops the result to nothing, even when that guess is high-confidence and
# unambiguous. Measured directly against real phone crops (id_ocr_accuracy.py
# on the step 6/7 test session, see learn.md step 2): a handwritten "0" read
# as "D" at 86% confidence, and a handwritten "1" read as "l" at 90% — both
# comfortably above CONFIDENCE_FLOOR, both silently discarded by the
# whitelist pass, both flagged uncertain instead of read. FALLBACK_PSM=7
# ("single text line") is what those two crops were actually read under;
# psm 8 gave a much worse, lower-confidence guess for the same "1" crop.
# The rest of this map are standard, widely-documented OCR digit/letter
# look-alikes, included on that general reputation rather than measured
# here directly — same conservative bar applies (FALLBACK_CONFIDENCE_FLOOR),
# so an unevidenced mapping firing on a genuinely wrong shape still won't
# clear it.
FALLBACK_PSM = 7
FALLBACK_CONFIDENCE_FLOOR = 60.0
DIGIT_LOOKALIKES = {
    "o": "0", "O": "0", "D": "0", "Q": "0",
    "l": "1", "I": "1", "i": "1", "|": "1",
    "z": "2", "Z": "2",
    "s": "5", "S": "5",
    "b": "6", "G": "6",
    "g": "9", "q": "9",
    "B": "8",
}


INSET_FRAC = 0.12  # trim this fraction off each edge before anything else


def _prepare(crop: np.ndarray) -> np.ndarray:
    """Pad, threshold, and scale one digit crop (step 2.1). Tesseract does
    poorly on a tightly-cropped glyph touching the frame edge."""
    h, w = crop.shape[:2]
    dy, dx = int(h * INSET_FRAC), int(w * INSET_FRAC)
    # detection.py's cell boundaries sit on the ruled line itself, so the
    # raw crop includes a sliver of the table's own border — left in, that
    # dark sliver reads as more "ink" than the digit and tanks recognition
    # (found via a real crop: id_d1.png, "2", had a visible black edge
    # strip — see learn.md step 2).
    inset = crop[dy:h - dy, dx:w - dx] if h > 2 * dy and w > 2 * dx else crop

    gray = cv2.cvtColor(inset, cv2.COLOR_BGR2GRAY) if inset.ndim == 3 else inset
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    pad = max(bw.shape) // 4
    padded = cv2.copyMakeBorder(bw, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)

    scale = 200 / max(padded.shape)
    if scale > 1:
        padded = cv2.resize(padded, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return padded


def _best_candidate(prepared: np.ndarray, config: str) -> tuple[str | None, float]:
    data = pytesseract.image_to_data(prepared, config=config, output_type=pytesseract.Output.DICT)
    best_text, best_conf = None, -1.0
    for text, conf in zip(data["text"], data["conf"]):
        text = text.strip()
        conf = float(conf)
        if text and conf > best_conf:
            best_text, best_conf = text, conf
    return best_text, best_conf


def read_digit(crop: np.ndarray) -> tuple[str | None, float]:
    """Read one digit crop (step 2.2–2.3). Returns (digit, confidence) —
    digit is None if nothing usable was found. Uses image_to_data, not
    image_to_string — only the former returns a confidence column.

    Two passes: the whitelisted digit-only read first (fast path, correct
    for anything that already looks like a digit to Tesseract), then an
    unconstrained fallback that catches the specific failure mode measured
    in real crops — a correct digit read as a look-alike letter at high
    confidence, then discarded by the whitelist instead of falling back
    (DIGIT_LOOKALIKES above)."""
    prepared = _prepare(crop)

    config = f"--oem {OEM} --psm {PSM} -c tessedit_char_whitelist={WHITELIST}"
    best_text, best_conf = _best_candidate(prepared, config)
    if best_text and len(best_text) == 1 and best_conf >= CONFIDENCE_FLOOR:
        return best_text, best_conf

    fallback_config = f"--oem {OEM} --psm {FALLBACK_PSM}"
    fallback_text, fallback_conf = _best_candidate(prepared, fallback_config)
    if (
        fallback_text
        and len(fallback_text) == 1
        and fallback_text in DIGIT_LOOKALIKES
        and fallback_conf >= FALLBACK_CONFIDENCE_FLOOR
    ):
        return DIGIT_LOOKALIKES[fallback_text], fallback_conf

    return None, max(best_conf, 0.0)


def read_id(cells_dir: Path, id_digits: int) -> tuple[str, list[str]]:
    """Read all id_d*.png crops for one script, in digit order.

    Always returns a best-guess id_digits-length string — an unreadable
    position becomes '?', never a silently-dropped digit — so the review
    screen has something to correct rather than a blank box to retype from
    scratch. Separately reports low_confidence_fields for the instructor to
    check: flag, never guess (plan.md §10), but flagging isn't withholding.
    """
    digits = []
    uncertain = False
    for i in range(1, id_digits + 1):
        crop_path = cells_dir / f"id_d{i}.png"
        if not crop_path.exists():
            digits.append("?")
            uncertain = True
            continue

        crop = cv2.imread(str(crop_path))
        digit, _ = read_digit(crop)
        if digit is None:
            digits.append("?")
            uncertain = True
        else:
            digits.append(digit)

    student_id = "".join(digits)
    low_confidence_fields = ["student_id"] if uncertain else []
    return student_id, low_confidence_fields
