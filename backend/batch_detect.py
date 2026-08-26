#!/usr/bin/env python3
"""Batch runner (step.md step 1.8): run detection over every image in a
directory in one command, writing per-image output into subdirectories you
can review side by side.

    batch_detect.py testset/images --questions 5 --id-digits 7 --out testset/debug/
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from app.detection import detect  # noqa: E402

IMAGE_EXTS = {".jpg", ".jpeg", ".png"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images_dir", type=Path)
    parser.add_argument("--questions", type=int, required=True)
    parser.add_argument("--id-digits", type=int, required=True)
    parser.add_argument("--out", type=Path, default=Path("debug"))
    args = parser.parse_args()

    images = sorted(p for p in args.images_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    if not images:
        print(f"no images found in {args.images_dir}", file=sys.stderr)
        return 1

    summary = []
    for image in images:
        out_dir = args.out / image.stem
        result = detect(image, args.questions, args.id_digits, out_dir)
        summary.append({"image": image.name, "status": result["status"], "failure_reason": result["failure_reason"]})
        print(f"{image.name}: {result['status']} ({result['failure_reason'] or 'ok'})")

    (args.out).mkdir(parents=True, exist_ok=True)
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2))

    ok = sum(1 for s in summary if s["status"] == "ok")
    print(f"\n{ok}/{len(summary)} ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
