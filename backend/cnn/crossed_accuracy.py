#!/usr/bin/env python3
"""Crossed-out detection accuracy (step 15). Two numbers, because one
would hide the one that matters:

- CAUGHT: of the held-out crossed-out glyphs on the practice pages
  (training_data/pages/, `holdout_rows` in pages.json), how many the model
  calls CROSSED_OUT. Missing one costs nothing new — the cell is flagged
  exactly as it was before this class existed.
- FALSE CALLS: of every real, clean glyph in testset/ — each ID box, and
  each glyph segmented out of every serial/mark/total cell, across the
  real_class_* batch's ~20 writers — how many it calls CROSSED_OUT. This
  is the costly error: a clean digit dropped from a cell. testset/ is never
  trained on, so this is an honest held-out measurement, and on writers
  the practice pages never saw.

Then the full recognizer runs over any template photo in
training_data/pages/ named template_*.jpg, so the end-to-end behaviour
(what gets flagged, what gets suggested) is visible, not only the glyph
counts.

    python cnn/crossed_accuracy.py
    python cnn/crossed_accuracy.py --model path/to/digit_cnn.onnx --sweep
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

import cv2
import onnxruntime

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.detection import detect  # noqa: E402
from app.recognizers.local import CNNRecognizer  # noqa: E402
from cnn.classes import CROSSED_OUT  # noqa: E402
from cnn.id_infer import glyph_probs  # noqa: E402
from cnn.pages import PAGES_DIR, load_pages  # noqa: E402
from cnn.preprocess import glyph_to_canvas, has_ink, preprocess_for_cnn  # noqa: E402
from cnn.segment import segment_cell  # noqa: E402
from cnn.thresholds import CROSSED_OUT_FLOOR  # noqa: E402

TESTSET = Path(__file__).parent.parent.parent / "testset"
DEFAULT_MODEL = Path(__file__).parent / "checkpoints" / "digit_cnn.onnx"
ID_DIGITS = 7
SWEEP = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]


def clean_testset_glyphs(session) -> list[tuple[str, float]]:
    """(where, P(crossed out)) for every clean real glyph in testset/."""
    labels = json.loads((TESTSET / "labels.json").read_text())
    out: list[tuple[str, float]] = []
    with tempfile.TemporaryDirectory() as tmp:
        for name, label in labels.get("images", {}).items():
            if name.startswith("_") or not label.get("questions"):
                continue
            q = len(label["questions"])
            cells = Path(tmp) / name / "cells"
            if detect(TESTSET / "images" / name, q, ID_DIGITS, cells.parent)["status"] != "ok":
                continue
            for i in range(1, ID_DIGITS + 1):
                crop = cv2.imread(str(cells / f"id_d{i}.png"))
                if crop is not None and has_ink(crop):
                    p = glyph_probs(session, preprocess_for_cnn(crop))
                    out.append((f"{name} id_d{i}", float(p[CROSSED_OUT])))
            cell_names = ["serial"] + [f"marks_r1_c{c}" for c in range(q + 1)]
            for cell in cell_names:
                crop = cv2.imread(str(cells / f"{cell}.png"))
                if crop is None:
                    continue
                for k, g in enumerate(segment_cell(crop)):
                    if g.is_decimal:
                        continue
                    p = glyph_probs(session, glyph_to_canvas(g.image))
                    out.append((f"{name} {cell} glyph{k}", float(p[CROSSED_OUT])))
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--sweep", action="store_true", help="caught / false calls at a range of floors")
    args = parser.parse_args()

    session = onnxruntime.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    width = session.get_outputs()[0].shape[-1]
    if width is not None and width <= CROSSED_OUT:
        print(f"{args.model} has {width} outputs — no CROSSED_OUT class to measure")
        return 1

    held = [g for g in load_pages() if g.holdout and g.label == CROSSED_OUT]
    struck = [float(glyph_probs(session, glyph_to_canvas(g.image))[CROSSED_OUT]) for g in held]
    clean = clean_testset_glyphs(session)
    if not held:
        print("no held-out crossed-out practice rows found (training_data/pages/pages.json)")

    floors = SWEEP if args.sweep else [CROSSED_OUT_FLOOR]
    for floor in floors:
        caught = sum(p >= floor for p in struck)
        false_calls = [(w, p) for w, p in clean if p >= floor]
        marker = "  <- CROSSED_OUT_FLOOR" if floor == CROSSED_OUT_FLOOR and args.sweep else ""
        print(
            f"floor {floor:.2f}: caught {caught}/{len(struck)} held-out crossings-out "
            f"({caught / max(len(struck), 1):.1%}); clean testset glyphs called crossed out "
            f"{len(false_calls)}/{len(clean)}{marker}"
        )
    false_calls = sorted(((w, p) for w, p in clean if p >= CROSSED_OUT_FLOOR), key=lambda x: -x[1])
    for where, p in false_calls:
        print(f"   false call at the current floor: {where}  P={p:.2f}")
    top = sorted(clean, key=lambda x: -x[1])[:5]
    print("   closest clean glyphs: " + ", ".join(f"{w} {p:.2f}" for w, p in top))

    recognizer = CNNRecognizer(args.model)
    for photo in sorted(PAGES_DIR.glob("template_*.jpg")):
        with tempfile.TemporaryDirectory() as tmp:
            for q in range(1, 11):
                if detect(photo, q, ID_DIGITS, Path(tmp))["status"] == "ok":
                    break
            else:
                print(f"{photo.name}: detection failed")
                continue
            cells = Path(tmp) / "cells"
            ident = recognizer.read_id(cells, ID_DIGITS)
            # Every question out of 5, as on the one template photo so far;
            # a template with other maxes would need its own config here.
            marks = recognizer.read_marks(cells, [5.0] * q)
            print(
                f"{photo.name}: id={ident.student_id} serial={marks.serial} "
                f"questions={marks.questions} total={marks.total}\n"
                f"   crossed out: {ident.crossed_out_fields + marks.crossed_out_fields}  "
                f"suggestions: {marks.suggestions}  unmatched: {marks.unmatched_fields}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
