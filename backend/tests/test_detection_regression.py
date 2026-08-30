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

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.detection import detect  # noqa: E402

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
