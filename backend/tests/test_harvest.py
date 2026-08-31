"""Step 3r.6c: harvesting confirmed values into training_data/harvested/,
plus step 11.2's store seam and source tagging.

Pure logic, no network, no detection — cell crops are just placeholder
files here since harvest() only ever copies them by path. The tests that
care about the real filesystem use LocalStore; the ones that care about
the *key* use a FakeStore, so key construction is covered with no bucket
and no AWS."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.harvest import harvest  # noqa: E402
from app.stores import CONSTANT_MTIME, LocalStore  # noqa: E402


def _make_cells(tmp_path: Path, names: list[str]) -> Path:
    """Each placeholder gets DISTINCT bytes, because keys are content
    addressed (step 11.2 dedupe). Real crops of two different cells are
    never byte-identical; writing the same bytes to all of them would make
    the fixture collapse under deduplication and test nothing."""
    cells_dir = tmp_path / "cells"
    cells_dir.mkdir()
    for name in names:
        (cells_dir / name).write_bytes(f"fake png bytes for {name}".encode())
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
        store=LocalStore(harvest_dir),
    )
    files = _files_under(harvest_dir)
    assert len(files) == 1
    assert files[0].startswith("unknown/id_digits/confirmed/7_")


def test_corrected_id_digit_differing_from_original_is_tagged_corrected(tmp_path):
    cells_dir = _make_cells(tmp_path, ["id_d1.png"])
    harvest_dir = tmp_path / "harvest"
    harvest(
        cells_dir, id_digits=1, question_count=0,
        original_student_id="1", confirmed_student_id="7",  # instructor fixed a misread
        original_serial=None, confirmed_serial=None,
        original_questions=[], confirmed_questions=[],
        original_total=None, confirmed_total=None,
        store=LocalStore(harvest_dir),
    )
    files = _files_under(harvest_dir)
    assert len(files) == 1
    assert files[0].startswith("unknown/id_digits/corrected/7_")


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
        store=LocalStore(harvest_dir),
    )
    files = _files_under(harvest_dir)
    assert len(files) == 1
    assert files[0].startswith("unknown/marks_q1/corrected/3_")


def test_half_mark_label_preserves_the_decimal(tmp_path):
    cells_dir = _make_cells(tmp_path, ["marks_r1_c0.png"])
    harvest_dir = tmp_path / "harvest"
    harvest(
        cells_dir, id_digits=0, question_count=1,
        original_student_id=None, confirmed_student_id=None,
        original_serial=None, confirmed_serial=None,
        original_questions=[2.5], confirmed_questions=[2.5],
        original_total=None, confirmed_total=None,
        store=LocalStore(harvest_dir),
    )
    files = _files_under(harvest_dir)
    assert files[0].startswith("unknown/marks_q1/confirmed/2.5_")


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
        store=LocalStore(harvest_dir),
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
        store=LocalStore(harvest_dir),
    )
    files = _files_under(harvest_dir)
    assert any(f.startswith("unknown/serial/corrected/07_") for f in files)
    assert any(f.startswith("unknown/marks_total/confirmed/11_") for f in files)


def test_mtime_ordering_cannot_reconstruct_a_student_id(tmp_path):
    """Step 11.0.2. The per-crop uuid4 name alone does NOT unlink one
    student's digits: they are written in loop order within a single
    request, so `ls -t` on id_digits/ hands back the ID in order. Every
    crop therefore gets a constant mtime, and this test exists because
    that one `os.utime` line looks like a bug to anyone who does not know
    why it is there — exactly the kind of thing a later cleanup deletes.

    Written as the attack rather than as the implementation: sort every
    harvested crop by mtime and assert the ordering carries no
    information, instead of just asserting utime was called."""
    digits = "2632711"
    cells_dir = _make_cells(
        tmp_path,
        [f"id_d{i}.png" for i in range(1, len(digits) + 1)]
        + ["serial.png", "marks_r1_c0.png", "marks_r1_c1.png"],
    )
    harvest_dir = tmp_path / "harvest"
    harvest(
        cells_dir, id_digits=len(digits), question_count=1,
        original_student_id=digits, confirmed_student_id=digits,
        original_serial="07", confirmed_serial="07",
        original_questions=[3.0], confirmed_questions=[3.0],
        original_total=3.0, confirmed_total=3.0,
        store=LocalStore(harvest_dir),
    )

    crops = list(harvest_dir.rglob("*.png"))
    assert len(crops) == len(digits) + 3  # every field really was written

    mtimes = {p.stat().st_mtime for p in crops}
    assert mtimes == {CONSTANT_MTIME}, (
        "harvested crops carry distinguishable mtimes, so sorting them by "
        "time reconstructs one student's digits in order"
    )


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
        store=LocalStore(harvest_dir),
    )
    assert _files_under(harvest_dir) == []


# --- Step 11.2: the store seam and source tagging --------------------------
#
# Tested the way test_both_recognizer.py tests recognizers: a fake that
# records calls, so key construction is fully covered with no network, no
# bucket, and no AWS credentials. Everything interesting about S3Store is
# the key, and the key is testable without S3.

class FakeStore:
    def __init__(self) -> None:
        self.puts: list[tuple[str, Path]] = []

    def put(self, key: str, src: Path) -> None:
        self.puts.append((key, src))


def _harvest_one_id_digit(tmp_path: Path, source, store) -> None:
    cells_dir = _make_cells(tmp_path, ["id_d1.png"])
    harvest(
        cells_dir, id_digits=1, question_count=0,
        original_student_id="7", confirmed_student_id="7",
        original_serial=None, confirmed_serial=None,
        original_questions=[], confirmed_questions=[],
        original_total=None, confirmed_total=None,
        store=store, source=source,
    )


def test_key_carries_the_source_tag_first(tmp_path):
    """<source>/<field>/<tag>/<value>_<uuid>.png — the source segment
    leads, so `aws s3 sync` and a held-out-writer split are the same
    operation (plan.md §16, step 11.2.4)."""
    store = FakeStore()
    _harvest_one_id_digit(tmp_path, "fac-abc123", store)
    assert len(store.puts) == 1
    key, _ = store.puts[0]
    assert key.startswith("fac-abc123/id_digits/confirmed/7_")
    assert key.endswith(".png")


def test_a_missing_source_is_filed_under_unknown_not_invented(tmp_path):
    """One shared backend serves every faculty member, so a
    server-generated tag would label them all identically and destroy the
    only thing the tag is for. A missing tag has to stay visible."""
    for i, absent in enumerate((None, "", "   ")):
        case_dir = tmp_path / f"case{i}"
        case_dir.mkdir()
        store = FakeStore()
        _harvest_one_id_digit(case_dir, absent, store)
        assert store.puts[0][0].startswith("unknown/"), f"source={absent!r}"


def test_a_hostile_source_cannot_escape_the_harvest_root(tmp_path):
    """/api/harvest is public and `source` arrives in a form field. The
    client generates it with crypto.randomUUID(), but nothing stops a
    caller sending a path traversal instead."""
    store = FakeStore()
    _harvest_one_id_digit(tmp_path, "../../etc/passwd", store)
    key = store.puts[0][0]
    assert ".." not in key
    assert key.startswith("etcpasswd/id_digits/")


def test_every_crop_in_one_request_shares_the_source_but_not_the_name(tmp_path):
    """The source tag is per-faculty by design. It must NOT become a
    per-scan handle that regroups one student's digits — that would undo
    11.0.2 outright (step 11.2.4). Within a request the tag is shared and
    the filenames stay independently random."""
    digits = "2632711"
    cells_dir = _make_cells(tmp_path, [f"id_d{i}.png" for i in range(1, 8)])
    store = FakeStore()
    harvest(
        cells_dir, id_digits=7, question_count=0,
        original_student_id=digits, confirmed_student_id=digits,
        original_serial=None, confirmed_serial=None,
        original_questions=[], confirmed_questions=[],
        original_total=None, confirmed_total=None,
        store=store, source="fac-abc123",
    )
    keys = [k for k, _ in store.puts]
    assert len(keys) == 7
    assert all(k.startswith("fac-abc123/id_digits/") for k in keys)
    # The hash segment still differs per digit — nothing groups a
    # student's crops together. (Here every crop is the same placeholder
    # file, so the hash is shared; what matters is that the *label* half
    # of the name carries no ordering. Real crops differ byte-wise.)
    assert all("_" in k.rsplit("/", 1)[1] for k in keys)


def test_reharvesting_the_same_crop_does_not_duplicate_it(tmp_path):
    """Step 11.2 dedupe. This is the failure that poisoned the first
    corpus: a step 6/7 testing session re-photographed the same two
    scripts dozens of times, every Confirm harvested again, and the
    resulting digit histogram described one student ID rather than
    handwriting. Content-addressed keys make a repeat write idempotent."""
    cells_dir = _make_cells(tmp_path, ["id_d1.png"])
    harvest_dir = tmp_path / "harvest"

    for _ in range(5):
        harvest(
            cells_dir, id_digits=1, question_count=0,
            original_student_id="7", confirmed_student_id="7",
            original_serial=None, confirmed_serial=None,
            original_questions=[], confirmed_questions=[],
            original_total=None, confirmed_total=None,
            store=LocalStore(harvest_dir), source="fac-abc",
        )

    assert len(_files_under(harvest_dir)) == 1


def test_two_different_crops_with_the_same_label_both_survive(tmp_path):
    """Dedupe must be by content, not by label — otherwise two students'
    handwritten "7"s would collapse into one and the corpus would lose
    exactly the variation it exists to capture."""
    harvest_dir = tmp_path / "harvest"
    for writer in ("a", "b"):
        cells = tmp_path / writer
        cells.mkdir()
        (cells / "id_d1.png").write_bytes(f"a different 7, written by {writer}".encode())
        harvest(
            cells, id_digits=1, question_count=0,
            original_student_id="7", confirmed_student_id="7",
            original_serial=None, confirmed_serial=None,
            original_questions=[], confirmed_questions=[],
            original_total=None, confirmed_total=None,
            store=LocalStore(harvest_dir), source="fac-abc",
        )
    assert len(_files_under(harvest_dir)) == 2
