"""detection._repair_columns — fixing a table whose column count is off by
one, only when the evidence leaves no doubt. Most of these tests are the
refusals: a repair that guesses would turn an honest column_count_mismatch
into a confident misread, which is the one thing detection must never do.

Synthetic warped tables, drawn directly: the real-photo case
(real_class_11) is covered by test_detection_regression through labels.json.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.detection import TableCandidate, _repair_columns  # noqa: E402

H = 80


def _table(xs: list[int], drawn: list[int] | None = None) -> TableCandidate:
    """A single-row table whose printed dividers sit at `drawn` (default:
    all of `xs`), while detection only reported `xs` as its bounds."""
    drawn = xs if drawn is None else drawn
    w = max(max(xs), max(drawn)) + 1
    gray = np.full((H, w), 230, dtype=np.uint8)
    mask = np.zeros((H, w), dtype=np.uint8)
    for x in drawn:
        gray[:, max(x - 1, 0):x + 2] = 40
        mask[:, max(x - 1, 0):x + 2] = 255
    return TableCandidate(
        quad=np.zeros((4, 2), dtype="float32"),
        warped=np.dstack([gray] * 3),
        row_bounds=[0, H - 1],
        col_bounds=list(xs),
        v_mask=mask,
        gray=gray,
    )


# Label cell 150px, then 7 digit boxes of 100px: 8 columns.
ID_BOUNDS = [0, 150, 250, 350, 450, 550, 650, 750, 850]


def test_restores_a_real_divider_the_filters_dropped():
    cand = _table([b for b in ID_BOUNDS if b != 450], drawn=ID_BOUNDS)
    assert _repair_columns(cand, expected_cols=8, table="id") == "restored_divider"
    assert cand.col_bounds == ID_BOUNDS


def test_never_invents_a_divider_the_image_does_not_show():
    """Same geometry, but nothing is printed where the gap is: dividing the
    wide cell in two would be placing a line by arithmetic."""
    missing = [b for b in ID_BOUNDS if b != 450]
    cand = _table(missing, drawn=missing)
    assert _repair_columns(cand, expected_cols=8, table="id") is None
    assert cand.col_bounds == missing


def test_a_paper_with_fewer_boxes_than_the_config_is_not_repaired():
    """A 6-digit paper under a 7-digit config: every box is regular already,
    so no restored line can produce an even grid — it must stay a mismatch."""
    six = [0, 150, 250, 350, 450, 550, 650, 750]
    cand = _table(six)
    assert _repair_columns(cand, expected_cols=8, table="id") is None


def test_restores_the_label_divider_when_both_halves_are_one_box_wide():
    """real_class_11's actual shape: the missing divider is the one between
    the label and the first digit, so the merged cell includes the label."""
    even = [0, 100, 200, 300, 400, 500, 600, 700, 800]
    cand = _table([b for b in even if b != 100], drawn=even)
    assert _repair_columns(cand, expected_cols=8, table="id") == "restored_divider"
    assert cand.col_bounds == even


def test_a_stroke_inside_the_label_is_not_restored_as_a_divider():
    """A 6-digit paper under a 7-digit config, with a vertical stroke in its
    150px label cell: restoring it would make the digit boxes look complete
    while reading a letter as digit one. The label half comes out 75px
    against a 100px box, so it is refused."""
    six = [0, 150, 250, 350, 450, 550, 650, 750]
    cand = _table(six, drawn=sorted(six + [75]))
    assert _repair_columns(cand, expected_cols=8, table="id") is None


def test_removes_a_stroke_that_was_taken_for_a_divider():
    extra = sorted(ID_BOUNDS + [500])  # a "1" down the middle of box 4
    cand = _table(extra)
    assert _repair_columns(cand, expected_cols=8, table="id") == "removed_divider"
    assert cand.col_bounds == ID_BOUNDS


def test_a_paper_with_more_boxes_than_the_config_is_not_repaired():
    """Found while writing this: removing the label/first-digit divider
    leaves the digit boxes perfectly even, since the label is outside that
    check — which would read the first digit as part of the label and every
    other digit one box off. Both cells beside a removed divider must be
    narrow."""
    eight_digits = ID_BOUNDS + [950]
    cand = _table(eight_digits)
    assert _repair_columns(cand, expected_cols=8, table="id") is None


def test_marks_never_has_a_divider_removed():
    """Total is irregular by design and handwriting is the likeliest false
    divider, so the marks table only ever gets a line restored."""
    marks = [0, 100, 200, 300, 350, 400, 550]  # Q1-Q3, a split Q4, Total
    cand = _table(marks)
    assert _repair_columns(cand, expected_cols=5, table="marks") is None


def test_marks_restore_ignores_a_wider_total_column():
    full = [0, 100, 200, 300, 400, 550]  # four questions + a 150px Total
    cand = _table([b for b in full if b != 200], drawn=full)
    assert _repair_columns(cand, expected_cols=5, table="marks") == "restored_divider"
    assert cand.col_bounds == full


def test_serial_is_never_repaired():
    cand = _table([0, 150], drawn=[0, 150, 300])
    assert _repair_columns(cand, expected_cols=2, table="serial") is None


def test_off_by_two_is_not_repaired():
    missing_two = [b for b in ID_BOUNDS if b not in (350, 650)]
    cand = _table(missing_two, drawn=ID_BOUNDS)
    assert _repair_columns(cand, expected_cols=8, table="id") is None
