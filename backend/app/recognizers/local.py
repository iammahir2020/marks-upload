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
from dataclasses import dataclass
from pathlib import Path

import onnxruntime

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from cnn.decode import (  # noqa: E402
    DECODE_FLOOR,
    decide_digit,
    decode_serial,
    decode_value,
    is_crossed_out,
)
from cnn.id_infer import glyph_probs  # noqa: E402
from cnn.preprocess import glyph_to_canvas, has_ink, preprocess_for_cnn  # noqa: E402
from cnn.segment import Glyph, segment_cell  # noqa: E402
from cnn.thresholds import CONFIDENCE_FLOOR as ID_CONFIDENCE_FLOOR  # noqa: E402
from cnn.thresholds import CROSSED_OUT_FLOOR  # noqa: E402
from cnn.thresholds import MARGIN_FLOOR as ID_MARGIN_FLOOR  # noqa: E402
from cnn.thresholds import SERIAL_CONFIDENCE_FLOOR, SERIAL_MARGIN_FLOOR  # noqa: E402

from ..cells import read_cell
from ..marks import MarksResult, _fmt, legal_values
from .base import IdResult

DEFAULT_MODEL_PATH = Path(__file__).resolve().parent.parent.parent / "cnn" / "checkpoints" / "digit_cnn.onnx"

# Floors: cnn/thresholds.py (issues.md N16).


def _digit_glyphs_and_decimal_index(glyphs: list[Glyph]) -> tuple[list[Glyph], int | None]:
    digit_glyphs = [g for g in glyphs if not g.is_decimal]
    decimal_index = next((i for i, g in enumerate(glyphs) if g.is_decimal), None)
    return digit_glyphs, decimal_index


