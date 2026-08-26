"""Consistency check for testset/labels.json vs testset/images/.

Step 0's Test: "labels.json parses, has an entry for every file in images/,
and no entry without a file." Run this after every change to either.
"""
import json
import sys
from pathlib import Path

TESTSET = Path(__file__).parent
IMAGE_EXTS = {".jpg", ".jpeg", ".png"}


def main() -> int:
    labels = json.loads((TESTSET / "labels.json").read_text())
    labelled = {k for k in labels.get("images", {}) if not k.startswith("_")}
    files = {p.name for p in (TESTSET / "images").iterdir() if p.suffix.lower() in IMAGE_EXTS}

    missing_labels = files - labelled
    missing_files = labelled - files

    if missing_labels:
        print(f"{len(missing_labels)} image(s) with no label entry:")
        for f in sorted(missing_labels):
            print(f"  {f}")
    if missing_files:
        print(f"{len(missing_files)} label entry(ies) with no matching image:")
        for f in sorted(missing_files):
            print(f"  {f}")

    if missing_labels or missing_files:
        return 1

    print(f"OK — {len(labelled)} images, {len(labelled)} labels, all matched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
