#!/usr/bin/env python3
"""Standalone detection harness (step.md step 1).

    detect.py <image-path> --questions 5 --id-digits 7 --out debug/

Do not wrap this in FastAPI until it passes step 1's Done-when bar on the
whole testset/ — an HTTP round trip per iteration slows the tuning loop for
no benefit (plan.md §6).
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from app.detection import detect  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="path to the source photograph")
    parser.add_argument("--questions", type=int, required=True, help="number of questions in the marks table")
    parser.add_argument("--id-digits", type=int, required=True, help="number of digit boxes in the ID table")
    parser.add_argument("--out", type=Path, default=Path("debug"), help="output directory for artifacts")
    args = parser.parse_args()

    if not args.image.exists():
        print(f"error: {args.image} does not exist", file=sys.stderr)
        return 1

    result = detect(args.image, args.questions, args.id_digits, args.out)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
