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
CONTRAST_FLOOR = 30  # a pixel counts as "ink" only if it's this much darker (0-255 grayscale)
                       # than its own local, same-row/column paper background. Ground truth for
                       # this number, and for the two floors below, comes from a real cluttered
                       # notebook photo (2026-08-29, testset/debug/clutter_*) where genuine table
                       # dividers measured contrast 63-116 and known noise (a table's own left/right
                       # border re-detected next to the synthetic edge) measured 18-38 — see learn.md.
MIN_LINE_COVERAGE_FRAC = 0.4  # a real rule is dark (>=CONTRAST_FLOOR) across nearly the whole table;
                                # a digit stroke rarely is, even though it can be locally just as dark.
                                # Coverage is measured directly on the source grayscale image (raw
                                # pixel-vs-local-background contrast), not on the binarized,
                                # morphologically-eroded/dilated line mask that finds candidate
                                # positions in the first place: that mask is good at *locating* a line
                                # cheaply, but adaptiveThreshold plus erode/dilate — both tuned for the
                                # whole image, not per-line — can fragment one genuine, fully dark line
                                # into disconnected pieces under uneven lighting or a steep angle,
                                # undercounting its own coverage. On a real photo (2026-08-29) two
                                # genuine ID-row dividers measured only 41-43% *mask* coverage — below
                                # this floor — while their own raw pixels were just as dark against the
                                # paper (contrast 80-94) as every accepted divider in the same row
                                # (63-116); scoring contrast directly recovers exactly this case
                                # without loosening what counts as a genuine line (see learn.md).
MIN_RELATIVE_PEAK_FRAC = 0.65  # among a table's *own* surviving dividers, reject one shorter than
                                # this fraction of their median length — a hand-ruled grid draws
                                # every real divider to roughly the same length, so an outlier that
                                # still clears MIN_LINE_COVERAGE_FRAC is far more likely to be a
                                # stray mark than an intentional one (found on a real hand-drawn
                                # whiteboard photo: a stray line cleared the absolute floor at 0.445
                                # coverage while its 9 genuine peers all measured 0.57-0.99 — see
                                # learn.md). Only applied with >=4 peers, so a table with too few
                                # dividers to have a meaningful "typical length" is left alone —
                                # exactly the short-table case this function's own min_value
                                # docstring already warns a relative-only rule is unsafe for.

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


def _contrast_coverage(gray: np.ndarray, axis: str, center: int, margin_frac: float = 0.1) -> float:
    """Fraction of a candidate line's length where the raw grayscale pixel is
    at least CONTRAST_FLOOR darker than its own local, same-row/column paper
    background — measured directly on the source grayscale image, not on the
    binarized-and-morphologically-cleaned line mask that only located this
    candidate's approximate position. See CONTRAST_FLOOR/MIN_LINE_COVERAGE_FRAC
    above for why this exists and the real numbers behind it. margin_frac
    trims the first/last 10% of the line's length, where a header row's own
    label text can bleed into the very first/last few pixels of a column."""
    h, w = gray.shape
    if axis == "col":
        length = h
        lo, hi = int(length * margin_frac), int(length * (1 - margin_frac))
        offset = max(int(w * 0.02), 5)
        left, right = max(center - offset, 0), min(center + offset, w - 1)
        line_vals = gray[lo:hi, center].astype(int)
        bg_vals = np.maximum(gray[lo:hi, left], gray[lo:hi, right]).astype(int)
    else:
        length = w
        lo, hi = int(length * margin_frac), int(length * (1 - margin_frac))
        offset = max(int(h * 0.02), 5)
        top, bottom = max(center - offset, 0), min(center + offset, h - 1)
        line_vals = gray[center, lo:hi].astype(int)
        bg_vals = np.maximum(gray[top, lo:hi], gray[bottom, lo:hi]).astype(int)
    if line_vals.size == 0:
        return 0.0
    return float(((bg_vals - line_vals) >= CONTRAST_FLOOR).mean())


