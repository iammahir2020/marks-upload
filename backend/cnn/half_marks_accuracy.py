#!/usr/bin/env python3
"""Half-mark / decimal-point accuracy harness (plan.md §16 "Segmentation").

Two sources, reported separately because they answer different questions:

  pages     Practice pages of written values (training_data/pages/values.json).
            Mostly half marks, so this measures how often a written dot is
            FOUND — mid-height dots, tiny dots, dots touching a digit.

  harvested Every harvested mark/total cell crop (training_data/all, or
            training_data/harvested as a fallback), labelled with the value
            the instructor confirmed. ~90% whole marks, so this measures the
            other direction: a looser dot rule INVENTING a dot on a whole
            mark. That is the number that must not get worse.

Each value is decoded exactly the way CNNRecognizer reads a real cell, and
lands in one bucket:

  correct   the value itself was right
  choices   left blank with a one-tap choice set that contains the truth
            (the 15/1.5-style tie, or a lost point's "2 5" -> 2.5)
  blank     left blank with nothing useful offered — safe, but typing
  WRONG     a wrong value filled in with no flag. Must be 0.

Legal sets: harvested crops don't record their question's max, so every
marks_q* cell is decoded against 0..10 and every total against 0..50 — the
same, slightly harsher, sets before and after any change. Practice pages
use 0..25, the range where 25/2.5-style ties exist.

    python cnn/half_marks_accuracy.py            # both sources
    python cnn/half_marks_accuracy.py --show     # list every non-correct read

values.json, next to pages.json (gitignored — real handwriting):

    {"pages": [{"file": "half_marks_01.jpg", "right_trim": 0.985,
                "rows": [[1.5, 2.5, 10.5], "0.5x10", "20.5x9"]}]}

A row is a list of values left to right, "<value>x<count>", or null to skip
it (still counted, so the rows below keep their place) — for a row whose
spacing can't be split reliably, like one where the gap inside "10.5" is
wider than the gaps between values.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.marks import legal_values  # noqa: E402
from app.recognizers.local import CNNRecognizer  # noqa: E402

BACKEND = Path(__file__).resolve().parent.parent
PAGES = BACKEND / "training_data" / "pages"

INK_MAX_GRAY = 110
SKIPPED = [0]
ALL_CROPS = [False]  # --all-crops: keep them, for looking at (touching digits count as one)  # page crops dropped as unreliable splits, reported with the results  # pen ink is dark; a page edge against a desk is mid-grey


def _row_values(spec) -> list[float]:
    if isinstance(spec, list):
        return [float(v) for v in spec]
    value, count = spec.split("x")
    return [float(value)] * int(count)


def _split_at_dots(row: list, glyph_h: float, count: int) -> list[list] | None:
    """On a row of half marks every value has exactly one point, followed by
    exactly one digit — so each value ends at the first digit-sized blob
    after its point. Far more reliable than gap widths ("10.5" often has a
    wider gap inside it than between values). None when the row's small
    blobs don't come out to exactly one per value; the caller then falls
    back to gaps."""
    small = [i for i, (s, _) in enumerate(row) if s[3] < glyph_h * 0.4]
    if len(small) > count:
        return None
    certain = set()
    for d in small:
        after = next((i for i in range(d + 1, len(row)) if row[i][0][3] >= glyph_h * 0.4), None)
        if after is None:
            return None
        if after + 1 < len(row):
            certain.add(after + 1)
    # A dot that touches its digit merges into it at page level, so some
    # values show no separate dot. Their cuts come from the widest gaps —
    # never a gap beside a dot, which is inside a value by construction.
    gaps, right = [], row[0][0][0] + row[0][0][2]
    for i in range(1, len(row)):
        beside_dot = (i - 1) in small or i in small
        if i not in certain and not beside_dot:
            gaps.append((row[i][0][0] - right, i))
        right = max(right, row[i][0][0] + row[i][0][2])
    needed = count - 1 - len(certain)
    if needed < 0 or needed > len(gaps):
        return None
    cuts = sorted(certain | {i for _, i in sorted(gaps, reverse=True)[:needed]})
    return [row[a:b] for a, b in zip([0] + cuts, cuts + [len(row)])]


def page_cells(entry: dict) -> list[tuple[np.ndarray, float]]:
    """A practice page -> (cell-like crop, true value) per written value.

    Rows are found by clustering ink blobs by height; each row is split into
    its known number of values at its widest gaps (hand spacing varies too
    much for a fixed gap size). A row whose split can't be trusted is
    skipped rather than mislabelled."""
    img = cv2.imread(str(PAGES / entry["file"]))
    if img is None:
        print(f"pages: cannot read {entry['file']}", file=sys.stderr)
        return []
    img = img[:, : int(img.shape[1] * entry.get("right_trim", 1.0))]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    bw = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 51, 15)
    n, lab, st, cen = cv2.connectedComponentsWithStats(bw, connectivity=8)
    blobs = [(st[i], cen[i]) for i in range(1, n)
             if st[i][4] >= 15 and np.median(gray[lab == i]) < INK_MAX_GRAY]
    if not blobs:
        return []
    glyph_h = float(np.median([s[3] for s, _ in blobs if s[3] > 30]))

    blobs.sort(key=lambda b: b[1][1])
    rows: list[list] = []
    for s, c in blobs:
        if rows and abs(c[1] - np.mean([b[1][1] for b in rows[-1]])) < glyph_h * 0.8:
            rows[-1].append((s, c))
        else:
            rows.append([(s, c)])
    rows = [r for r in rows if sum(1 for s, _ in r if s[3] > glyph_h * 0.5) >= 5]

    specs = entry["rows"]
    if len(rows) != len(specs):
        print(f"pages: {entry['file']} has {len(rows)} rows, manifest says {len(specs)} — skipped",
              file=sys.stderr)
        return []

    out = []
    for row, spec in zip(rows, specs):
        if spec is None:
            continue
        truth = _row_values(spec)
        row.sort(key=lambda b: b[0][0])
        groups = _split_at_dots(row, glyph_h, len(truth))
        if groups is None:
            gaps, right = [], row[0][0][0] + row[0][0][2]
            for i in range(1, len(row)):
                gaps.append((row[i][0][0] - right, i))
                right = max(right, row[i][0][0] + row[i][0][2])
            cuts = sorted(i for _, i in sorted(gaps, reverse=True)[: len(truth) - 1])
            groups = [row[a:b] for a, b in zip([0] + cuts, cuts + [len(row)])]
        if len(groups) != len(truth):
            continue
        for g, t in zip(groups, truth):
            # A crop must hold exactly the digits its value has ("10.5" -> 3).
            # Anything else is this script's own row/value split going wrong
            # on a slanted row — a sliver, or two values — and scoring it
            # would blame the recognizer for the harness.
            digits = sum(1 for s, _ in g if s[3] >= glyph_h * 0.4)
            if digits != len(f"{t:g}".replace(".", "")) and not ALL_CROPS[0]:
                SKIPPED[0] += 1
                continue
            x0 = min(s[0] for s, _ in g); x1 = max(s[0] + s[2] for s, _ in g)
            y0 = min(s[1] for s, _ in g); y1 = max(s[1] + s[3] for s, _ in g)
            pad = int(glyph_h * 0.6)
            crop = img[max(y0 - pad, 0):y1 + pad, max(x0 - pad, 0):x1 + pad]
            # segment_cell trims 12% per side as a ruled border — give it
            # blank paper to trim instead of the value itself.
            h, w = crop.shape[:2]
            crop = cv2.copyMakeBorder(crop, int(h * .16), int(h * .16), int(w * .16), int(w * .16),
                                      cv2.BORDER_CONSTANT, value=(255, 255, 255))
            out.append((crop, t))
    return out


def harvested_cells() -> list[tuple[Path, float, str]]:
    root = BACKEND / "training_data" / "all"
    if not root.exists():
        root = BACKEND / "training_data" / "harvested"
    cells = []
    for p in sorted(root.rglob("*.png")):
        field = p.parent.parent.name
        if not field.startswith("marks_"):
            continue
        cells.append((p, float(p.name.split("_", 1)[0]), field))
    return cells


def _choices(read) -> list:
    # `choices` (every one-tap candidate) supersedes the older single
    # `suggestion`; reading both keeps this harness runnable on either.
    choices = list(getattr(read, "choices", ()) or ())
    if not choices and read.suggestion is not None:
        choices = [read.suggestion]
    return choices


def bucket(read, truth: float) -> str:
    if read.value is not None:
        return "correct" if float(read.value) == truth else "WRONG"
    if any(float(c) == truth for c in _choices(read)):
        return "choices"
    return "blank"


def report(name: str, results: list[tuple[str, float, object, str]], show: bool) -> None:
    for kind in ("half", "whole"):
        sub = [r for r in results if (r[1] % 1 != 0) == (kind == "half")]
        if not sub:
            continue
        c = Counter(r[3] for r in sub)
        n = len(sub)
        print(f"  {name} {kind:5s} n={n:4d}  correct {c['correct']:4d} ({c['correct'] / n:5.1%})"
              f"  choices {c['choices']:3d}  blank {c['blank']:3d}  WRONG {c['WRONG']:2d}")
    if show:
        for label, truth, read, b in results:
            if b != "correct":
                print(f"    {b:7s} {label}: truth {truth:g}, value {read.value}, choices {_choices(read)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true", help="list every read that wasn't simply correct")
    ap.add_argument("--all-crops", action="store_true",
                    help="score page crops the digit-count check would skip (for inspection only)")
    args = ap.parse_args()
    ALL_CROPS[0] = args.all_crops
    rec = CNNRecognizer()

    manifest = PAGES / "values.json"
    if manifest.exists():
        page_results = []
        tmp = Path(tempfile.mkdtemp())
        for entry in json.loads(manifest.read_text(encoding="utf-8"))["pages"]:
            for i, (crop, truth) in enumerate(page_cells(entry)):
                p = tmp / f"{i}.png"
                cv2.imwrite(str(p), crop)
                read = rec._decode_value_cell(p, legal_values(25.0))
                page_results.append((f"{entry['file']}#{i}", truth, read, bucket(read, truth)))
        report("pages    ", page_results, args.show)
        print(f"  pages: {SKIPPED[0]} crops skipped as unreliable splits (see page_cells)")
    else:
        print("  pages: no training_data/pages/values.json — skipped")

    harvested_results = []
    for p, truth, field in harvested_cells():
        legal = legal_values(50.0 if field == "marks_total" else 10.0)
        if truth not in legal:
            continue
        read = rec._decode_value_cell(p, legal)
        harvested_results.append((str(p.relative_to(BACKEND)), truth, read, bucket(read, truth)))
    report("harvested", harvested_results, args.show)


if __name__ == "__main__":
    main()