@dataclass
class _CellRead:
    """What one serial/mark/total cell yielded. `crossed_out` means a
    struck glyph was found: `value` is then always None, and `suggestion`
    holds what the REMAINING glyphs decode to, if anything (step 15)."""
    value: object = None
    had_ink: bool = False
    crossed_out: bool = False
    suggestion: object = None


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
        crossed = False
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

            probs = glyph_probs(self._session, preprocess_for_cnn(crop))
            # A fourth way to yield "?" (step 15): the box holds a
            # crossed-out glyph. Without this check its scribble was read
            # as a digit, often confidently, and the ID has no sum behind
            # it to catch that.
            if is_crossed_out(probs, CROSSED_OUT_FLOOR):
                digits.append("?")
                uncertain = crossed = True
                continue
            digit, _confidence, _margin = decide_digit(probs, ID_CONFIDENCE_FLOOR, ID_MARGIN_FLOOR)
            if digit is None:
                digits.append("?")
                uncertain = True
            else:
                digits.append(str(digit))

        student_id = "".join(digits)
        return IdResult(
            student_id=student_id,
            low_confidence_fields=["student_id"] if uncertain else [],
            crossed_out_fields=["student_id"] if crossed else [],
        )

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
        unmatched_fields: list[str] = []
        crossed_out_fields: list[str] = []
        suggestions: dict[str, str] = {}

        def note_crossed(field: str, read: _CellRead, fmt) -> None:
            crossed_out_fields.append(field)
            if read.suggestion is not None:
                suggestions[field] = fmt(read.suggestion)

        serial_read = self._decode_serial_cell(cells_dir / "serial.png")
        serial = serial_read.value
        # issues.md N32 — decode_serial now returns a partial string like
        # "0?" instead of blanking the whole field, so "flagged" is no
        # longer just "is None": it's "contains any '?' at all", mirroring
        # read_id's own `uncertain` tracking for the student ID above.
        if serial is None or "?" in serial:
            low_confidence_fields.append("serial")
        if serial_read.crossed_out:
            note_crossed("serial", serial_read, str)

        questions: list[float | None] = []
        for i, max_mark in enumerate(question_maxes):
            field = f"q{i + 1}"
            read = self._decode_value_cell(cells_dir / f"marks_r1_c{i}.png", legal_values(max_mark))
            questions.append(read.value)
            if read.value is None:
                low_confidence_fields.append(field)
                if read.crossed_out:
                    note_crossed(field, read, _fmt)
                elif read.had_ink:
                    unmatched_fields.append(field)
                    if read.suggestion is not None:
                        suggestions[field] = _fmt(read.suggestion)

        total_max = sum(question_maxes)
        total_path = cells_dir / f"marks_r1_c{len(question_maxes)}.png"
        total_read = self._decode_value_cell(total_path, legal_values(total_max))
        total = total_read.value
        if total is None:
            low_confidence_fields.append("total")
            if total_read.crossed_out:
                note_crossed("total", total_read, _fmt)
            elif total_read.had_ink:
                unmatched_fields.append("total")
                if total_read.suggestion is not None:
                    suggestions["total"] = _fmt(total_read.suggestion)

        return MarksResult(
            status="ok",
            serial=serial,
            questions=questions,
            total=total,
            low_confidence_fields=low_confidence_fields,
            unmatched_fields=unmatched_fields,
            crossed_out_fields=crossed_out_fields,
            suggestions=suggestions,
        )

    def _read_glyphs(self, path: Path):
        """(glyphs, probs, crossed) for one cell, or None when the crop is
        missing. `probs` and `crossed` are keyed by glyph index and cover
        digit glyphs only (decimal points are geometry, never classified);
        each glyph is run through the model once, and both the crossed-out
        check and the decoder read the same vector."""
        crop = read_cell(path)
        if crop is None:
            return None
        glyphs = segment_cell(crop)
        probs = {
            i: glyph_probs(self._session, glyph_to_canvas(g.image))
            for i, g in enumerate(glyphs) if not g.is_decimal
        }
        crossed = {i: is_crossed_out(p, CROSSED_OUT_FLOOR) for i, p in probs.items()}
        return glyphs, probs, crossed

    @staticmethod
    def _missing_point(digit_probs, decimal_index, legal_vals: set[float]):
        """A half mark whose decimal point the segmenter lost — a pen dot
        too small to clear segment.py's noise floor, or merged into a
        neighbouring digit. "2.5" then arrives as two digit glyphs, 2 and 5,
        with no point, and no legal value matches "25".

        Measured 2026-09-24 on half marks built from the instructor's own
        practice-page digits: with a tiny dot, both the old and the new
        model read 3/120 correctly; with a dot touching a digit, 17/120 —
        and the OLD model filled in a wrong number (2 for 2.5) on 78 of
        them, which is what made half marks look like they had "worked"
        before.

        Only ever a suggestion, and only when (a) the cell already failed
        to decode, (b) no point was found at all, and (c) placing one
        before the LAST glyph decodes to a legal value. Every half mark
        this app accepts has exactly one digit after the point, so that is
        the only position worth trying."""
        if decimal_index is not None or len(digit_probs) < 2:
            return None
        value, _score = decode_value(digit_probs, len(digit_probs) - 1, legal_vals, DECODE_FLOOR)
        return value

    def _decode_serial_cell(self, path: Path) -> _CellRead:
        read = self._read_glyphs(path)
        if read is None or not read[0]:
            return _CellRead()  # missing or blank — flag, never guess (plan.md §16)
        _glyphs, probs, crossed = read
        kept = [probs[i] for i in probs if not crossed[i]]
        serial, _confidence = decode_serial(kept, SERIAL_CONFIDENCE_FLOOR, SERIAL_MARGIN_FLOOR)
        if not any(crossed.values()):
            return _CellRead(value=serial, had_ink=True)
        # Step 15 — a crossed-out glyph was dropped, so what remains is only
        # ever a suggestion, and only when every remaining position read
        # cleanly: a partial "0?" is a fine flagged VALUE (N32) but not
        # something worth a one-tap accept.
        suggestion = serial if serial is not None and "?" not in serial else None
        return _CellRead(had_ink=True, crossed_out=True, suggestion=suggestion)

    def _decode_value_cell(self, path: Path, legal_vals: set[float]) -> _CellRead:
        """`had_ink` is issues.md N31/N33: True exactly when the cell had
        glyphs but none scored a legal value, as opposed to a genuinely
        blank cell (no glyphs at all). The two used to collapse into an
        identical `None`, which is what let harvest() (N31) attach an
        instructor's workaround value to a crop whose ink it does not
        match, and what left the instructor (N33) staring at an
        unexplained blank with no way to tell "nothing written" from
        "written, but no legal value matches — check the script"."""
        read = self._read_glyphs(path)
        if read is None or not read[0]:
            return _CellRead()  # missing or blank — not the N31/N33 case
        glyphs, probs, crossed = read
        if not any(crossed.values()):
            _digit_glyphs, decimal_index = _digit_glyphs_and_decimal_index(glyphs)
            # probs is keyed in glyph order, so its values are the digit
            # glyphs' vectors left to right.
            digit_probs = list(probs.values())
            value, _score = decode_value(digit_probs, decimal_index, legal_vals, DECODE_FLOOR)
            if value is not None:
                return _CellRead(value=value, had_ink=False)
            return _CellRead(had_ink=True, suggestion=self._missing_point(digit_probs, decimal_index, legal_vals))

        # Step 15 — drop the struck glyphs and decode what is left, with the
        # decimal point's position recomputed among the survivors. A point
        # stranded by a struck "2.5" lands where no legal value puts one
        # and decodes to nothing, which is the safe outcome.
        kept = [g for i, g in enumerate(glyphs) if g.is_decimal or not crossed[i]]
        kept_probs = [probs[i] for i, g in enumerate(glyphs) if not g.is_decimal and not crossed[i]]
        _digit_glyphs, decimal_index = _digit_glyphs_and_decimal_index(kept)
        suggestion = None
        if kept_probs:
            suggestion, _score = decode_value(kept_probs, decimal_index, legal_vals, DECODE_FLOOR)
        return _CellRead(had_ink=True, crossed_out=True, suggestion=suggestion)
