"""CNNRecognizer (step.md step 3r.4): the local CNN path implementing the
Recognizer protocol from step 2r.0. ID digits (step 2r, one boxed glyph
per cell — no segmentation needed) and serial/marks/total (step 3r,
segmented then constrained-decoded) both go through the same trained
model, `cnn/checkpoints/digit_cnn.onnx`.

Imports from `cnn/` — a sibling of `app/`, not a subpackage of it, since
that's where the optional, torch-adjacent CNN track lives (kept out of
`app/` so the default RECOGNIZER=remote path never needs onnxruntime
installed). The sys.path insert below is the same defensive one every
`cnn/*.py` script already uses, so this resolves correctly regardless of
whether the app is launched with `backend/` already on sys.path.
"""
from __future__ import annotations

import sys
from pathlib import Path

import onnxruntime

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from cnn.decode import DECODE_FLOOR, decode_serial, decode_value  # noqa: E402
from cnn.id_infer import glyph_probs, predict_digit  # noqa: E402
from cnn.preprocess import glyph_to_canvas, has_ink, preprocess_for_cnn  # noqa: E402
from cnn.segment import Glyph, segment_cell  # noqa: E402
from cnn.thresholds import CONFIDENCE_FLOOR as ID_CONFIDENCE_FLOOR  # noqa: E402
from cnn.thresholds import MARGIN_FLOOR as ID_MARGIN_FLOOR  # noqa: E402
from cnn.thresholds import SERIAL_CONFIDENCE_FLOOR, SERIAL_MARGIN_FLOOR  # noqa: E402

from ..cells import read_cell
from ..marks import MarksResult, legal_values
from .base import IdResult

DEFAULT_MODEL_PATH = Path(__file__).resolve().parent.parent.parent / "cnn" / "checkpoints" / "digit_cnn.onnx"

# Floors: cnn/thresholds.py (issues.md N16).


def _digit_glyphs_and_decimal_index(glyphs: list[Glyph]) -> tuple[list[Glyph], int | None]:
    digit_glyphs = [g for g in glyphs if not g.is_decimal]
    decimal_index = next((i for i, g in enumerate(glyphs) if g.is_decimal), None)
    return digit_glyphs, decimal_index


class CNNRecognizer:
    name = "cnn"

    def __init__(self, model_path: Path | None = None) -> None:
        path = model_path or DEFAULT_MODEL_PATH
        if not path.exists():
            raise FileNotFoundError(
                f"CNNRecognizer needs a trained model at {path} — run "
                "`cnn/train.py` first (step.md step 2r)."
            )
        self._session = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])

    def read_id(self, cells_dir: Path, id_digits: int) -> IdResult:
        """One boxed digit per cell (step 2/2r) — no segmentation needed,
        the template already does it. Mirrors id_ocr.read_id's own
        contract: an unreadable position becomes '?' plus a flag, never a
        silently dropped digit (plan.md §10)."""
        digits = []
        uncertain = False
        for i in range(1, id_digits + 1):
            # Three ways this position yields "?" rather than a digit, and
            # they are deliberately handled identically — flag, never guess:
            #   - the crop is missing
            #   - the crop is present but undecodable (issues.md N18)
            #   - the cell is blank (issues.md N4)
            crop = read_cell(cells_dir / f"id_d{i}.png")
            if crop is None or not has_ink(crop):
                digits.append("?")
                uncertain = True
                continue

            canvas = preprocess_for_cnn(crop)
            digit, _confidence, _margin = predict_digit(
                self._session, canvas, ID_CONFIDENCE_FLOOR, ID_MARGIN_FLOOR
            )
            if digit is None:
                digits.append("?")
                uncertain = True
            else:
                digits.append(digit)

        student_id = "".join(digits)
        return IdResult(student_id=student_id, low_confidence_fields=["student_id"] if uncertain else [])

    def read_marks(self, cells_dir: Path, question_maxes: list[float]) -> MarksResult:
        """serial.png and marks_r1_c*.png, segmented then constrained-
        decoded (step 3r). Always status="ok" — there is no network call
        here to fail the way marks.py's Gemini call can (plan.md §16:
        rate_limited is unreachable on this path); an unreadable field is
        represented the same way it always is in this project, as a None
        value plus a flag, never a "failed" scan."""
        cell_paths = [cells_dir / "serial.png"] + [
            cells_dir / f"marks_r1_c{c}.png" for c in range(len(question_maxes) + 1)
        ]
        assert all("id_d" not in p.name for p in cell_paths), (
            "an ID crop was about to be read by the marks path — this must "
            "never happen (plan.md §12), and holds for every Recognizer "
            "implementation, not just the remote one (see base.py)"
        )

        low_confidence_fields: list[str] = []

        serial = self._decode_serial_cell(cells_dir / "serial.png")
        if serial is None:
            low_confidence_fields.append("serial")

        questions: list[float | None] = []
        for i, max_mark in enumerate(question_maxes):
            value = self._decode_value_cell(cells_dir / f"marks_r1_c{i}.png", legal_values(max_mark))
            questions.append(value)
            if value is None:
                low_confidence_fields.append(f"q{i + 1}")

        total_max = sum(question_maxes)
        total_path = cells_dir / f"marks_r1_c{len(question_maxes)}.png"
        total = self._decode_value_cell(total_path, legal_values(total_max))
        if total is None:
            low_confidence_fields.append("total")

        return MarksResult(
            status="ok",
            serial=serial,
            questions=questions,
            total=total,
            low_confidence_fields=low_confidence_fields,
        )

    def _decode_serial_cell(self, path: Path) -> str | None:
        crop = read_cell(path)
        if crop is None:
            return None
        glyphs = segment_cell(crop)
        if not glyphs:
            return None  # blank cell — flag, never guess (plan.md §16)
        digit_glyphs, _decimal_index = _digit_glyphs_and_decimal_index(glyphs)
        probs = [glyph_probs(self._session, glyph_to_canvas(g.image)) for g in digit_glyphs]
        serial, _confidence = decode_serial(probs, SERIAL_CONFIDENCE_FLOOR, SERIAL_MARGIN_FLOOR)
        return serial

    def _decode_value_cell(self, path: Path, legal_vals: set[float]) -> float | None:
        crop = read_cell(path)
        if crop is None:
            return None
        glyphs = segment_cell(crop)
        if not glyphs:
            return None
        digit_glyphs, decimal_index = _digit_glyphs_and_decimal_index(glyphs)
        probs = [glyph_probs(self._session, glyph_to_canvas(g.image)) for g in digit_glyphs]
        value, _score = decode_value(probs, decimal_index, legal_vals, DECODE_FLOOR)
        return value
