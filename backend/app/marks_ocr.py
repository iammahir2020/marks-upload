"""Local OCR fallback for serial and marks, used only when Gemini itself
is unavailable (main.py: marks.recognize() returned "rate_limited" or
"model_error"). This is not a replacement for marks.py's Gemini call —
marks are decimal values drawn from a legal set per question, and Gemini's
response_schema is what makes reading them reliably possible. Tesseract has
no equivalent way to be told "only 0, 0.5, 1, ..., max are legal here"; it
just reads text. This exists so a rate-limited session doesn't force the
instructor to hand-type every field for every remaining script, not to
match Gemini's accuracy.

Because of that gap, everything this reads is unconditionally flagged
low-confidence — even a value that parses and is legal — and every value
still has to clear the same legal-value check marks.py already enforces on
Gemini's own output (validate_payload). See learn.md.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import pytesseract

from .id_ocr import OEM, _prepare
from .marks import MarksResult, legal_values

# Single text line, not id_ocr.py's single-*character* PSM 8/10 — these
# crops hold a short string (a 1-3 digit serial, a "4.5"-shaped mark), not
# one isolated glyph. Matches id_ocr.py's own evidenced fallback pass.
FALLBACK_PSM = 7
DIGIT_WHITELIST = "0123456789"
MARK_WHITELIST = "0123456789."


def _read_field(crop_path: Path, whitelist: str) -> str | None:
    if not crop_path.exists():
        return None
    crop = cv2.imread(str(crop_path))
    prepared = _prepare(crop)
    config = f"--oem {OEM} --psm {FALLBACK_PSM} -c tessedit_char_whitelist={whitelist}"
    data = pytesseract.image_to_data(prepared, config=config, output_type=pytesseract.Output.DICT)
    tokens = [t.strip() for t in data["text"] if t.strip()]
    return "".join(tokens) if tokens else None


def _parse_legal_mark(text: str | None, max_mark: float) -> float | None:
    """Reject anything that doesn't parse or isn't in the legal set — the
    same rule marks.py's validate_payload applies to Gemini's own output.
    Never store a value that fails this, fallback or not."""
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    return value if value in legal_values(max_mark) else None


def recognize_locally(cells_dir: Path, question_maxes: list[float]) -> MarksResult | None:
    """Best-effort local read of serial.png and marks_r1_c*.png — the same
    crops build_composite would have tiled for Gemini, never an id_d*.png
    (plan.md §12's ID-privacy boundary doesn't change for this path either;
    it just isn't in scope here — this function never opens one).

    Returns None if nothing at all was recoverable, so the caller can fall
    back to the original Gemini failure rather than presenting an
    all-blank "ok" result as if it were a normal, if very uncertain, scan.
    """
    # Every field this function touches is flagged, whether or not a value
    # came back — an unread field needs the flag so the instructor notices
    # it's blank-because-unrecognized rather than blank-because-the-student
    # left it blank (marks.py's validate_payload does the same for a
    # rejected Gemini read), and a *recovered* field is flagged anyway on
    # top of that, since this whole path is deliberately weaker than a
    # fresh Gemini read even when it does parse and land in the legal set.
    low_confidence_fields: list[str] = ["serial"]
    serial = _read_field(cells_dir / "serial.png", DIGIT_WHITELIST) or None

    questions: list[float | None] = []
    for i, max_mark in enumerate(question_maxes):
        low_confidence_fields.append(f"q{i + 1}")
        text = _read_field(cells_dir / f"marks_r1_c{i}.png", MARK_WHITELIST)
        questions.append(_parse_legal_mark(text, max_mark))

    low_confidence_fields.append("total")
    total_max = sum(question_maxes)
    total_text = _read_field(cells_dir / f"marks_r1_c{len(question_maxes)}.png", MARK_WHITELIST)
    total = _parse_legal_mark(total_text, total_max)

    recovered_anything = serial is not None or any(q is not None for q in questions) or total is not None
    if not recovered_anything:
        return None

    return MarksResult(
        status="ok",
        serial=serial,
        questions=questions,
        total=total,
        low_confidence_fields=low_confidence_fields,
    )