def _cluster_peaks(profile: np.ndarray, min_gap: int, gray: np.ndarray, axis: str) -> list[int]:
    """Positions of contiguous high-value runs in a 1D line-mask projection,
    merged into peaks at least min_gap apart. This reads actual line
    positions — never divide the table width by the column count (plan.md
    §5 step 4). The line mask (profile) only *locates* candidates cheaply;
    whether each one clears MIN_LINE_COVERAGE_FRAC / MIN_RELATIVE_PEAK_FRAC
    is decided on _contrast_coverage instead of the mask's own value, for the
    reasons documented on MIN_LINE_COVERAGE_FRAC above.

    The absolute floor is deliberate, not just a relative-to-peak threshold.
    A relative-only threshold accepts a handwritten digit stroke (e.g. "1")
    as a column boundary whenever it happens to be the tallest thing in a
    short table — the absolute floor instead demands near-full-table
    coverage, which a digit rarely reaches even when it's locally the
    strongest column (found on a real photo — see learn.md step 1)."""
    if profile.size == 0 or profile.max() <= 0:
        return []
    idx = np.where(profile > profile.max() * 0.3)[0]
    if len(idx) == 0:
        return []
    splits = np.where(np.diff(idx) > 1)[0] + 1
    runs = np.split(idx, splits)
    centers = [int(run.mean()) for run in runs]
    coverages = [_contrast_coverage(gray, axis, c) for c in centers]

    kept = [(c, v) for c, v in zip(centers, coverages) if v >= MIN_LINE_COVERAGE_FRAC]
    if not kept:
        return []

    if len(kept) >= 4:
        median_value = float(np.median([v for _, v in kept]))
        floor = median_value * MIN_RELATIVE_PEAK_FRAC
        kept = [(c, v) for c, v in kept if v >= floor]
        if not kept:
            return []

    centers = [c for c, _ in kept]
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


def _recover_bounds(
    warped_h_mask: np.ndarray, warped_v_mask: np.ndarray, warped_gray: np.ndarray
) -> tuple[list[int], list[int]]:
    h, w = warped_h_mask.shape
    row_profile = warped_h_mask.sum(axis=1)  # horizontal rules -> peaks at row boundaries
    col_profile = warped_v_mask.sum(axis=0)  # vertical rules -> peaks at column boundaries
    row_min_gap = max(int(h * LINE_PEAK_MIN_GAP_FRAC), 10)
    col_min_gap = max(int(w * LINE_PEAK_MIN_GAP_FRAC), 10)
    row_bounds = _cluster_peaks(row_profile, row_min_gap, warped_gray, axis="row")
    col_bounds = _cluster_peaks(col_profile, col_min_gap, warped_gray, axis="col")

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


LABEL_COLUMN_INSET_FRAC = 0.12  # same border-trim fraction id_ocr.py/segment.py already use,
                                  # so a cell's own ruled border is never counted as ink.
LABEL_COLUMN_NOISE_AREA_FRAC = 0.01  # component area floor, as a fraction of the (inset)
                                       # column's own area — drops single-pixel/JPEG-noise
                                       # specks before counting. A separate constant from
                                       # cnn/segment.py's own NOISE_AREA_FRAC on purpose: this
                                       # module has no dependency on the optional CNN track.


def _column_component_count(gray: np.ndarray, y0: int, y1: int, x0: int, x1: int) -> int:
    """Count of real (non-noise) connected ink components in one cell crop —
    the proxy _label_column_is_backwards uses for "is this a multi-character
    word or a single digit/number.\""""
    h, w = y1 - y0, x1 - x0
    dy, dx = int(h * LABEL_COLUMN_INSET_FRAC), int(w * LABEL_COLUMN_INSET_FRAC)
    crop = gray[y0 + dy:y1 - dy, x0 + dx:x1 - dx] if h > 2 * dy and w > 2 * dx else gray[y0:y1, x0:x1]
    if crop.size == 0:
        return 0
    _, bw = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    n, _, stats, _ = cv2.connectedComponentsWithStats(bw, connectivity=8)
    noise_floor = crop.shape[0] * crop.shape[1] * LABEL_COLUMN_NOISE_AREA_FRAC
    return sum(1 for i in range(1, n) if stats[i, 4] >= noise_floor)


