"""has_ink — the ID path's blank-cell gate (issues.md N4).

Pure image processing, no model: the point is deciding whether a cell holds
a digit at all, before any classifier is asked what the digit is.

Why this gate exists: `_to_canvas` thresholds with THRESH_OTSU, which always
splits the histogram — including a unimodal one. Blank paper therefore
produces "ink", which gets bounding-boxed, scaled and classified like a real
glyph. `segment_cell` guards this for serial and marks; `read_id` did not,
and the ID is the field with no arithmetic check behind it.
"""
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from cnn.preprocess import MIN_GLYPH_AREA_FRAC, has_ink  # noqa: E402

CELL = (60, 45)


def _blank(brightness=205, noise=4, seed=0):
    """Paper: bright, near-uniform, with a little sensor noise."""
    rng = np.random.default_rng(seed)
    base = rng.normal(brightness, noise, CELL).clip(0, 255).astype(np.uint8)
    return cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)


def _with_stroke(thickness=3, brightness=205):
    """A digit-like stroke on that same paper."""
    cell = _blank(brightness)
    cv2.line(cell, (22, 12), (22, 48), (35, 35, 35), thickness)
    return cell


def test_a_blank_cell_has_no_ink():
    assert has_ink(_blank()) is False


@pytest.mark.parametrize("seed", range(6))
def test_blank_paper_stays_blank_across_noise_patterns(seed):
    # Otsu will happily binarize this into something; the gate must not.
    assert has_ink(_blank(seed=seed)) is False


@pytest.mark.parametrize("brightness", [255, 230, 205, 170, 140])
def test_blankness_does_not_depend_on_how_bright_the_paper_is(brightness):
    # Ink is measured against the cell's OWN paper (p90), not a global
    # threshold, because paper brightness varies per photo and per cell.
    assert has_ink(_blank(brightness=brightness)) is False


@pytest.mark.parametrize("brightness", [255, 230, 205, 170, 140])
def test_a_stroke_is_ink_on_paper_of_any_brightness(brightness):
    assert has_ink(_with_stroke(brightness=brightness)) is True


def test_the_thinnest_realistic_stroke_still_counts():
    """The calibration's binding constraint. The four faintest real filled
    cells in the test set were all the digit "1" — a single thin stroke is
    the least ink any digit can have, so this is the case that decides the
    floor."""
    assert has_ink(_with_stroke(thickness=1)) is True


def test_sensor_noise_on_paper_is_not_a_digit():
    """Realistic paper: bright, near-uniform, with per-pixel noise. Over
    every blank ID cell in the test set this measured 0.0 in six cases out
    of seven — noise does not form blobs at 30/255 contrast."""
    for seed in range(10):
        cell = _blank(seed=seed, noise=8)
        assert has_ink(cell) is False


def test_a_deliberate_ink_blob_is_NOT_treated_as_blank():
    """Documenting the boundary honestly rather than overclaiming.

    A drawn speck of a dozen pixels at full ink contrast clears the floor
    and goes to the classifier. That is correct for what this gate is: it
    answers "is this cell empty?", and a cell with ink in it is not empty.
    Whether that ink is a *digit* is the classifier's question, and
    CONFIDENCE_FLOOR/MARGIN_FLOOR are the gate behind this one.

    An earlier version of this test asserted the opposite and failed, which
    is what prompted measuring rather than assuming: every real blank cell
    in the test set scores 0.0 to 0.00041, so blobs like this simply do not
    occur on blank paper — the case was invented, not observed.
    """
    cell = _blank()
    cv2.circle(cell, (30, 30), 2, (30, 30, 30), -1)
    assert has_ink(cell) is True


def test_the_floor_sits_where_the_measurement_put_it():
    # Calibrated against every ID cell in testset/labels.json that detection
    # reads: filled min 0.00163, blank max 0.00041. Recorded here so a
    # change to the constant has to be a deliberate one.
    assert MIN_GLYPH_AREA_FRAC == 0.0015


def test_a_degenerate_crop_is_not_ink():
    assert has_ink(np.zeros((0, 0, 3), np.uint8)) is False


def test_the_app_does_not_import_the_accuracy_harness(monkeypatch):
    """issues.md N16. `local.py` is the DEFAULT recognizer, and it used to
    import `cnn/accuracy.py` — a CLI tuning harness that pulls in argparse,
    tempfile and `app.detection`, and computes a TESTSET path pointing at a
    directory the deployed container does not contain — solely to read two
    floats at Lambda cold-start.

    The harness's own docstring says "Standalone: no `app/recognizers/`
    import here on purpose"; the dependency had quietly run the other way.
    """
    import importlib

    for name in [m for m in list(sys.modules) if m.startswith(("cnn.", "app.recognizers"))]:
        sys.modules.pop(name, None)

    class Block:
        def find_spec(self, name, path=None, target=None):
            if name == "cnn.accuracy":
                raise ImportError("cnn/accuracy.py must not be on the app's import path")

    monkeypatch.setattr(sys, "meta_path", [Block()] + sys.meta_path)
    importlib.import_module("app.recognizers.local")
    assert "cnn.accuracy" not in sys.modules
