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
import time
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


SOURCE_TAG = "pilot-real-class"


def _post(client, url: str, **kwargs):
    """POST, honouring a 429's Retry-After rather than falling over.

    This script makes two requests per photo, so an 18-photo batch is 36
    requests — over the 30/min per-IP budget step 11.4 added. That limit is
    working as intended; a well-behaved client just has to wait, and
    respecting Retry-After also means this keeps working if it is ever
    pointed at the deployed URL instead of localhost."""
    for _ in range(6):
        resp = client.post(url, **kwargs)
        if resp.status_code != 429:
            return resp
        wait = int(resp.headers.get("retry-after", "5")) + 1
        print(f"    rate limited, waiting {wait}s")
        time.sleep(wait)
    return resp


def _fields_from_scan(result: dict, question_count: int) -> dict:
    """Turn a real /api/scan response into the `original` side of a
    harvest request, so confirmed-vs-corrected reflects what the
    recognizer genuinely produced.

    A failed scan yields all-None, which is correct: the model produced
    nothing usable, so every field the ground truth supplies counts as a
    correction."""
    if result.get("status") != "ok":
        return {"studentId": None, "serial": None,
                "questions": [None] * question_count, "total": None}
    questions = [None] * question_count
    for q in result.get("questions") or []:
        idx = q["q"] - 1
        if 0 <= idx < question_count:
            questions[idx] = q["value"]
    total = (result.get("total") or {}).get("value")
    return {
        "studentId": result.get("student_id"),
        "serial": result.get("serial"),
        "questions": questions,
        "total": total,
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

            # Ask the recognizer what it ACTUALLY reads, and use that as
            # `original`. The first version of this script sent
            # original == confirmed, which meant every crop filed as
            # "confirmed" — i.e. "the model got this right" — when the
            # model had never been asked. That silently destroyed the one
            # signal worth the most: `corrected` crops are the model's real
            # failures. A truthful original costs one extra request per
            # photo and makes the whole batch usable as failure data.
            with open(image_path, "rb") as f:
                scan = _post(
                    client,
                    "/api/scan",
                    files={"image": (name, f, "image/jpeg")},
                    data={"config": json.dumps(config)},
                )
            scan.raise_for_status()
            original = _fields_from_scan(scan.json(), len(config["questions"]))

            with open(image_path, "rb") as f:
                resp = _post(
                    client,
                    "/api/harvest",
                    files={"image": (name, f, "image/jpeg")},
                    data={
                        "config": json.dumps(config),
                        "original": json.dumps(original),
                        "confirmed": json.dumps(fields),
                        # An explicit source tag (step 11.2.4) rather than
                        # letting these fall into "unknown/". This batch is
                        # one identifiable collection — 18 students' scripts
                        # photographed by the pilot instructor — and naming
                        # it keeps a held-out-writer split possible later.
                        # Coarse by design: it groups a whole class, so it
                        # isolates no individual student.
                        "source": SOURCE_TAG,
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
