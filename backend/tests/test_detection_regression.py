"""Step 1.9: regression test comparing detect.py's output against
testset/labels.json. Re-run after every detection parameter change — a fix
for one photo can silently break another (step.md working protocol).

Collects zero cases until testset/images/ + testset/labels.json hold real
labelled photographs (step.md step 0). That's expected, not a failure: this
suite is the harness for the real photographic test set, not a substitute
for it.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.detection import detect, detect_any_orientation  # noqa: E402

TESTSET = Path(__file__).parent.parent.parent / "testset"
ID_DIGITS = 7  # fixed app-wide config so far — every real photo used the same value


def _load_cases():
    labels_path = TESTSET / "labels.json"
    if not labels_path.exists():
        return []
    data = json.loads(labels_path.read_text())
    cases = []
    for name, label in data.get("images", {}).items():
        if name.startswith("_"):
            continue
        image_path = TESTSET / "images" / name
        if image_path.exists():
            cases.append((name, label))
    return cases


CASES = _load_cases()


@pytest.mark.parametrize("name,label", CASES, ids=[c[0] for c in CASES])
def test_detection_matches_label(tmp_path, name, label):
    image_path = TESTSET / "images" / name
    # Real per-image count, not a fixed constant — every real photo so far
    # happened to use 5, but the synthetic set genuinely varies (3-8), and
    # labels.json already carries the real number via len(questions).
    questions = len(label["questions"]) if label["questions"] else 5
    result = detect(image_path, questions, ID_DIGITS, tmp_path)

    expected_success = label["expected_success"]
    if expected_success:
        assert result["status"] == "ok", f"{name}: expected ok, got {result['failure_reason']}"
    else:
        assert result["status"] == "failed"
        expected_reason = label.get("expected_failure_reason")
        if expected_reason:
            assert result["failure_reason"] == expected_reason, (
                f"{name}: expected failure_reason={expected_reason}, got {result['failure_reason']}"
            )


def test_testset_not_empty_reminder():
    if not CASES:
        pytest.skip(
            "testset/images/ has no labelled photographs yet — step 0 (step.md) "
            "comes before step 1's Done-when bar can be met. See CLAUDE.md."
        )


# --- issues.md #15: artifacts must describe the answer that was returned --


def test_a_total_failure_leaves_the_zero_degree_artifacts(tmp_path):
    """All four rotations used to share one out_dir, so after a run where
    every orientation failed, overlay.jpg and result.json described the
    270-degree attempt while the RETURNED failure_reason was the 0-degree
    one. The artifact and the answer disagreed, silently, in exactly the
    situation you open the artifact to understand."""
    noise = tmp_path / "noise.jpg"
    rng = np.random.default_rng(0)
    cv2.imwrite(str(noise), rng.integers(0, 255, (600, 800, 3), dtype=np.uint8))

    out = tmp_path / "out"
    result = detect_any_orientation(noise, 5, 7, out)

    assert result["status"] == "failed"
    on_disk = json.loads((out / "result.json").read_text())
    assert on_disk["failure_reason"] == result["failure_reason"]
    assert on_disk["image"] == result["image"]
    # and no scratch directory survives
    assert not (out / "_attempt").exists()
    assert not (out / "_rotation_attempt.jpg").exists()


def test_a_winning_rotation_puts_its_cells_where_callers_look(tmp_path):
    """main.py reads out_dir/"cells" and cannot tell which orientation won,
    so a promoted attempt has to land exactly where a first-try success
    would have."""
    upright = TESTSET / "images" / "filled_file.jpeg"
    if not upright.exists():
        pytest.skip("testset image not present")
    rotated = tmp_path / "sideways.jpg"
    cv2.imwrite(str(rotated), cv2.rotate(cv2.imread(str(upright)), cv2.ROTATE_90_CLOCKWISE))

    out = tmp_path / "out"
    result = detect_any_orientation(rotated, 5, 7, out)

    assert result["status"] == "ok"
    assert (out / "cells" / "id_d1.png").exists()
    assert (out / "overlay.jpg").exists()
    # The winning attempt read a temp file that is deleted afterwards; the
    # result must name a path that still exists.
    assert Path(result["image"]).exists()
    assert not (out / "_attempt").exists()
