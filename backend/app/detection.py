"""Grid detection — proportional to the detected table, never to fixed page
coordinates (plan.md §5). This is the make-or-break component (plan.md §6):
parameters below are stack-reference.md's starting values for tuning against
real photographs, not answers arrived at in advance. Do not trust this module
until it has been run against testset/images/ per step.md step 1.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

# --- Tunable starting parameters (stack-reference.md "Grid detection") ---
ADAPTIVE_BLOCK_SIZE = 15
ADAPTIVE_C = -2
KERNEL_DIVISOR = 20            # kernel length = image dimension // this
MIN_TABLE_AREA_FRAC = 0.01     # a table contour must cover at least this much of the image
APPROX_EPSILON_FRAC = 0.02     # approxPolyDP epsilon as a fraction of contour perimeter
BLUR_LAPLACIAN_FLOOR = 50.0    # variance of Laplacian below this -> "blurry"
LINE_PEAK_MIN_GAP_FRAC = 0.02  # merge line-mask peaks closer than this fraction of the table's own dimension
MIN_LINE_COVERAGE_FRAC = 0.4  # a real rule spans nearly the whole table; a digit stroke rarely does

FAILURE_REASONS = {"table_not_found", "column_count_mismatch", "blurry"}


@dataclass
class TableCandidate:
    quad: np.ndarray             # 4x2 float32: TL, TR, BR, BL in source image coords
    warped: np.ndarray           # deskewed BGR crop
    row_bounds: list[int]        # y pixel positions in warped coords, len = rows + 1
    col_bounds: list[int]        # x pixel positions in warped coords, len = cols + 1
    table_type: str = "unknown"  # "id" | "serial" | "marks"

    @property
    def row_count(self) -> int:
        return max(len(self.row_bounds) - 1, 0)

    @property
    def col_count(self) -> int:
        return max(len(self.col_bounds) - 1, 0)


def _order_quad(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as TL, TR, BR, BL."""
    pts = pts.reshape(4, 2).astype("float32")
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).reshape(-1)
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(d)]
    bl = pts[np.argmax(d)]
    return np.array([tl, tr, br, bl], dtype="float32")


