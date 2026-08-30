#!/usr/bin/env python3
"""Step 2r.4: CNN ID-recognition accuracy harness. Mirrors
id_ocr_accuracy.py exactly — same ground truth (testset/labels.json), same
cases, same two numbers reported — so the comparison to Tesseract's
measured baseline (58.9% per-digit, 0/8 whole-ID exact match) is apples to
apples, per step.md step 2r.4's own requirement. Also reports the
confidently-wrong count separately, since step.md's Done-when bar for this
step is about that count staying zero, not just raw accuracy going up —
matching the "flag, never guess" bar id_ocr.py already holds itself to.

Standalone: this is step 2r, not yet wired into the app (that's step
3r.4). No app/recognizers/ import here on purpose.

    python cnn/accuracy.py --model cnn/checkpoints/digit_cnn.onnx
    python cnn/accuracy.py --calibrate   # dump per-digit confidence/margin
                                          # for threshold tuning
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
import onnxruntime

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.detection import detect  # noqa: E402
from cnn.id_infer import predict_digit as _predict_digit  # noqa: E402
from cnn.preprocess import preprocess_for_cnn  # noqa: E402

TESTSET = Path(__file__).parent.parent.parent / "testset"
QUESTIONS = 5
ID_DIGITS = 7

# Two signals, per plan.md §16 "Confidence, and when to flag": the top
# class's own probability, and its margin over the runner-up — a near-tie
# is worse than a confident-but-imperfect top score, even at the same max
# probability. Originally calibrated on n=56 real digit reads (one writer,
# 8 photos), where correct and wrong reads fell into two clusters with an
# enormous gap between them (0.586 -> 0.990) — 0.9/0.8 sat safely inside
# that gap. **Recalibrated 2026-08-30 against n=182 real digit reads
# across ~20 different writers** (the real_class_* batch, step.md step 0)
# — with real handwriting diversity, that clean gap doesn't exist anymore:
# correct reads span confidence all the way down to 0.40, and only one
# read in the whole set is both wrong and above 0.75 (a single genuinely
# ambiguous cursive "9", at 0.924/0.887 — no floor below that catches it
# without also flagging a large block of correct reads well above it).
# Measured directly by sweeping candidate floors against raw, pre-floor
# argmax correctness: 0.9/0.8 let through 1 wrong digit but flagged 20
# digits that were actually correct (86.3% pass rate); 0.75/0.6 lets
# through the same single unavoidable wrong digit while recovering 11 of
# those 20 false flags (92.3% pass rate) — same safety, real accuracy
# gain. Going lower than 0.75 confidence starts trading safety for
# recall (3+ wrong digits let through at 0.70). Still provisional in the
# same sense as before — n=182/~20 writers is much better than n=56/1
# writer but still not the full class. ID-specific: serial/mark decoding
# (step 3r) calibrates its own floors separately, since they're a
# different field written under different conditions and haven't been
# recalibrated against this batch.
CONFIDENCE_FLOOR = 0.75
MARGIN_FLOOR = 0.6


def predict_digit(session: onnxruntime.InferenceSession, canvas: np.ndarray) -> tuple[str | None, float, float]:
    """Thin wrapper over cnn.id_infer's shared TTA+decide primitive,
    binding in this module's own calibrated floors (step 2r.0's move-not-
    rewrite pattern, applied to this module's own later refactor: the
    inference logic moved to id_infer.py in step 3r so serial/mark
    decoding could reuse it, but this function's signature and behavior
    are unchanged — verified by re-running this exact harness after the
    move and confirming identical numbers, see learn.md step 3r)."""
    return _predict_digit(session, canvas, CONFIDENCE_FLOOR, MARGIN_FLOOR)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=Path(__file__).parent / "checkpoints" / "digit_cnn.onnx")
    parser.add_argument("--calibrate", action="store_true", help="dump per-digit confidence/margin/correctness instead of applying the floors")
    args = parser.parse_args()

    session = onnxruntime.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])

    labels = json.loads((TESTSET / "labels.json").read_text())
    cases = [
        (name, label) for name, label in labels.get("images", {}).items()
        if not name.startswith("_") and label.get("student_id")
    ]
    if not cases:
        print("no labelled images with a known student_id yet — nothing to measure")
        return 0

    total_digits = 0
    correct_digits = 0
    confidently_wrong = 0
    exact_matches = 0
    calibration_rows: list[tuple[float, float, bool]] = []

    with tempfile.TemporaryDirectory() as tmp:
        for name, label in cases:
            image_path = TESTSET / "images" / name
            true_id = label["student_id"]
            out_dir = Path(tmp) / name
            # Real per-image question count, not the fixed QUESTIONS
            # default — this harness only reads the ID crop, but detect()
            # still needs the marks table's real shape to avoid an
            # unrelated column_count_mismatch masking an otherwise-usable
            # ID read (same fix already applied in
            # tests/test_detection_regression.py and id_ocr_accuracy.py).
            questions = len(label["questions"]) if label.get("questions") else QUESTIONS
            result = detect(image_path, questions, ID_DIGITS, out_dir)

            if result["status"] != "ok":
                print(f"{name}: detection failed ({result['failure_reason']}) — skipping, not a recognition result")
                continue

            cells_dir = out_dir / "cells"
            read_digits = []
            any_uncertain = False
            for i in range(1, ID_DIGITS + 1):
                crop_path = cells_dir / f"id_d{i}.png"
                true_digit = true_id[i - 1] if i - 1 < len(true_id) else None

                if not crop_path.exists():
                    read_digits.append("?")
                    any_uncertain = True
                    continue

                crop = cv2.imread(str(crop_path))
                canvas = preprocess_for_cnn(crop)
                digit, confidence, margin = predict_digit(session, canvas)

                if args.calibrate and true_digit is not None:
                    calibration_rows.append((confidence, margin, digit == true_digit))

                if digit is None:
                    read_digits.append("?")
                    any_uncertain = True
                else:
                    read_digits.append(digit)
                    # A flagged position never counts as "confidently
                    # wrong" — it wasn't a confident guess at all. But it
                    # still counts as a miss in per-digit accuracy below,
                    # via the same string-equality check id_ocr_accuracy.py
                    # uses ('?' never equals a real digit) — this keeps
                    # the two harnesses' headline numbers on identical
                    # footing, so "beats 58.9%" is a real comparison.
                    if true_digit is not None and digit != true_digit:
                        confidently_wrong += 1

            read = "".join(read_digits)
            # Same definition id_ocr_accuracy.py uses: every position in
            # true_id counts toward the denominator, and a flagged '?'
            # never matches a real digit, so it scores as a miss here too
            # — not excluded from the count, just never "correct".
            total_digits += len(true_id)
            correct_digits += sum(1 for a, b in zip(read, true_id) if a == b)

            is_exact = read == true_id
            exact_matches += int(is_exact)
            flag = " [low_confidence]" if any_uncertain else ""
            outcome = "OK" if is_exact else "MISS"
            digit_matches = sum(1 for a, b in zip(read, true_id) if a == b)
            print(f"{name}: true={true_id} read={read} ({digit_matches}/{len(true_id)} digits){flag} {outcome}")

    if args.calibrate:
        print("\nconfidence, margin, correct — sort/inspect to pick CONFIDENCE_FLOOR/MARGIN_FLOOR:")
        for confidence, margin, correct in sorted(calibration_rows):
            print(f"  conf={confidence:.3f} margin={margin:.3f} correct={correct}")
        return 0

    print()
    if total_digits:
        print(f"per-digit accuracy: {correct_digits}/{total_digits} = {correct_digits/total_digits:.1%}  (id_ocr_accuracy.py baseline: 33/56 = 58.9%)")
        print(f"confidently wrong: {confidently_wrong} (must stay 0 — this is the bar that matters most, not raw accuracy)")
        print(f"whole-ID exact match: {exact_matches}/{len(cases)} = {exact_matches/len(cases):.1%}  (id_ocr_accuracy.py baseline: 0/8 = 0.0%)")
    else:
        print("no cases produced a detectable ID table — nothing to score")

    return 0


if __name__ == "__main__":
    sys.exit(main())
