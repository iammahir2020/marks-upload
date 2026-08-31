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


# The one field whose VALUE is never written here. Serial and marks are a
# different matter and are logged in full: they identify nobody without the
# instructor's own attendance sheet, and on this path they have already been
# sent to Gemini anyway (plan.md §12 draws exactly this line).
ID_FIELD = "student_id"


def _id_difference(cnn_value: str | None, remote_value: str | None) -> dict[str, Any]:
    """Where two ID reads differ, never what either of them read.

    A comparison run wants to know *that* the recognizers disagreed and
    *where* — which position, how often, whether it clusters. None of that
    needs the digits, and the digits are the whole student ID.
    """
    a, b = cnn_value or "", remote_value or ""
    positions = [i for i in range(max(len(a), len(b))) if a[i:i + 1] != b[i:i + 1]]
    return {
        "differing_positions": positions,
        "differing_count": len(positions),
        "len_cnn": len(a),
        "len_remote": len(b),
    }


def _log_disagreement(field: str, cnn_value: Any, remote_value: Any) -> None:
    """Appends one line — the backend is otherwise stateless, and this log
    is a deliberate, local-only exception for a comparison run (plan.md
    §16).

    **The student ID is recorded as a difference, not as a value**
    (issues.md N9). This function used to write both recognizers' full IDs
    verbatim, one line per scan, in scan order, with timestamps — which is
    the exact thing `harvest.py` (shuffled writes, content-addressed keys),
    `stores.py` (CONSTANT_MTIME) and `observability.py` (key denylist plus
    4-digit redaction) all exist to prevent. It was gitignored and
    local-only, but the comparison run this file exists for is meant to
    happen *during a real class*, which is when it matters most.

    Never raises. The log is a research aid; it must not be able to fail a
    scan, and `COMPARISON_LOG_DIR` is repo-relative, so on a read-only
    filesystem (Lambda, one env var away) the write would otherwise take
    the whole request down with it.

    An earlier version of this docstring cited debug_uploads/ as precedent
    for "a deliberate exception to statelessness". That is a bad precedent:
    debug_uploads/ was deleted in step 11.0.1 as a privacy defect, not
    retired as a success.
    """
    entry: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "field": field,
    }
    if field == ID_FIELD:
        entry["difference"] = _id_difference(cnn_value, remote_value)
    else:
        entry["cnn"] = cnn_value
        entry["remote"] = remote_value

    try:
        COMPARISON_LOG_DIR.mkdir(exist_ok=True)
        with open(COMPARISON_LOG_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


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
