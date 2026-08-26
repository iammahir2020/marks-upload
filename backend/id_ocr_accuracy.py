#!/usr/bin/env python3
"""Step 2.4: ID-recognition accuracy harness.

Runs detection fresh (not from stale debug/ output) for every labelled
image that has a known student_id, reads the ID digit crops, and reports
per-digit accuracy and whole-ID exact-match rate against
testset/labels.json — the two numbers step.md's Test section asks for.

    id_ocr_accuracy.py
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from app.detection import detect  # noqa: E402
from app.id_ocr import read_id  # noqa: E402

TESTSET = Path(__file__).parent.parent / "testset"
QUESTIONS = 5
ID_DIGITS = 7


def main() -> int:
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
    exact_matches = 0

    with tempfile.TemporaryDirectory() as tmp:
        for name, label in cases:
            image_path = TESTSET / "images" / name
            true_id = label["student_id"]
            out_dir = Path(tmp) / name
            result = detect(image_path, QUESTIONS, ID_DIGITS, out_dir)

            if result["status"] != "ok":
                print(f"{name}: detection failed ({result['failure_reason']}) — skipping, not an OCR result")
                continue

            read, low_conf = read_id(out_dir / "cells", ID_DIGITS)

            digit_matches = sum(1 for a, b in zip(read, true_id) if a == b)
            total_digits += len(true_id)
            correct_digits += digit_matches
            is_exact = read == true_id
            exact_matches += int(is_exact)

            flag = " [low_confidence]" if low_conf else ""
            outcome = "OK" if is_exact else "MISS"
            print(f"{name}: true={true_id} read={read} ({digit_matches}/{len(true_id)} digits){flag} {outcome}")

    print()
    if total_digits:
        print(f"per-digit accuracy: {correct_digits}/{total_digits} = {correct_digits/total_digits:.1%}")
        print(f"whole-ID exact match: {exact_matches}/{len(cases)} = {exact_matches/len(cases):.1%}")
    else:
        print("no cases produced a detectable ID table — nothing to score")

    return 0


if __name__ == "__main__":
    sys.exit(main())
