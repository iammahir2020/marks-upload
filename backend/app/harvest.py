"""Harvesting confirmed values into training data (step.md step 3r.6c,
plan.md §16 "Harvesting labels from real use"). The review screen (step
7) is already a labelling machine: every digit the instructor confirms or
corrects is a labelled crop of exactly the handwriting that matters,
including student handwriting that could never be collected in advance.

Built now even though nothing consumes it yet — no fine-tuning exists to
train on these labels. Retrofitting this later would mean losing every
label from the pilot, which is the period these labels matter most
(plan.md §16's own reasoning for building this ahead of need).

Tags corrections separately from confirmations: corrections are the
model's actual failures and worth oversampling; confirmations mostly
re-teach what it already knows. A field the original scan flagged (None,
low-confidence) that the instructor then filled in counts as a correction
too — the model failed to produce a usable answer there, the same as if
it had produced a wrong one.
"""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from .marks import _fmt

HARVEST_DIR = Path(__file__).resolve().parent.parent / "training_data" / "harvested"


def _save(field: str, tag: str, value: str, crop_path: Path, harvest_dir: Path) -> None:
    """The label lives in the filename — the same self-labelling
    principle the collection sheet (step 3r.6a) uses, so no separate
    annotation file has to stay in sync with the images."""
    if not crop_path.exists():
        return
    out_dir = harvest_dir / field / tag
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(crop_path, out_dir / f"{value}_{uuid.uuid4().hex}.png")


def harvest(
    cells_dir: Path,
    id_digits: int,
    question_count: int,
    original_student_id: str | None,
    confirmed_student_id: str | None,
    original_serial: str | None,
    confirmed_serial: str | None,
    original_questions: list[float | None],
    confirmed_questions: list[float | None],
    original_total: float | None,
    confirmed_total: float | None,
    harvest_dir: Path = HARVEST_DIR,
) -> None:
    """Copies each relevant cell crop into
    <harvest_dir>/<field>/{confirmed,corrected}/<value>_<uuid>.png. Only
    fields the instructor actually confirmed with a real value are
    harvested — an empty confirmed field means it stayed blank on the
    review screen, which isn't a label of anything."""
    if confirmed_student_id:
        for i in range(1, id_digits + 1):
            if i - 1 >= len(confirmed_student_id):
                break
            confirmed_digit = confirmed_student_id[i - 1]
            original_digit = (
                original_student_id[i - 1]
                if original_student_id and i - 1 < len(original_student_id)
                else None
            )
            tag = "confirmed" if confirmed_digit == original_digit else "corrected"
            _save("id_digits", tag, confirmed_digit, cells_dir / f"id_d{i}.png", harvest_dir)

    if confirmed_serial:
        tag = "confirmed" if confirmed_serial == original_serial else "corrected"
        _save("serial", tag, confirmed_serial, cells_dir / "serial.png", harvest_dir)

    for i in range(question_count):
        confirmed_value = confirmed_questions[i] if i < len(confirmed_questions) else None
        if confirmed_value is None:
            continue
        original_value = original_questions[i] if i < len(original_questions) else None
        tag = "confirmed" if confirmed_value == original_value else "corrected"
        _save(f"marks_q{i + 1}", tag, _fmt(confirmed_value), cells_dir / f"marks_r1_c{i}.png", harvest_dir)

    if confirmed_total is not None:
        tag = "confirmed" if confirmed_total == original_total else "corrected"
        _save("marks_total", tag, _fmt(confirmed_total), cells_dir / f"marks_r1_c{question_count}.png", harvest_dir)
