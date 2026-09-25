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
from cnn.segment import WIDE_SPLIT_FRACS, Glyph, segment_cell_detail, split_wide  # noqa: E402
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
    # Every one-tap candidate when value is None — two or more for a tie the
    # instructor must settle (15 / 1.5), one when it equals `suggestion`.
    choices: tuple = ()
    # Unexplained ink between two digits (segment.Segmentation.stray_between).
    stray_between: bool = False


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

    def read_marks(self, cells_dir: Path, question_maxes: list[float], has_serial: bool = True) -> MarksResult:
        """serial.png and marks_r1_c*.png, segmented then constrained-
        decoded (step 3r). Always status="ok" — there is no network call
        here to fail the way marks.py's Gemini call can (plan.md §16:
        rate_limited is unreachable on this path); an unreadable field is
        represented the same way it always is in this project, as a None
        value plus a flag, never a "failed" scan.

        `has_serial=False` (step 16): the paper has no Serial box, so the
        serial is None and NOT flagged — there is nothing to be unsure of."""
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
        choices: dict[str, list[str]] = {}

        def note_crossed(field: str, read: _CellRead, fmt) -> None:
            crossed_out_fields.append(field)
            if read.suggestion is not None:
                suggestions[field] = fmt(read.suggestion)

        serial = None
        if has_serial:
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
                    if read.choices:
                        choices[field] = [_fmt(c) for c in read.choices]

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
                if total_read.choices:
                    choices["total"] = [_fmt(c) for c in total_read.choices]

        return MarksResult(
            status="ok",
            serial=serial,
            questions=questions,
            total=total,
            low_confidence_fields=low_confidence_fields,
            unmatched_fields=unmatched_fields,
            crossed_out_fields=crossed_out_fields,
            suggestions=suggestions,
            choices=choices,
        )

    def _read_glyphs(self, path: Path):
        """(glyphs, probs, crossed, stray_between) for one cell, or None when the crop is
        missing. `probs` and `crossed` are keyed by glyph index and cover
        digit glyphs only (decimal points are geometry, never classified);
        each glyph is run through the model once, and both the crossed-out
        check and the decoder read the same vector."""
        crop = read_cell(path)
        if crop is None:
            return None
        seg = segment_cell_detail(crop)
        glyphs = seg.glyphs
        probs = {
            i: glyph_probs(self._session, glyph_to_canvas(g.image))
            for i, g in enumerate(glyphs) if not g.is_decimal
        }
        crossed = {i: is_crossed_out(p, CROSSED_OUT_FLOOR) for i, p in probs.items()}
        # Returned, never stored on self: one recognizer serves concurrent
        # scans from main.py's thread pool (the backend is stateless).
        return glyphs, probs, crossed, seg.stray_between

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

    def _decode(self, glyphs: list[Glyph], probs: dict, legal_vals: set[float]):
        """One reading of a glyph list: the value, or None."""
        return self._decode_scored(glyphs, probs, legal_vals)[0]

    def _decode_scored(self, glyphs: list[Glyph], probs: dict, legal_vals: set[float]):
        _digit_glyphs, decimal_index = _digit_glyphs_and_decimal_index(glyphs)
        digit_probs = [probs[i] for i, g in enumerate(glyphs) if not g.is_decimal]
        if not digit_probs:
            return None, 0.0
        return decode_value(digit_probs, decimal_index, legal_vals, DECODE_FLOOR)

    def _resolve(self, glyphs: list[Glyph], probs: dict, legal_vals: set[float], stray: bool) -> _CellRead:
        """Every reading the evidence allows, then one rule: a single legal
        reading from real evidence is the value; anything more is a set of
        choices for the instructor, never a pick.

        Real evidence is the glyphs as segmented, and — for a WEAK point
        (segment.py's mid-height/rescued dots) — the same glyphs without it.
        So "25" with a weak dot on a 5-mark question is 2.5 (25 isn't legal),
        "10" with a speck read as a dot is 10 (1.0 isn't a rendering any
        legal value has), and "1.5" with a weak dot on a 25-mark Total is a
        tie: 1.5 or 15, both offered.

        Hints only ever add choices: a point placed before the last digit
        (a dot that was lost — _missing_point), tried when stray ink sits
        between the digits or nothing else decoded. And a glyph as wide as
        two digits (segment.py's maybe_two, the touching "20" that read as a
        confident 2.5 for "20.5") is never trusted: its readings, whole and
        split, are all choices.
        """
        real: set[float] = set()
        hints: set[float] = set()

        base = self._decode(glyphs, probs, legal_vals)
        if base is not None:
            real.add(base)
        weak_idx = [i for i, g in enumerate(glyphs) if g.is_decimal and g.weak]
        if weak_idx:
            kept = [i for i in range(len(glyphs)) if i not in weak_idx]
            without = self._decode([glyphs[i] for i in kept], {j: probs[i] for j, i in enumerate(kept) if i in probs}, legal_vals)
            if without is not None:
                real.add(without)

        digit_probs = [probs[i] for i, g in enumerate(glyphs) if not g.is_decimal]
        _digits, decimal_index = _digit_glyphs_and_decimal_index(glyphs)
        if base is None or stray:
            hint = self._missing_point(digit_probs, decimal_index, legal_vals)
            if hint is not None:
                hints.add(hint)

        wide_idx = [i for i, g in enumerate(glyphs) if not g.is_decimal and g.maybe_two]
        for i in wide_idx:
            value, best = None, 0.0
            for frac in WIDE_SPLIT_FRACS:
                halves = split_wide(glyphs[i], frac)
                if halves is None:
                    continue
                split_glyphs = glyphs[:i] + list(halves) + glyphs[i + 1:]
                split_probs = {
                    j: glyph_probs(self._session, glyph_to_canvas(g.image))
                    for j, g in enumerate(split_glyphs) if not g.is_decimal
                }
                candidate, score = self._decode_scored(split_glyphs, split_probs, legal_vals)
                if candidate is not None and score > best:
                    value, best = candidate, score
            # Width alone proves nothing — students write a "2" up to twice as
            # wide as it is tall (27 of 430 harvested whole marks). Only a
            # split that reads as a DIFFERENT legal value makes it a tie.
            if value is not None and value not in real:
                hints |= real | {value}
                real = set()

        if len(real) == 1 and not (hints - real):
            return _CellRead(value=next(iter(real)), had_ink=False)
        choices = tuple(sorted(real | hints))
        suggestion = choices[0] if len(choices) == 1 else None
        return _CellRead(had_ink=True, suggestion=suggestion, choices=choices, stray_between=stray)

    def _decode_serial_cell(self, path: Path) -> _CellRead:
        read = self._read_glyphs(path)
        if read is None or not read[0]:
            return _CellRead()  # missing or blank — flag, never guess (plan.md §16)
        _glyphs, probs, crossed, _stray = read
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
        glyphs, probs, crossed, stray = read
        if not any(crossed.values()):
            return self._resolve(glyphs, probs, legal_vals, stray)

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