def _line_masks(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Isolate horizontal and vertical rules. Kernel length is a fraction of
    image size, never a pixel constant — that's what survives a grid shot
    close up and one shot small in the frame (plan.md §5 step 1)."""
    bw = cv2.adaptiveThreshold(
        ~gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY,
        ADAPTIVE_BLOCK_SIZE, ADAPTIVE_C,
    )
    h, w = bw.shape
    horizontal_size = max(w // KERNEL_DIVISOR, 1)
    vertical_size = max(h // KERNEL_DIVISOR, 1)

    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (horizontal_size, 1))
    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, vertical_size))

    horizontal = cv2.dilate(cv2.erode(bw, hk), hk)
    vertical = cv2.dilate(cv2.erode(bw, vk), vk)
    return horizontal, vertical


def _find_table_quads(mask: np.ndarray, min_area: float) -> list[np.ndarray]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    quads = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, APPROX_EPSILON_FRAC * peri, True)
        if len(approx) == 4:
            quads.append(_order_quad(approx))
        else:
            # curled/imperfect edge: approxPolyDP won't yield a clean quad.
            # minAreaRect always returns exactly 4 vertices (stack-reference.md).
            rect = cv2.minAreaRect(c)
            box = cv2.boxPoints(rect)
            quads.append(_order_quad(box))
    return quads


def _cluster_peaks(profile: np.ndarray, min_gap: int, min_value: float = 0.0) -> list[int]:
    """Positions of contiguous high-value runs in a 1D projection, merged
    into peaks at least min_gap apart. This reads actual line positions —
    never divide the table width by the column count (plan.md §5 step 4).

    min_value is an *absolute* floor, not just relative to this profile's
    own peak. A relative-only threshold accepts a handwritten digit stroke
    (e.g. "1") as a column boundary whenever it happens to be the tallest
    thing in a short table — min_value instead demands near-full-table
    coverage, which a digit rarely reaches even when it's locally the
    strongest column (found on a real photo — see learn.md step 1)."""
    if profile.size == 0 or profile.max() <= 0:
        return []
    idx = np.where((profile > profile.max() * 0.3) & (profile >= min_value))[0]
    if len(idx) == 0:
        return []
    splits = np.where(np.diff(idx) > 1)[0] + 1
    runs = np.split(idx, splits)
    centers = [int(run.mean()) for run in runs]

    merged = [centers[0]]
    for c in centers[1:]:
        if c - merged[-1] >= min_gap:
            merged.append(c)
        else:
            merged[-1] = int((merged[-1] + c) / 2)
    return merged


def _merge_close_bounds(bounds: list[int], min_gap: int) -> list[int]:
    """Collapse adjacent boundaries left too close together after edge
    insertion below. Found on a real phone photo: a genuine border line's
    detected peak didn't land within the fixed few pixels of the table's
    true edge that the edge-insertion step below expects, so it inserted a
    second, redundant boundary right next to the real one — manufacturing
    a row that was never actually there and misclassifying the whole table
    as a result (see learn.md step 6). Keeps the later (edge-side) value,
    since that's the one closer to the table's actual physical border."""
    if not bounds:
        return bounds
    merged = [bounds[0]]
    for b in bounds[1:]:
        if b - merged[-1] < min_gap:
            merged[-1] = b
        else:
            merged.append(b)
    return merged


def _recover_bounds(warped_h_mask: np.ndarray, warped_v_mask: np.ndarray) -> tuple[list[int], list[int]]:
    h, w = warped_h_mask.shape
    row_profile = warped_h_mask.sum(axis=1)  # horizontal rules -> peaks at row boundaries
    col_profile = warped_v_mask.sum(axis=0)  # vertical rules -> peaks at column boundaries
    # 255 per surviving pixel (binary mask) x the near-full-dimension coverage a real rule has.
    row_min_gap = max(int(h * LINE_PEAK_MIN_GAP_FRAC), 10)
    col_min_gap = max(int(w * LINE_PEAK_MIN_GAP_FRAC), 10)
    row_bounds = _cluster_peaks(row_profile, row_min_gap, min_value=MIN_LINE_COVERAGE_FRAC * 255 * w)
    col_bounds = _cluster_peaks(col_profile, col_min_gap, min_value=MIN_LINE_COVERAGE_FRAC * 255 * h)

    # The perspective transform was fit to the table's own outer corners, so
    # the warped crop's own edges are the outer border — include them even if
    # the morphology step didn't recover a clean line exactly on the edge.
    if row_bounds and row_bounds[0] > 5:
        row_bounds.insert(0, 0)
    if row_bounds and row_bounds[-1] < h - 5:
        row_bounds.append(h - 1)
    if col_bounds and col_bounds[0] > 5:
        col_bounds.insert(0, 0)
    if col_bounds and col_bounds[-1] < w - 5:
        col_bounds.append(w - 1)

    row_bounds = _merge_close_bounds(row_bounds, row_min_gap)
    col_bounds = _merge_close_bounds(col_bounds, col_min_gap)

    return row_bounds, col_bounds


def _is_blurry(gray: np.ndarray) -> bool:
    return cv2.Laplacian(gray, cv2.CV_64F).var() < BLUR_LAPLACIAN_FLOOR


def _draw_boundaries(overlay: np.ndarray, cand: TableCandidate) -> None:
    """Project the warped cell boundaries back into source image coordinates
    and draw them on the overlay — the artifact that actually gets looked at
    (plan.md §6)."""
    wh, ww = cand.warped.shape[:2]
    dst = np.array([[0, 0], [ww - 1, 0], [ww - 1, wh - 1], [0, wh - 1]], dtype="float32")
    m_inv = cv2.getPerspectiveTransform(dst, cand.quad)

    for y in cand.row_bounds:
        pts = np.array([[x, y] for x in np.linspace(0, ww - 1, 20)], dtype="float32")
        pts_src = cv2.perspectiveTransform(pts.reshape(-1, 1, 2), m_inv).reshape(-1, 2)
        cv2.polylines(overlay, [pts_src.astype(int)], False, (0, 128, 255), 1)
    for x in cand.col_bounds:
        pts = np.array([[x, y] for y in np.linspace(0, wh - 1, 20)], dtype="float32")
        pts_src = cv2.perspectiveTransform(pts.reshape(-1, 1, 2), m_inv).reshape(-1, 2)
        cv2.polylines(overlay, [pts_src.astype(int)], False, (255, 128, 0), 1)


def detect(image_path: Path, questions: int, id_digits: int, out_dir: Path) -> dict:
    """Run detection on one image, writing overlay.jpg, cells/, and
    result.json to out_dir (step.md 1.7). Returns the same dict as result.json."""
    out_dir.mkdir(parents=True, exist_ok=True)
    cells_dir = out_dir / "cells"
    if cells_dir.exists():
        # Re-running against the same --out path is the normal step 1 tuning
        # loop (step.md). Without clearing first, a shrinking column count
        # leaves stale crops behind (e.g. a leftover id_d8.png from a run
        # that later drops to 7 real digits), silently misrepresenting the
        # current run's actual output.
        for f in cells_dir.iterdir():
            f.unlink()
    else:
        cells_dir.mkdir()

    result: dict = {
        "image": str(image_path),
        "config": {"questions": questions, "id_digits": id_digits},
        "status": "failed",
        "failure_reason": None,
        "tables": [],
    }

    img = cv2.imread(str(image_path))
    if img is None:
        result["failure_reason"] = "table_not_found"
        (out_dir / "result.json").write_text(json.dumps(result, indent=2))
        return result

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    if _is_blurry(gray):
        result["failure_reason"] = "blurry"
        cv2.imwrite(str(out_dir / "overlay.jpg"), img)
        (out_dir / "result.json").write_text(json.dumps(result, indent=2))
        return result

    horizontal, vertical = _line_masks(gray)
    cv2.imwrite(str(out_dir / "mask_horizontal.jpg"), horizontal)
    cv2.imwrite(str(out_dir / "mask_vertical.jpg"), vertical)

    combined = cv2.add(horizontal, vertical)
    min_area = MIN_TABLE_AREA_FRAC * img.shape[0] * img.shape[1]
    quads = _find_table_quads(combined, min_area)

    overlay = img.copy()
    candidates: list[TableCandidate] = []

    for quad in quads:
        tl, tr, br, bl = quad
        width = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
        height = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
        if width < 10 or height < 10:
            continue

        dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype="float32")
        m = cv2.getPerspectiveTransform(quad, dst)
        warped = cv2.warpPerspective(img, m, (width, height))
        # Reuse the *same* line masks that found this table in the first
        # place, warped into the table's own frame — do not re-derive line
        # masks fresh on the small warped crop. A fresh kernel sized to a
        # small single-row table's own height drops the "long enough to be
        # a line" bar so low that an ordinary handwritten letter stroke
        # (e.g. the "l" or "i" in "Serial") clears it and gets mistaken for
        # a column divider. Found on a real hand-drawn photo — see
        # learn.md step 1.
        w_h_mask = cv2.warpPerspective(horizontal, m, (width, height), flags=cv2.INTER_NEAREST)
        w_v_mask = cv2.warpPerspective(vertical, m, (width, height), flags=cv2.INTER_NEAREST)
        row_bounds, col_bounds = _recover_bounds(w_h_mask, w_v_mask)

        candidates.append(TableCandidate(quad=quad, warped=warped, row_bounds=row_bounds, col_bounds=col_bounds))
        cv2.polylines(overlay, [quad.astype(int)], True, (0, 255, 0), 3)

    # --- classify by row count / column count (plan.md §5 step 2) ---
    expected = {"marks": questions + 1, "id": id_digits + 1, "serial": 2}

    # A table rotated 180deg from correct still has the right row/column
    # *counts* — shape alone can't tell upside-down-and-mirrored from
    # right-side-up. The template's own design already gives a free,
    # content-independent way to tell: the answer row is deliberately
    # taller than the header row (plan.md §3), always, by construction. If
    # the *first* row (by top-to-bottom order after warping) is the taller
    # one, this candidate is being read upside down — reject it here rather
    # than accept a shape match that reads every value backwards. Found on
    # a real phone photo where detect_any_orientation's rotation retry
    # landed on exactly this false-positive orientation — see learn.md
    # step 6.
    marks_candidates = [
        c for c in candidates
        if c.row_count == 2 and (c.row_bounds[2] - c.row_bounds[1]) > (c.row_bounds[1] - c.row_bounds[0])
    ]
    single_row = sorted((c for c in candidates if c.row_count == 1), key=lambda c: c.col_count, reverse=True)

    marks = marks_candidates[0] if marks_candidates else None
    id_table = single_row[0] if len(single_row) >= 1 else None
    serial_table = single_row[1] if len(single_row) >= 2 else None

    found = {"marks": marks, "id": id_table, "serial": serial_table}
    for name, cand in found.items():
        if cand is not None:
            cand.table_type = name

    all_found = all(found.values())
    mismatch = False
    for name, cand in found.items():
        entry = {
            "type": name,
            "found": cand is not None,
            "row_count": cand.row_count if cand else None,
            "col_count": cand.col_count if cand else None,
            "expected_col_count": expected[name],
            "match": bool(cand and cand.col_count == expected[name]),
        }
        result["tables"].append(entry)
        if cand and cand.col_count != expected[name]:
            mismatch = True

    if not all_found:
        result["status"] = "failed"
        result["failure_reason"] = "table_not_found"
    elif mismatch:
        result["status"] = "failed"
        result["failure_reason"] = "column_count_mismatch"
    else:
        result["status"] = "ok"

    # --- crops + overlay boundaries for every table we did classify ---
    for name, cand in found.items():
        if cand is None:
            continue
        _draw_boundaries(overlay, cand)
        for r in range(cand.row_count):
            for c in range(cand.col_count):
                y0, y1 = cand.row_bounds[r], cand.row_bounds[r + 1]
                x0, x1 = cand.col_bounds[c], cand.col_bounds[c + 1]
                crop = cand.warped[y0:y1, x0:x1]
                if crop.size == 0:
                    continue
                if name == "marks":
                    fname = f"marks_r{r}_c{c}.png"
                elif name == "id" and c > 0:
                    fname = f"id_d{c}.png"
                elif name == "serial" and c == 1:
                    fname = "serial.png"
                else:
                    continue  # label column — not a data cell
                cv2.imwrite(str(cells_dir / fname), crop)

    cv2.imwrite(str(out_dir / "overlay.jpg"), overlay)
    (out_dir / "result.json").write_text(json.dumps(result, indent=2))
    return result


def detect_any_orientation(image_path: Path, questions: int, id_digits: int, out_dir: Path) -> dict:
    """Try detection at 0/90/180/270 degrees, returning the first success.

    detect() itself stays strict and single-orientation on purpose — step
    1's tuning depends on that not silently drifting. This wrapper exists
    because a real phone photo can't be trusted to arrive upright:
    canvas-captured images carry no EXIF orientation at all, and some real
    devices were found (a real phone, step 6 — see learn.md) to report
    portrait dimensions for a video frame without actually transposing the
    pixel content to match, landing the photographed table sideways with
    nothing in the file to say so. Only retries on table_not_found — a
    blurry photo or a genuine column-count mismatch isn't an orientation
    problem, and retrying either would just waste four detection passes on
    a photo that was never going to work."""
    result = detect(image_path, questions, id_digits, out_dir)
    if result["status"] == "ok" or result["failure_reason"] != "table_not_found":
        return result

    img = cv2.imread(str(image_path))
    if img is None:
        return result

    for rotate_code in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE):
        rotated = cv2.rotate(img, rotate_code)
        rotated_path = out_dir / "_rotation_attempt.jpg"
        cv2.imwrite(str(rotated_path), rotated)
        rotated_result = detect(rotated_path, questions, id_digits, out_dir)
        rotated_path.unlink(missing_ok=True)
        if rotated_result["status"] == "ok":
            return rotated_result

    return result  # nothing worked — return the original (0-degree) failure
