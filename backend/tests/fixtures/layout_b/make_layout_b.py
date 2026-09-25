#!/usr/bin/env python3
"""Regenerate step 16's layout B fixtures (plan.md §21) from real testset photos.

    cd backend && python tests/fixtures/layout_b/make_layout_b.py

Each fixture is a REAL layout A photo turned into layout B: the Serial
box's ink is inpainted away (the paper texture stays), and a one-row
`Name | ... | Section | ...` table is drawn directly above the ID row, the
same distance above it as the Serial box sat below it. The ID and marks
cells are untouched pixels, so a no-serial scan of a fixture must read
exactly what the original photo's layout A scan read — expected.json
records that original read, captured from the unmodified app.

Only photos where detection finds exactly three tables (ID, Serial,
Marks) are used, so the Serial box is simply the middle one by position.
The detector's own line masks are used to LOCATE the boxes; the tests
then check the result through the public detect()/`/api/scan` path.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[2]
sys.path.insert(0, str(BACKEND))
from app import detection  # noqa: E402

SOURCES = ["real_class_01.jpeg", "real_class_07.jpeg", "real_class_12.jpeg", "real_class_17.jpeg"]
TESTSET = BACKEND.parent / "testset" / "images"


def _boxes(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    horizontal, vertical = detection._line_masks(gray)
    min_area = detection.MIN_TABLE_AREA_FRAC * img.shape[0] * img.shape[1]
    quads = detection._find_table_quads(cv2.add(horizontal, vertical), min_area)
    boxes = [tuple(int(v) for v in (*q.min(0), *q.max(0))) for q in quads]
    return sorted(boxes, key=lambda b: b[1])


def to_layout_b(img):
    boxes = _boxes(img)
    assert len(boxes) == 3, f"expected ID/Serial/Marks, found {len(boxes)} tables"
    id_box, serial_box, _marks_box = boxes
    out = img.copy()

    # Erase the Serial box: inpaint its dark pixels, leave the paper.
    m = 12
    x0, y0, x1, y1 = serial_box
    region = cv2.cvtColor(out[y0 - m:y1 + m, x0 - m:x1 + m], cv2.COLOR_BGR2GRAY)
    ink = (region < np.median(region) - 35).astype(np.uint8) * 255
    mask = np.zeros(out.shape[:2], np.uint8)
    mask[y0 - m:y1 + m, x0 - m:x1 + m] = cv2.dilate(ink, np.ones((5, 5), np.uint8))
    out = cv2.inpaint(out, mask, 7, cv2.INPAINT_TELEA)

    # The Name/Section table, directly above the ID row.
    ix0, iy0, ix1, iy1 = id_box
    row_h = iy1 - iy0
    gap = serial_box[1] - iy1
    ty0 = iy0 - gap - row_h
    assert ty0 > 0, "no room above the ID row"
    ty1 = ty0 + row_h
    printed = (35, 35, 35)
    thickness = max(2, row_h // 30)
    cv2.rectangle(out, (ix0, ty0), (ix1, ty1), printed, thickness)
    width = ix1 - ix0
    for frac in (0.12, 0.72, 0.86):
        x = int(ix0 + width * frac)
        cv2.line(out, (x, ty0), (x, ty1), printed, thickness)
    scale = row_h / 75
    cv2.putText(out, "Name", (ix0 + 10, ty0 + int(row_h * 0.62)), cv2.FONT_HERSHEY_SIMPLEX,
                scale, printed, 2, cv2.LINE_AA)
    cv2.putText(out, "Section", (int(ix0 + width * 0.725), ty0 + int(row_h * 0.62)),
                cv2.FONT_HERSHEY_SIMPLEX, scale * 0.8, printed, 2, cv2.LINE_AA)
    pen = (110, 60, 25)
    cv2.putText(out, "Rahim Uddin", (int(ix0 + width * 0.18), ty0 + int(row_h * 0.7)),
                cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, scale * 1.2, pen, 2, cv2.LINE_AA)
    cv2.putText(out, "3", (int(ix0 + width * 0.91), ty0 + int(row_h * 0.7)),
                cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, scale * 1.2, pen, 2, cv2.LINE_AA)
    return out


def main() -> int:
    for name in SOURCES:
        img = cv2.imread(str(TESTSET / name))
        dest = HERE / f"layout_b_{Path(name).stem}.jpg"
        cv2.imwrite(str(dest), to_layout_b(img), [cv2.IMWRITE_JPEG_QUALITY, 92])
        print(dest.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
