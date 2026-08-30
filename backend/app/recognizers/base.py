"""Recognizer protocol (step.md step 2r.0): the shared seam both the
existing Gemini+Tesseract path and the future CNN path implement, so
main.py never special-cases either one (plan.md §16, "Two paths behind one
interface"). This step only defines the seam and moves code behind it —
nothing about what steps 2 or 3 actually do changes.

Deviates from plan.md §16's illustrative signature in one respect: both
methods here take `cells_dir: Path`, not pre-loaded crop arrays
(`id_crops: list[np.ndarray]`, `serial_crop`/`mark_crops`/`total_crop`).
Steps 2 and 3's real, already-tuned code (id_ocr.read_id, marks.recognize)
is file-path-based throughout — it reads named crops (id_d*.png,
serial.png, marks_r1_c*.png) straight off detect_any_orientation's output
directory. Forcing an array-based boundary here would mean rewriting that
tested code to accept in-memory images it was never built around, which is
exactly what this step's own goal — zero behavior change — rules out. The
future CNNRecognizer (step 3r.4) can equally well glob cells_dir itself;
nothing about batching crops through the model requires the *interface* to
carry pre-loaded arrays, only CNNRecognizer's own implementation to load
them from disk before batching.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from ..marks import MarksResult


@dataclass
class IdResult:
    """plan.md §16's `IdResult` — a best-guess id_digits-length string plus
    which positions (if any) couldn't be read confidently. Mirrors
    id_ocr.read_id's existing (student_id, low_confidence_fields) tuple;
    named here so both Recognizer implementations return the same shape."""
    student_id: str
    low_confidence_fields: list[str] = field(default_factory=list)


class Recognizer(Protocol):
    name: str

    def read_id(self, cells_dir: Path, id_digits: int) -> IdResult:
        """Every id_d*.png crop in cells_dir, in digit order -> a best-guess
        id_digits-length string plus low-confidence flags. An unreadable
        position becomes '?' with a flag, never a silently dropped digit
        (plan.md §10 "flag, never guess")."""
        ...

    def read_marks(self, cells_dir: Path, question_maxes: list[float]) -> MarksResult:
        """serial.png and marks_r1_c*.png in cells_dir -> serial, per-
        question values, and total. Must never open an id_d*.png crop —
        that boundary is plan.md §12's privacy property, and holds for
        every implementation of this protocol, not just the remote one."""
        ...
