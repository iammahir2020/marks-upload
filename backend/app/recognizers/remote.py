"""RemoteRecognizer (step.md step 2r.0.2): the existing Gemini + Tesseract
path (steps 2 and 3), including the rate-limited local-OCR fallback
(step 3's marks_ocr.py addition), wrapped behind the Recognizer protocol.

Moved, not rewritten — id_ocr.py, marks.py, and marks_ocr.py are untouched;
this only relocates the fallback decision that used to live in main.py
(marks.recognize fails -> try marks_ocr.recognize_locally) into the one
path that actually has that behavior, and calls the three modules by
attribute (`id_ocr.read_id(...)`, not `from ..id_ocr import read_id`) so
their original module-level names stay the natural place to mock in tests,
unchanged by this move.
"""
from __future__ import annotations

from pathlib import Path

from .. import id_ocr, marks, marks_ocr
from ..marks import MarksResult
from .base import IdResult


class RemoteRecognizer:
    name = "remote"

    def read_id(self, cells_dir: Path, id_digits: int) -> IdResult:
        student_id, low_confidence_fields = id_ocr.read_id(cells_dir, id_digits)
        return IdResult(student_id=student_id, low_confidence_fields=low_confidence_fields)

    def read_marks(self, cells_dir: Path, question_maxes: list[float]) -> MarksResult:
        result = marks.recognize(cells_dir, question_maxes)
        if result.status != "ok":
            # Gemini itself failed (rate_limited/model_error), not
            # detection — cells_dir already has real crops. Try the local,
            # deliberately weaker OCR read before giving up entirely
            # (step.md step 3's rate-limited addition). recognize_locally
            # returns None if it couldn't recover anything, in which case
            # this falls through to the original Gemini failure below,
            # same as before this move.
            fallback = marks_ocr.recognize_locally(cells_dir, question_maxes)
            if fallback is not None:
                return fallback
        return result
