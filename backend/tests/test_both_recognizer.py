"""Step 3r.6d: BothRecognizer's disagreement-detection and logging logic.
Fake sub-recognizers only — RemoteRecognizer calls real Gemini and
CNNRecognizer needs a real trained model, neither of which belongs in
this offline suite. This tests the actual new code the step adds: what
counts as a disagreement, and that it gets logged with both values."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.marks import MarksResult  # noqa: E402
from app.recognizers import both as both_module  # noqa: E402
from app.recognizers.base import IdResult  # noqa: E402
from app.recognizers.both import BothRecognizer  # noqa: E402


class FakeRecognizer:
    def __init__(self, id_result: IdResult, marks_result: MarksResult):
        self._id_result = id_result
        self._marks_result = marks_result

    def read_id(self, cells_dir, id_digits):
        return self._id_result

    def read_marks(self, cells_dir, question_maxes):
        return self._marks_result


def _redirect_log(monkeypatch, tmp_path):
    log_dir = tmp_path / "comparison_log"
    monkeypatch.setattr(both_module, "COMPARISON_LOG_DIR", log_dir)
    monkeypatch.setattr(both_module, "COMPARISON_LOG_FILE", log_dir / "comparisons.jsonl")
    return log_dir / "comparisons.jsonl"


def _read_log(log_file: Path) -> list[dict]:
    if not log_file.exists():
        return []
    return [json.loads(line) for line in log_file.read_text().splitlines()]


def test_read_id_returns_the_cnn_result(monkeypatch, tmp_path):
    _redirect_log(monkeypatch, tmp_path)
    cnn = FakeRecognizer(IdResult(student_id="1234567", low_confidence_fields=[]), MarksResult(status="ok"))
    remote = FakeRecognizer(IdResult(student_id="1234567", low_confidence_fields=[]), MarksResult(status="ok"))
    recognizer = BothRecognizer(cnn=cnn, remote=remote)

    result = recognizer.read_id(Path("."), 7)
    assert result.student_id == "1234567"


def test_agreeing_ids_log_nothing(monkeypatch, tmp_path):
    log_file = _redirect_log(monkeypatch, tmp_path)
    cnn = FakeRecognizer(IdResult(student_id="1234567"), MarksResult(status="ok"))
    remote = FakeRecognizer(IdResult(student_id="1234567"), MarksResult(status="ok"))
    BothRecognizer(cnn=cnn, remote=remote).read_id(Path("."), 7)

    assert _read_log(log_file) == []


def test_disagreeing_id_logs_both_values(monkeypatch, tmp_path):
    log_file = _redirect_log(monkeypatch, tmp_path)
    cnn = FakeRecognizer(IdResult(student_id="1234567"), MarksResult(status="ok"))
    remote = FakeRecognizer(IdResult(student_id="1234561"), MarksResult(status="ok"))
    BothRecognizer(cnn=cnn, remote=remote).read_id(Path("."), 7)

    entries = _read_log(log_file)
    assert len(entries) == 1
    assert entries[0]["field"] == "student_id"
    assert entries[0]["cnn"] == "1234567"
    assert entries[0]["remote"] == "1234561"


def test_read_marks_returns_the_cnn_result(monkeypatch, tmp_path):
    _redirect_log(monkeypatch, tmp_path)
    cnn_marks = MarksResult(status="ok", serial="07", questions=[4.0, 3.0], total=7.0)
    remote_marks = MarksResult(status="ok", serial="07", questions=[4.0, 3.0], total=7.0)
    recognizer = BothRecognizer(
        cnn=FakeRecognizer(IdResult(student_id=""), cnn_marks),
        remote=FakeRecognizer(IdResult(student_id=""), remote_marks),
    )

    result = recognizer.read_marks(Path("."), [5.0, 5.0])
    assert result is cnn_marks


def test_disagreeing_marks_fields_each_log_separately(monkeypatch, tmp_path):
    log_file = _redirect_log(monkeypatch, tmp_path)
    cnn_marks = MarksResult(status="ok", serial="07", questions=[4.0, 3.0], total=7.5)
    remote_marks = MarksResult(status="ok", serial="7", questions=[4.0, 4.0], total=7.5)
    recognizer = BothRecognizer(
        cnn=FakeRecognizer(IdResult(student_id=""), cnn_marks),
        remote=FakeRecognizer(IdResult(student_id=""), remote_marks),
    )

    recognizer.read_marks(Path("."), [5.0, 5.0])

    entries = _read_log(log_file)
    fields = {e["field"]: (e["cnn"], e["remote"]) for e in entries}
    assert fields == {
        "serial": ("07", "7"),
        "q2": (3.0, 4.0),
    }
    assert "q1" not in fields  # agreed — nothing logged
    assert "total" not in fields  # agreed — nothing logged


def test_a_failed_remote_read_logs_nothing_and_still_returns_cnn_result(monkeypatch, tmp_path):
    """If the remote path itself failed (rate_limited/model_error),
    there's no remote value to compare against — nothing to log, and the
    CNN's result is simply what gets returned, same as RECOGNIZER=cnn
    alone would produce."""
    log_file = _redirect_log(monkeypatch, tmp_path)
    cnn_marks = MarksResult(status="ok", serial="07", questions=[4.0], total=4.0)
    remote_marks = MarksResult(status="failed", failure_reason="rate_limited")
    recognizer = BothRecognizer(
        cnn=FakeRecognizer(IdResult(student_id=""), cnn_marks),
        remote=FakeRecognizer(IdResult(student_id=""), remote_marks),
    )

    result = recognizer.read_marks(Path("."), [5.0])

    assert result is cnn_marks
    assert _read_log(log_file) == []
