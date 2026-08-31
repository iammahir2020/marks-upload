"""Structured logging for CloudWatch (step 11.6/11.7).

One JSON object per line on stdout. Lambda captures stdout into the
function's log group with no agent, no dependency and no configuration, so
this works identically on a laptop and in production — and CloudWatch Logs
Insights can query the fields directly because they are real JSON rather
than a formatted sentence.

**The design constraint is privacy, not convenience.** Step 11.7.3 requires
that no recognised student ID and no image bytes reach CloudWatch, and
logging is the easiest possible way to break that: one `logger.info(result)`
during a debugging session and every scan's student ID is sitting in a log
group for the next 30 days. Application logs also outlive the request that
made them, which is exactly what the rest of this backend is built to avoid.

So the safety is structural rather than a rule to remember:

1. **A key denylist.** Field names that carry values rather than facts
   (`student_id`, `serial`, `total`, `marks`, ...) are dropped before
   serialisation, whatever is passed.
2. **A value scrubber.** Any run of 4+ digits inside a string is redacted,
   because a student ID is 7 digits and would otherwise sneak through
   inside a message, a path, or an exception string.
3. **A test that reads the actual emitted output** of a real scan and
   asserts the known student ID does not appear anywhere in it.

What IS logged is deliberately facts about the request rather than its
content: status, failure reason, stage timings, how many fields were
flagged and *which field names* — never what was read.
"""
from __future__ import annotations

import json
import re
import sys
import time
from contextlib import contextmanager
from typing import Any, Iterator

# Field names that would carry recognised content rather than a fact about
# the request. Dropped no matter what is passed, so a future call site
# cannot leak by accident.
DENIED_KEYS = frozenset({
    "student_id", "studentid", "serial", "total", "marks", "questions_values",
    "value", "values", "image", "image_bytes", "body", "crop", "crops_content",
    "original", "confirmed", "source", "source_id",
})

# A student ID is 7 digits; a serial is 1-2. Redacting 4+ catches the
# identifying case while leaving timings, sizes and counts readable.
_LONG_DIGITS = re.compile(r"\d{4,}")

REDACTED = "[redacted]"


def _scrub(value: Any) -> Any:
    if isinstance(value, str):
        return _LONG_DIGITS.sub(REDACTED, value)
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items() if k.lower() not in DENIED_KEYS}
    if isinstance(value, (list, tuple)):
        return [_scrub(v) for v in value]
    return value


def log_event(event: str, **fields: Any) -> None:
    """Emit one JSON line. Never raises: observability must not be able to
    fail a scan, so a serialisation problem is swallowed rather than
    propagated into the request path."""
    try:
        payload: dict[str, Any] = {"event": event}
        for key, raw in fields.items():
            if key.lower() in DENIED_KEYS:
                continue
            payload[key] = _scrub(raw)
        print(json.dumps(payload, separators=(",", ":"), default=str), flush=True)
    except Exception:  # noqa: BLE001 - see docstring
        pass


@contextmanager
def timed(into: dict[str, int], key: str) -> Iterator[None]:
    """Records elapsed milliseconds for one pipeline stage.

    Stage timings are the thing worth having in production: "scans are
    slow" is unactionable, but "detection is 2.1 s and recognition is
    0.2 s" points straight at the cause.
    """
    start = time.perf_counter()
    try:
        yield
    finally:
        into[key] = int((time.perf_counter() - start) * 1000)
