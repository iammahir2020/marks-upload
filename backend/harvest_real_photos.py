#!/usr/bin/env python3
"""Step 3r.6c data collection: feed the 18 real_class_* photos (real,
multi-writer handwriting — testset/real_class_info.json, folded into
testset/labels.json) through POST /api/harvest so the CNN fine-tuning
track has real, correctly-labeled training crops in
training_data/harvested/.

original == confirmed for every field here (both set to the transcribed
ground truth), since there is no live instructor review step in this
one-off batch — harvest.py tags a field "corrected" only when original
and confirmed differ, so this lands everything as "confirmed".

Needs a locally running backend (plain HTTP is fine — no browser secure
context involved for a local script):

    uvicorn app.main:app --port 8123 &
    python harvest_real_photos.py --base-url http://127.0.0.1:8123
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import httpx

TESTSET = Path(__file__).parent.parent / "testset"


def _quiz_config(label: dict, quiz_configs: dict) -> dict:
    quiz_id = label["quiz"]
    cfg = quiz_configs[quiz_id]
    return {
        "quizName": quiz_id,
        "idDigits": 7,
        "questions": cfg["questions"],
        "totalMax": cfg["totalMax"],
    }


def _harvest_fields(label: dict) -> dict:
    questions = [None] * len(label["questions"])
    for q in label["questions"]:
        questions[q["q"] - 1] = q["value"]
    return {
        "studentId": label["student_id"],
        "serial": label["serial"],
        "questions": questions,
        "total": label["total"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8123")
    args = parser.parse_args()

    labels = json.loads((TESTSET / "labels.json").read_text())["images"]
    quiz_configs = json.loads((TESTSET / "quiz_configs.json").read_text())

    harvested = skipped = 0
    with httpx.Client(base_url=args.base_url, timeout=30.0) as client:
        for i in range(1, 19):
            name = f"real_class_{i:02d}.jpeg"
            label = labels[name]
            if not label.get("expected_success"):
                print(f"{name}: skipping (detection is expected to fail on this photo)")
                skipped += 1
                continue

            config = _quiz_config(label, quiz_configs)
            fields = _harvest_fields(label)
            image_path = TESTSET / "images" / name

            with open(image_path, "rb") as f:
                resp = client.post(
                    "/api/harvest",
                    files={"image": (name, f, "image/jpeg")},
                    data={
                        "config": json.dumps(config),
                        "original": json.dumps(fields),
                        "confirmed": json.dumps(fields),
                    },
                )
            resp.raise_for_status()
            result = resp.json()
            print(f"{name}: harvested={result.get('harvested')}")
            if result.get("harvested"):
                harvested += 1
            else:
                skipped += 1

    print(f"\n{harvested} harvested, {skipped} skipped (out of 18)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