def _label_column_is_backwards(gray: np.ndarray, row_bounds: list[int], col_bounds: list[int]) -> bool | None:
    """For a single-row ID/Serial candidate: True if the *last* column looks
    like the multi-character label cell ("ID"/"Serial") and the *first*
    looks like a single digit/number — i.e. this candidate's column order is
    backwards, the signature of a 180-degree-flipped read. A flip reverses
    row and column order together, so resolving left-right order here is
    enough by itself to catch it, for this table and every other table on
    the same page. False if the first column is the label (correctly
    oriented). None if the two ends are tied — genuinely inconclusive, so
    the caller must not reject on this signal alone.

    Component count, not ink darkness/coverage, because a multi-letter word
    reliably fragments into more disconnected ink components than a lone
    digit or short number regardless of ink weight or paper lighting —
    verified directly on 3 real photos plus 1 synthetic photo (2026-08-29):
    the true label column had strictly more components than the opposite
    end in all 6 ID/Serial rows checked (gaps of 1-7 components), including
    a case where an ink-darkness-based measure came out nearly tied. See
    learn.md."""
    n_cols = len(col_bounds) - 1
    if n_cols < 2:
        return None
    first = _column_component_count(gray, row_bounds[0], row_bounds[1], col_bounds[0], col_bounds[1])
    last = _column_component_count(gray, row_bounds[0], row_bounds[1], col_bounds[-2], col_bounds[-1])
    if first == last:
        return None
    return last > first


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
        w_gray = cv2.warpPerspective(gray, m, (width, height))
        row_bounds, col_bounds = _recover_bounds(w_h_mask, w_v_mask, w_gray)

        candidates.append(TableCandidate(quad=quad, warped=warped, row_bounds=row_bounds, col_bounds=col_bounds))
        cv2.polylines(overlay, [quad.astype(int)], True, (0, 255, 0), 3)

    # --- classify by row count / column count (plan.md §5 step 2) ---
    expected = {"marks": questions + 1, "id": id_digits + 1, "serial": 2}

    # A table rotated 180deg from correct still has the right row/column
    # *counts* — shape alone can't tell upside-down-and-mirrored from
    # right-side-up. The ID/Serial rows give a stronger, content-independent
    # tell than the marks table's own header/value row heights do: column 0
    # is always the multi-character label ("ID"/"Serial"), every other
    # column a lone digit or short number, by construction. A flip reverses
    # row *and* column order together, so this one check is enough to catch
    # it for every table on the page — see _label_column_is_backwards for
    # the real measurements behind it.
    single_row_raw = sorted((c for c in candidates if c.row_count == 1), key=lambda c: c.col_count, reverse=True)
    single_row: list[TableCandidate] = []
    orientation_confirmed = False
    for c in single_row_raw:
        c_gray = cv2.cvtColor(c.warped, cv2.COLOR_BGR2GRAY)
        backwards = _label_column_is_backwards(c_gray, c.row_bounds, c.col_bounds)
        if backwards is True:
            continue
        if backwards is False:
            orientation_confirmed = True
        single_row.append(c)

    if orientation_confirmed:
        # Whole-photo orientation is already confirmed correct from the
        # ID/Serial check above — every table on the same page shares that
        # one rotation, so the marks table needs no separate check here.
        marks_candidates = [c for c in candidates if c.row_count == 2]
    else:
        # No ID/Serial signal available (missing, or both ends tied) — fall
        # back to the original height-based check: the template's answer
        # row is deliberately taller than the header row (plan.md §3),
        # always, by construction. If the *first* row (by top-to-bottom
        # order after warping) is the taller one, this candidate is being
        # read upside down — reject it here rather than accept a shape
        # match that reads every value backwards. Found on a real phone
        # photo where detect_any_orientation's rotation retry landed on
        # exactly this false-positive orientation — see learn.md step 6.
        marks_candidates = [
            c for c in candidates
            if c.row_count == 2 and (c.row_bounds[2] - c.row_bounds[1]) > (c.row_bounds[1] - c.row_bounds[0])
        ]

    marks = marks_candidates[0] if marks_candidates else None

    # Select id/serial by *position*, not column count. Picking by count
    # (or by rank-among-counts) breaks once a second, same-shaped candidate
    # can appear in frame — e.g. a neighboring script's own ID row peeking
    # in below this one (the real_class_* photos' "adjacent scripts in
    # frame" condition): two 8-column single-row candidates can both be
    # present. Worse, if this script's *own* row happens to have a genuine,
    # unrelated column-detection shortfall (e.g. 7 columns instead of 8,
    # a real line-detection miss), count-based matching would exclude the
    # correct row entirely and silently accept the decoy instead — turning
    # an honest column_count_mismatch into a false "ok" that reads the
    # wrong student's ID. The template's layout is fixed and tightly
    # grouped for one script instance (ID directly above Serial directly
    # above Marks), and the marks table is reliably unambiguous, so it
    # anchors the choice: among single-row candidates positioned above the
    # marks table, the closest one is this script's own Serial row and the
    # second-closest is its own ID row — true regardless of either row's
    # actual column count, which the existing match/mismatch check below
    # still verifies honestly. Any decoy from a neighboring script sits
    # either on the far side of a full table's worth of vertical gap
    # (below marks) or, if above, farther from marks than this script's
    # own two rows are (a different script entirely) — so it never wins
    # the "closest" comparison.
    if marks is not None:
        marks_top = (marks.quad[0][1] + marks.quad[1][1]) / 2
        above_marks = sorted(
            (c for c in single_row if (c.quad[2][1] + c.quad[3][1]) / 2 <= marks_top),
            key=lambda c: marks_top - (c.quad[2][1] + c.quad[3][1]) / 2,
        )
        # Closest above marks = Serial (sits directly on top of Marks);
        # second-closest = ID (sits directly on top of Serial).
        serial_table = above_marks[0] if len(above_marks) >= 1 else None
        id_table = above_marks[1] if len(above_marks) >= 2 else None
    else:
        # No marks table to anchor to — fall back to the original
        # rank-by-column-count order (unchanged behavior for this
        # degenerate case, which fails elsewhere anyway): highest count
        # is ID, next is Serial.
        by_count = sorted(single_row, key=lambda c: c.col_count, reverse=True)
        id_table = by_count[0] if len(by_count) >= 1 else None
        serial_table = by_count[1] if len(by_count) >= 2 else None

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
