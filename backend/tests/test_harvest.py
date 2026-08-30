"""Step 3r.6c: harvesting confirmed values into training_data/harvested/.
Pure filesystem logic, no network, no detection — cell crops are just
placeholder files here since harvest() only ever copies them by path."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.harvest import harvest  # noqa: E402


def _make_cells(tmp_path: Path, names: list[str]) -> Path:
    cells_dir = tmp_path / "cells"
    cells_dir.mkdir()
    for name in names:
        (cells_dir / name).write_bytes(b"fake png bytes")
    return cells_dir


def _files_under(harvest_dir: Path) -> list[str]:
    return sorted(str(p.relative_to(harvest_dir)) for p in harvest_dir.rglob("*.png"))


def test_confirmed_id_digit_matching_original_is_tagged_confirmed(tmp_path):
    cells_dir = _make_cells(tmp_path, ["id_d1.png"])
    harvest_dir = tmp_path / "harvest"
    harvest(
        cells_dir, id_digits=1, question_count=0,
        original_student_id="7", confirmed_student_id="7",
        original_serial=None, confirmed_serial=None,
        original_questions=[], confirmed_questions=[],
        original_total=None, confirmed_total=None,
        harvest_dir=harvest_dir,
    )
    files = _files_under(harvest_dir)
    assert len(files) == 1
    assert files[0].startswith("id_digits/confirmed/7_")


def test_corrected_id_digit_differing_from_original_is_tagged_corrected(tmp_path):
    cells_dir = _make_cells(tmp_path, ["id_d1.png"])
    harvest_dir = tmp_path / "harvest"
    harvest(
        cells_dir, id_digits=1, question_count=0,
        original_student_id="1", confirmed_student_id="7",  # instructor fixed a misread
        original_serial=None, confirmed_serial=None,
        original_questions=[], confirmed_questions=[],
        original_total=None, confirmed_total=None,
        harvest_dir=harvest_dir,
    )
    files = _files_under(harvest_dir)
    assert len(files) == 1
    assert files[0].startswith("id_digits/corrected/7_")


def test_a_flagged_original_that_gets_filled_in_counts_as_corrected(tmp_path):
    """The model failed to produce a usable answer here (None), same as
    if it had produced a wrong one — both are the model's real failures,
    worth oversampling."""
    cells_dir = _make_cells(tmp_path, ["marks_r1_c0.png"])
    harvest_dir = tmp_path / "harvest"
    harvest(
        cells_dir, id_digits=0, question_count=1,
        original_student_id=None, confirmed_student_id=None,
        original_serial=None, confirmed_serial=None,
        original_questions=[None], confirmed_questions=[3.0],
        original_total=None, confirmed_total=None,
        harvest_dir=harvest_dir,
    )
    files = _files_under(harvest_dir)
    assert len(files) == 1
    assert files[0].startswith("marks_q1/corrected/3_")


def test_half_mark_label_preserves_the_decimal(tmp_path):
    cells_dir = _make_cells(tmp_path, ["marks_r1_c0.png"])
    harvest_dir = tmp_path / "harvest"
    harvest(
        cells_dir, id_digits=0, question_count=1,
        original_student_id=None, confirmed_student_id=None,
        original_serial=None, confirmed_serial=None,
        original_questions=[2.5], confirmed_questions=[2.5],
        original_total=None, confirmed_total=None,
        harvest_dir=harvest_dir,
    )
    files = _files_under(harvest_dir)
    assert files[0].startswith("marks_q1/confirmed/2.5_")


def test_a_blank_confirmed_question_is_not_harvested_at_all(tmp_path):
    """A None confirmed value means it stayed blank on the review screen
    — that isn't a label of anything, not something to save."""
    cells_dir = _make_cells(tmp_path, ["marks_r1_c0.png"])
    harvest_dir = tmp_path / "harvest"
    harvest(
        cells_dir, id_digits=0, question_count=1,
        original_student_id=None, confirmed_student_id=None,
        original_serial=None, confirmed_serial=None,
        original_questions=[None], confirmed_questions=[None],
        original_total=None, confirmed_total=None,
        harvest_dir=harvest_dir,
    )
    assert _files_under(harvest_dir) == []


def test_serial_and_total_are_harvested_too(tmp_path):
    cells_dir = _make_cells(tmp_path, ["serial.png", "marks_r1_c1.png"])
    harvest_dir = tmp_path / "harvest"
    harvest(
        cells_dir, id_digits=0, question_count=1,
        original_student_id=None, confirmed_student_id=None,
        original_serial="7", confirmed_serial="07",  # a leading-zero correction
        original_questions=[None], confirmed_questions=[None],
        original_total=11.0, confirmed_total=11.0,
        harvest_dir=harvest_dir,
    )
    files = _files_under(harvest_dir)
    assert any(f.startswith("serial/corrected/07_") for f in files)
    assert any(f.startswith("marks_total/confirmed/11_") for f in files)


def test_a_missing_crop_file_is_silently_skipped(tmp_path):
    """cells_dir exists but the specific crop doesn't (e.g. detection
    partially failed) — harvest() must not raise."""
    cells_dir = tmp_path / "cells"
    cells_dir.mkdir()
    harvest_dir = tmp_path / "harvest"
    harvest(
        cells_dir, id_digits=1, question_count=0,
        original_student_id=None, confirmed_student_id="7",
        original_serial=None, confirmed_serial=None,
        original_questions=[], confirmed_questions=[],
        original_total=None, confirmed_total=None,
        harvest_dir=harvest_dir,
    )
    assert _files_under(harvest_dir) == []
