#!/usr/bin/env python3
"""Step 2r.2's own test: run preprocess_for_cnn over real id_d*.png crops
and save the 28x28 outputs, upscaled for viewing, so they can be looked at
directly. "No training run fixes a preprocessing bug" (step.md) — this is
the check that has to happen before any training, not after.

    python cnn/inspect_preprocess.py ../testset/debug/*/cells/id_d*.png
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent.parent))
from cnn.preprocess import preprocess_for_cnn  # noqa: E402

OUT_DIR = Path(__file__).parent / "preview"
UPSCALE = 10  # 28x28 -> 280x280, easy to actually see


def main() -> int:
    paths = [Path(p) for p in sys.argv[1:]]
    if not paths:
        print("usage: inspect_preprocess.py <crop.png> [more crops...]")
        return 1

    OUT_DIR.mkdir(exist_ok=True)
    for path in paths:
        crop = cv2.imread(str(path))
        if crop is None:
            print(f"skip (unreadable): {path}")
            continue
        canvas = preprocess_for_cnn(crop)
        big = cv2.resize(canvas, (28 * UPSCALE, 28 * UPSCALE), interpolation=cv2.INTER_NEAREST)
        # parent dir name (e.g. "phone_2632711_4") disambiguates the same
        # id_d3.png filename across many source images.
        out_name = f"{path.parent.parent.name}_{path.stem}.png"
        cv2.imwrite(str(OUT_DIR / out_name), big)
        print(f"{path} -> {OUT_DIR / out_name}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
