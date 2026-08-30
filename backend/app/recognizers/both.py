"""BothRecognizer (step.md step 3r.6d): runs the remote and CNN paths
together, returns the CNN's result (plan.md §16: "RECOGNIZER=both runs
both paths and returns the CNN's result"), and logs every field where
they disagree to `comparison_log/` — a self-selecting set of hard cases,
each with both recognizers' answers attached, worth more than an
aggregate accuracy number off a thin labelled set once the instructor's
own review resolves each one.

`cnn`/`remote` are constructor parameters, not hardwired instances,
specifically so the disagreement-detection and logging logic (the actual
new code this step adds) can be unit-tested against fake recognizers —
`RemoteRecognizer` calls the real Gemini API and `CNNRecognizer` needs a
real trained model, neither of which belongs in the offline test suite.
For the same reason `CNNRecognizer`/`RemoteRecognizer` are imported
lazily inside `__init__`, not at module level: importing this module at
all (as the test suite does, to test the logging logic against fakes)
must not require onnxruntime installed just to construct that import,
the same "no CNN dependency in the default path" property `main.py`'s own
lazy imports preserve.

Not for normal use once a comparison run is done (plan.md §16): this
costs the same Gemini quota the remote path alone costs, for no accuracy
benefit — its only job is producing the evidence step 3r.6's own
Done-when bar asks for.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..marks import MarksResult
from .base import IdResult, Recognizer

COMPARISON_LOG_DIR = Path(__file__).resolve().parent.parent.parent.parent / "comparison_log"
COMPARISON_LOG_FILE = COMPARISON_LOG_DIR / "comparisons.jsonl"


def _log_disagreement(field: str, cnn_value: Any, remote_value: Any) -> None:
    """Appends one line — the backend is otherwise stateless, but this
    log is the one deliberate, permanent exception (plan.md §16), the
    same way debug_uploads/ was a deliberate temporary one for step 6."""
    COMPARISON_LOG_DIR.mkdir(exist_ok=True)
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "field": field,
        "cnn": cnn_value,
        "remote": remote_value,
    }
    with open(COMPARISON_LOG_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


class BothRecognizer:
    name = "both"

    def __init__(self, cnn: Recognizer | None = None, remote: Recognizer | None = None) -> None:
        if cnn is None:
            from .local import CNNRecognizer

            cnn = CNNRecognizer()
        if remote is None:
            from .remote import RemoteRecognizer

            remote = RemoteRecognizer()
        self._cnn = cnn
        self._remote = remote

    def read_id(self, cells_dir: Path, id_digits: int) -> IdResult:
        cnn_result = self._cnn.read_id(cells_dir, id_digits)
        remote_result = self._remote.read_id(cells_dir, id_digits)
        if cnn_result.student_id != remote_result.student_id:
            _log_disagreement("student_id", cnn_result.student_id, remote_result.student_id)
        return cnn_result

    def read_marks(self, cells_dir: Path, question_maxes: list[float]) -> MarksResult:
        cnn_result = self._cnn.read_marks(cells_dir, question_maxes)
        remote_result = self._remote.read_marks(cells_dir, question_maxes)

        # If the remote path itself failed (rate_limited/model_error),
        # there is no remote value to compare against — nothing to log,
        # and the CNN's own result is simply what gets returned, same as
        # RECOGNIZER=cnn alone would produce.
        if remote_result.status == "ok":
            if cnn_result.serial != remote_result.serial:
                _log_disagreement("serial", cnn_result.serial, remote_result.serial)

            for i, (cnn_q, remote_q) in enumerate(
                zip(cnn_result.questions, remote_result.questions), start=1
            ):
                if cnn_q != remote_q:
                    _log_disagreement(f"q{i}", cnn_q, remote_q)

            if cnn_result.total != remote_result.total:
                _log_disagreement("total", cnn_result.total, remote_result.total)

        return cnn_result
