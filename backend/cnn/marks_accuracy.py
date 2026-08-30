#!/usr/bin/env python3
"""Step 3r.5: CNN serial/marks accuracy harness. Same structure as
accuracy.py (step 2r.4) — real photos, real testset/labels.json ground
truth, no estimating — applied to CNNRecognizer.read_marks instead of the
ID path. Half marks are reported separately from whole marks, per
step.md step 3r.5's own requirement: that discrimination is exactly what
the constrained decoder exists to make reliable.

Standalone: run after cnn/train.py has produced cnn/checkpoints/digit_cnn.onnx.

    python cnn/marks_accuracy.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.detection import detect  # noqa: E402
from app.recognizers.local import CNNRecognizer  # noqa: E402

TESTSET = Path(__file__).parent.parent.parent / "testset"
QUESTIONS = 5
ID_DIGITS = 7


def _question_maxes(label: dict, quiz_configs: dict, question_count: int) -> list[float]:
    """Per-photo max marks, when known. Most labelled photos have no
    "quiz" key and predate any per-image config in labels.json — those
    keep the original hardcoded 5-question/5.0-each assumption unchanged
    (this function's fallback branch), matching every accuracy number
    already measured against them. Photos with a "quiz" key (the
    real_class_* batch, whose templates genuinely vary: 3/5/8 questions,
    some out of 10 not 5) look their real max marks up in
    testset/quiz_configs.json instead."""
    quiz_id = label.get("quiz")
    if quiz_id and quiz_id in quiz_configs:
        by_q = {q["q"]: q["max"] for q in quiz_configs[quiz_id]["questions"]}
        return [by_q[i] for i in range(1, question_count + 1)]
    return [5.0] * question_count


def main() -> int:
    labels = json.loads((TESTSET / "labels.json").read_text())
    quiz_configs = json.loads((TESTSET / "quiz_configs.json").read_text())
    cases = [
        (name, label) for name, label in labels.get("images", {}).items()
        if not name.startswith("_") and label.get("questions") and label.get("total") is not None
    ]
    if not cases:
        print("no labelled images with real question/total ground truth yet — nothing to measure")
        return 0

    recognizer = CNNRecognizer()

    serial_correct = serial_total = 0
    total_correct = total_total = 0
    question_correct = question_total = 0
    half_mark_correct = half_mark_total = 0
    whole_mark_correct = whole_mark_total = 0
    confidently_wrong = 0

    with tempfile.TemporaryDirectory() as tmp:
        for name, label in cases:
            image_path = TESTSET / "images" / name
            out_dir = Path(tmp) / name
            # Real per-image question count, not the fixed QUESTIONS
            # default (same fix as id_ocr_accuracy.py/cnn/accuracy.py) —
            # otherwise a mismatched marks-table shape masks an otherwise-
            # usable detection for every template that isn't 5 questions.
            question_count = len(label["questions"])
            det = detect(image_path, question_count, ID_DIGITS, out_dir)
            if det["status"] != "ok":
                print(f"{name}: detection failed ({det['failure_reason']}) — skipping")
                continue

            question_maxes = _question_maxes(label, quiz_configs, question_count)
            result = recognizer.read_marks(out_dir / "cells", question_maxes)

            true_serial = label.get("serial")
            if true_serial is not None:
                serial_total += 1
                read_serial = result.serial
                match = read_serial == true_serial
                serial_correct += int(match)
                if read_serial is not None and not match:
                    confidently_wrong += 1
                print(f"{name}: serial true={true_serial} read={read_serial} {'OK' if match else ('FLAGGED' if read_serial is None else 'WRONG')}")

            true_questions = {q["q"]: q["value"] for q in label["questions"]}
            for i, read_value in enumerate(result.questions, start=1):
                true_value = true_questions.get(i)
                if true_value is None:
                    continue
                question_total += 1
                is_half = (true_value * 2) % 2 == 1  # x.5-style value
                bucket_total_name = "half_mark_total" if is_half else "whole_mark_total"
                match = read_value == true_value
                question_correct += int(match)
                if is_half:
                    half_mark_total += 1
                    half_mark_correct += int(match)
                else:
                    whole_mark_total += 1
                    whole_mark_correct += int(match)
                if read_value is not None and not match:
                    confidently_wrong += 1
                outcome = "OK" if match else ("FLAGGED" if read_value is None else "WRONG")
                print(f"{name}: q{i} true={true_value} read={read_value} {outcome}")

            true_total = label.get("total")
            if true_total is not None:
                total_total += 1
                match = result.total == true_total
                total_correct += int(match)
                if result.total is not None and not match:
                    confidently_wrong += 1
                outcome = "OK" if match else ("FLAGGED" if result.total is None else "WRONG")
                print(f"{name}: total true={true_total} read={result.total} {outcome}")

    print()
    if question_total:
        print(f"per-question accuracy: {question_correct}/{question_total} = {question_correct/question_total:.1%}")
    if whole_mark_total:
        print(f"  whole marks: {whole_mark_correct}/{whole_mark_total} = {whole_mark_correct/whole_mark_total:.1%}")
    if half_mark_total:
        print(f"  half marks:  {half_mark_correct}/{half_mark_total} = {half_mark_correct/half_mark_total:.1%}")
    if serial_total:
        print(f"serial accuracy: {serial_correct}/{serial_total} = {serial_correct/serial_total:.1%}")
    if total_total:
        print(f"total accuracy: {total_correct}/{total_total} = {total_correct/total_total:.1%}")
    print(f"confidently wrong: {confidently_wrong} (must stay 0 — same bar as step 2r.4)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
