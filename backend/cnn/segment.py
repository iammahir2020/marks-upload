"""Segmentation for serial and mark cells (step.md step 3r.1/3r.2, plan.md
§16 "Segmentation"). The ID needs none of this — the template already
gives one digit per box (step 2/2r) — but a serial or mark cell holds
several glyphs in one box, so they have to be pulled apart before the
digit CNN (step 2r) can read them one at a time.

Pure opencv/numpy — no torch, no onnxruntime. This module only decides
*where* the glyphs are; step 2r's `preprocess_for_cnn` and the model
itself decide *what* they are.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

INSET_FRAC = 0.12  # same fraction id_ocr.py/preprocess.py already use —
                     # trims the cell's own ruled border before anything
                     # else, so it never reads as an extra component.
NOISE_AREA_FRAC = 0.0015  # a component below this fraction of the (inset)
                            # cell's area is noise (a speck of paper
                            # texture, a scanning artifact), not a stroke.
                            # Calibrated from a real miss, not guessed: an
                            # initial 0.01 dropped a real handwritten
                            # decimal point (58px, ~0.36% of a real cell's
                            # area) outright, silently turning "2.5" into
                            # an undecodable two-digit reading with no
                            # decimal (step 3r.5 — see learn.md). Lowered
                            # with margin below that real dot's size while
                            # still comfortably above single-pixel specks.
OVERLAP_MERGE_FRAC = 0.5  # merge two components if their x-ranges overlap
                            # by more than this fraction of the narrower
                            # one's width (plan.md §16's own figure for a
                            # disconnected-stroke glyph like a two-part 4).
CENTER_OFFSET_MERGE_FRAC = 0.36  # ...and only if their x-centres are close
                                   # relative to the wider one's width — two
                                   # pieces of one broken stroke are drawn
                                   # in place, roughly stacked (similar
                                   # centre); a decimal point sits beside a
                                   # digit, offset toward one edge. A first
                                   # attempt at this same idea used height
                                   # ratio instead of centre offset and
                                   # broke a genuine disconnected "5" (see
                                   # git history) — measured directly on
                                   # both real cases instead this time: a
                                   # real decimal-beside-"2" case measured
                                   # 0.44, a real disconnected-"5" case
                                   # measured 0.28. Provisional the same way
                                   # every threshold here is (n=2) — expect
                                   # this to move as more real cases turn up.
DECIMAL_HEIGHT_FRAC = 0.35  # a component shorter than this fraction of the
                              # tallest surviving component's height is a
                              # candidate decimal point, not a small digit.
                              # Anchored to the *tallest* component, not the
                              # median: a stray mark elsewhere in the cell
                              # (whiteboard marker artifacts, not paper/pen
                              # noise) can drag a median down enough to make
                              # a real decimal point measure as "too tall to
                              # be a dot" by comparison — the tallest
                              # component is always a real digit's own full
                              # height regardless of how many stray
                              # components exist alongside it (see learn.md
                              # step 3r's follow-up).
DECIMAL_LOWER_BAND_FRAC = 0.5  # and its centroid must sit in the lower
                                 # half of the glyph band — geometry
                                 # alone, no model, no training data
                                 # (plan.md §16). Relaxed from an initial
                                 # "lower third" after a real handwritten
                                 # decimal point (step 3r.5) landed at
                                 # ~60% down a [19,82]px band — a
                                 # hand-drawn dot between two digits sits
                                 # closer to mid-height than a printed
                                 # period does, and "lower third" missed
                                 # it by half a pixel of centroid position
                                 # (see learn.md step 3r).


# --- Weak decimal points (2026-09-25, cnn/half_marks_accuracy.py) -----------
# Measured on a practice page of 121 written half marks: 7 had a clear dot at
# 37-49% of the writing's height (the lower-half rule above needs >= 50%), and
# 6 had a dot of 0.13-0.15% of the crop's area, just under NOISE_AREA_FRAC —
# two of those read as a confident "25" for a written "2.5". A dot found by
# the rules below is WEAK: the decoder tries the value with and without it
# (app/recognizers/local.py), so it can only resolve a reading, or turn a tie
# like 15 / 1.5 into two choices for the instructor — never force one.
WEAK_DOT_MIN_BAND_FRAC = 0.25  # a weak dot's centre must sit below the top quarter of
                                 # the writing: mid-height is where people put it
                                 # (the lowest measured was 0.37); higher up, a small
                                 # blob is more likely a stray mark than a point
WEAK_DOT_MAX_ASPECT = 2.0  # roughly round: neither side more than 2x the other, which
                             # keeps out a hyphen, a slash, or a sliver of a stroke
WEAK_DOT_MIN_AREA_FRAC = 0.02  # a rescued blob's ink as a fraction of the largest glyph's
                                 # ink (pixels, not bounding boxes, so pen weight cancels
                                 # out) — measured dots were 3.5-6% of their digit, paper
                                 # specks under 1%
STRAY_MIN_AREA_FRAC = 0.01  # smaller than this (vs the largest glyph) isn't even
                              # evidence that a point might have been lost

# --- Glyphs as wide as two digits -------------------------------------------
# "2" and "0" written touching come out as one component; the model reads the
# pair as "2", and "20.5" decoded as a confident 2.5 on the same page. A digit
# is rarely wider than it is tall, so a glyph this wide is never trusted.
WIDE_GLYPH_ASPECT = 1.25  # width / height
WIDE_GLYPH_VS_PEERS = 1.4  # ...and, when the cell has other digits, this much wider
                             # than their median — a broad single "4" or "2" isn't two
WIDE_SPLIT_FRACS = (0.35, 0.425, 0.5, 0.575, 0.65)  # cut positions tried, as a fraction
                                                     # of the glyph's width


@dataclass
class Glyph:
    image: np.ndarray   # cropped BGR/gray glyph, in the inset cell's own coordinates
    x0: int
    x1: int
    is_decimal: bool
    weak: bool = False       # a decimal point found only by the weak-dot rules above
    maybe_two: bool = False  # a digit glyph as wide as two touching digits


@dataclass
class Segmentation:
    glyphs: list[Glyph]
    # Ink between two digits that wasn't classified as anything: a point
    # may have been lost there, so a two-digit reading isn't certain.
    stray_between: bool = False


def _merge_overlapping(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """boxes: (x0, y0, x1, y1), already sorted left to right. Merges any
    two whose x-ranges overlap by more than OVERLAP_MERGE_FRAC of the
    narrower one's width AND whose x-centres are close relative to the
    wider one's width — a disconnected stroke (a two-part 4 or 5)
    produces two components that are really one glyph (plan.md §16's own
    example, and the single most common segmentation failure to get
    wrong), while a decimal point sitting close enough to a digit to
    overlap it in x is a different glyph entirely and must not be merged
    away before it ever reaches decimal classification."""
    return [box for box, _members in _merge_with_members([(b, i) for i, b in enumerate(boxes)])]


def _merge_with_members(comps: list[tuple[tuple[int, int, int, int], int]]):
    """_merge_overlapping's exact rule, also recording which connected
    components (by label) went into each merged box — so a pen dot the rule
    folded into a digit can be taken back out (see segment_cell_detail).
    `comps` is [(box, label)], sorted left to right."""
    merged: list[list] = []  # [box, [labels]]
    for box, label in comps:
        if merged:
            px0, py0, px1, py1 = merged[-1][0]
            x0, y0, x1, y1 = box
            overlap = min(px1, x1) - max(px0, x0)
            narrower_width = min(px1 - px0, x1 - x0)
            prev_center, this_center = (px0 + px1) / 2, (x0 + x1) / 2
            wider_width = max(px1 - px0, x1 - x0)
            center_offset_frac = abs(prev_center - this_center) / wider_width if wider_width > 0 else 0
            if (
                narrower_width > 0
                and overlap / narrower_width > OVERLAP_MERGE_FRAC
                and center_offset_frac <= CENTER_OFFSET_MERGE_FRAC
            ):
                merged[-1][0] = (min(px0, x0), min(py0, y0), max(px1, x1), max(py1, y1))
                merged[-1][1].append(label)
                continue
        merged.append([box, [label]])
    return [(tuple(b), members) for b, members in merged]


def segment_cell(cell: np.ndarray) -> list[Glyph]:
    """One cell crop (a serial, mark, or total answer box) -> its
    individual glyphs, left to right, each tagged digit-vs-decimal-point.
    See segment_cell_detail, which this wraps."""
    return segment_cell_detail(cell).glyphs


def _between(cx: float, digits: list[tuple[int, int, int, int]]) -> bool:
    """A point sits between two digits: one digit's CENTRE to its left and
    another's to its right. A small blob before the first digit or after the
    last one is never a decimal point — every legal value has digits on
    both sides.

    Centres, not edges: a "2"'s long base or a "7"'s top bar reaches out
    over the point, so no digit lies WHOLLY to its left (two harvested
    "2.5"s and one practice-page "7.5" were missed that way)."""
    centres = [(b[0] + b[2]) / 2.0 for b in digits]
    return any(c < cx for c in centres) and any(c > cx for c in centres)


def _is_round(w: int, h: int) -> bool:
    return w > 0 and h > 0 and max(w / h, h / w) <= WEAK_DOT_MAX_ASPECT


def segment_cell_detail(cell: np.ndarray) -> Segmentation:
    """One cell crop -> its glyphs left to right, plus whether unexplained
    ink sits between two digits.

    Returns no glyphs for a blank cell — checked *before* any
    per-component classification, mirroring id_ocr.py's own "a blank
    input should never produce an arbitrary glyph shape" posture (plan.md
    §16: "A classifier always outputs something; feed it a blank cell and
    it returns a confident wrong digit").

    Everything the strong (original) rules decide is unchanged; the weak-dot
    and wide-glyph rules only ever ADD information on top of it, which the
    decoder treats with suspicion (see the constants above).
    """
    h, w = cell.shape[:2]
    dy, dx = int(h * INSET_FRAC), int(w * INSET_FRAC)
    inset = cell[dy:h - dy, dx:w - dx] if h > 2 * dy and w > 2 * dx else cell

    gray = cv2.cvtColor(inset, cv2.COLOR_BGR2GRAY) if inset.ndim == 3 else inset
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(bw, connectivity=8)
    cell_area = inset.shape[0] * inset.shape[1]
    noise_floor = cell_area * NOISE_AREA_FRAC

    comps = []  # ((x0, y0, x1, y1), label); label 0 is the background
    rejected = []  # (x0, y0, x1, y1, area) — below the noise floor
    largest_ink = 1
    for label in range(1, num_labels):
        x, y, cw, ch, area = stats[label]
        if area < noise_floor:
            rejected.append((x, y, x + cw, y + ch, area))
            continue
        comps.append(((x, y, x + cw, y + ch), label))
        largest_ink = max(largest_ink, int(area))

    if not comps:
        return Segmentation([])

    comps.sort(key=lambda c: c[0][0])
    merged = _merge_with_members(comps)
    boxes = [b for b, _ in merged]
    comp_box = dict((label, box) for box, label in comps)

    heights = [y1 - y0 for _, y0, _, y1 in boxes]
    max_height = float(max(heights))
    band_top = min(y0 for _, y0, _, _ in boxes)
    band_bottom = max(y1 for _, _, _, y1 in boxes)
    band_height = max(band_bottom - band_top, 1)
    lower_third_start = band_top + band_height * (1 - DECIMAL_LOWER_BAND_FRAC)
    weak_start = band_top + band_height * WEAK_DOT_MIN_BAND_FRAC

    def is_small(b) -> bool:
        return max_height > 0 and (b[3] - b[1]) < max_height * DECIMAL_HEIGHT_FRAC

    digits = [b for b in boxes if not is_small(b)]

    glyphs = []
    glyph_members: list[list[int]] = []  # parallel to glyphs: the components merged into each
    stray = False
    for b, members in merged:
        x0, y0, x1, y1 = b
        centroid_y = (y0 + y1) / 2.0
        cx = (x0 + x1) / 2.0
        is_decimal = is_small(b) and centroid_y >= lower_third_start
        weak = False
        if is_small(b) and not is_decimal:
            if _is_round(x1 - x0, y1 - y0) and centroid_y >= weak_start and _between(cx, digits):
                is_decimal = weak = True
            elif _between(cx, digits):
                stray = True
        glyphs.append(Glyph(image=inset[y0:y1, x0:x1], x0=x0, x1=x1, is_decimal=is_decimal, weak=weak))
        glyph_members.append(members)

    # A dot tucked inside a digit's outline — under a "7"'s top bar, say —
    # overlaps it enough that the pen-lift rule above merged the two. Take
    # it back out when that one piece is exactly what a weak point looks
    # like: small, round, below the top quarter, and between two digit
    # centres. Its pixels are blanked from the digit it was merged into. If
    # no piece qualifies the merge stands, exactly as before.
    if not any(g.is_decimal for g in glyphs):
        for gi, members in enumerate(glyph_members):
            if len(members) < 2:
                continue
            for label in members:
                bx0, by0, bx1, by1 = comp_box[label]
                if (
                    is_small(comp_box[label])
                    and _is_round(bx1 - bx0, by1 - by0)
                    and (by0 + by1) / 2.0 >= weak_start
                    and _between((bx0 + bx1) / 2.0, digits)
                ):
                    rest = [comp_box[m] for m in members if m != label]
                    rx0, ry0 = min(b[0] for b in rest), min(b[1] for b in rest)
                    rx1, ry1 = max(b[2] for b in rest), max(b[3] for b in rest)
                    digit_img = inset.copy()
                    digit_img[labels == label] = 255
                    dot_img = np.full_like(inset, 255)
                    dot_img[labels == label] = inset[labels == label]
                    glyphs[gi] = Glyph(image=digit_img[ry0:ry1, rx0:rx1], x0=rx0, x1=rx1, is_decimal=False)
                    glyphs.append(Glyph(image=dot_img[by0:by1, bx0:bx1], x0=bx0, x1=bx1,
                                        is_decimal=True, weak=True))
                    break
            if any(gl.is_decimal for gl in glyphs):
                break

    # A dot that fell under the noise floor: rescued only when it is round,
    # between two digits, below the top quarter, and big enough next to the
    # digits to be a pen dot rather than paper texture. Anything smaller
    # that still sits between digits is recorded as stray ink.
    for x0, y0, x1, y1, area in rejected:
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        if not _between(cx, digits) or not (band_top <= cy <= band_bottom):
            continue
        if (
            area >= largest_ink * WEAK_DOT_MIN_AREA_FRAC
            and _is_round(x1 - x0, y1 - y0)
            and cy >= weak_start
            and not any(g.is_decimal for g in glyphs)
        ):
            glyphs.append(Glyph(image=inset[y0:y1, x0:x1], x0=x0, x1=x1, is_decimal=True, weak=True))
        elif area >= largest_ink * STRAY_MIN_AREA_FRAC:
            stray = True
    glyphs.sort(key=lambda g: g.x0)

    digit_glyphs = [g for g in glyphs if not g.is_decimal]
    for g in digit_glyphs:
        gw, gh = g.x1 - g.x0, g.image.shape[0]
        peers = [o.x1 - o.x0 for o in digit_glyphs if o is not g]
        wide = gh > 0 and gw / gh >= WIDE_GLYPH_ASPECT
        if wide and peers:
            wide = gw >= WIDE_GLYPH_VS_PEERS * float(np.median(peers))
        g.maybe_two = bool(wide)

    return Segmentation(glyphs, stray_between=stray)


def split_wide(glyph: Glyph, frac: float) -> tuple[Glyph, Glyph] | None:
    """Cut a maybe_two glyph in two at `frac` of its width. None if either
    side would hold no ink.

    The caller tries several cuts (WIDE_SPLIT_FRACS) and keeps the one the
    model reads best, because no single geometric rule finds the join: the
    thinnest column of a touching "20" is the middle of the "0" (only its
    top and bottom strokes), not where the two digits meet."""
    img = glyph.image
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    cut = int(bw.shape[1] * frac)
    if cut <= 0 or cut >= bw.shape[1] or bw[:, :cut].sum() == 0 or bw[:, cut:].sum() == 0:
        return None
    return (
        Glyph(image=img[:, :cut], x0=glyph.x0, x1=glyph.x0 + cut, is_decimal=False),
        Glyph(image=img[:, cut:], x0=glyph.x0 + cut, x1=glyph.x1, is_decimal=False),
    )
