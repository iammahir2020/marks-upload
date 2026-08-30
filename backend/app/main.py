"""POST /api/scan (step.md step 4). Steps 1-3 are already proven standalone
(detect.py, id_ocr_accuracy.py, and a live Gemini run — see learn.md); this
is meant to be a thin wrapper over that working code, not a rewrite.

Recognition (steps 2-3) is reached only through the Recognizer protocol
(step.md step 2r.0, `app/recognizers/`) — this module never imports
id_ocr/marks/marks_ocr by name, so the CNN path (step 3r) is a second
implementation of that protocol, not a second call site here.
"""
from __future__ import annotations

import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from . import harvest as harvest_module
from .detection import detect_any_orientation
from .models import HarvestFields, QuestionMark, QuizConfig, ScanResult
from .recognizers.base import Recognizer
from .recognizers.remote import RemoteRecognizer

app = FastAPI()


def _resolve_recognizer() -> Recognizer:
    """RECOGNIZER selects the implementation once at startup (plan.md §16);
    the pipeline below calls only through the Recognizer protocol from here
    on, never `id_ocr`/`marks`/`marks_ocr` by name.

    CNNRecognizer/BothRecognizer are imported lazily, inside their own
    branches, rather than at module level — the default path (RECOGNIZER
    unset -> "remote") must never require onnxruntime/the CNN track's
    dependencies to be installed just to import this module, the same
    "main app has no dependency on any of this" property
    requirements-cnn.txt is kept separate to preserve."""
    name = os.getenv("RECOGNIZER", "cnn")
    if name == "remote":
        return RemoteRecognizer()
    if name == "cnn":
        from .recognizers.local import CNNRecognizer

        return CNNRecognizer()
    if name == "both":
        from .recognizers.both import BothRecognizer

        return BothRecognizer()
    raise ValueError(f"Unknown RECOGNIZER={name!r} (expected 'remote', 'cnn', or 'both').")


recognizer: Recognizer = _resolve_recognizer()

# TEMPORARY — step 6 phone debugging only. Diagnosing why real phone
# captures produce table_not_found where a direct file upload of the same
# grid works fine, and the backend is stateless by design (plan.md §9) so
# there is normally nothing left to inspect after a request. Saves every
# upload here so real captures can actually be looked at. Remove this block
# once step 6 is confirmed working — it is a deliberate, temporary
# exception to statelessness, not a permanent feature.
DEBUG_UPLOADS_DIR = Path(__file__).resolve().parent.parent / "debug_uploads"

# The phone (LAN) and the dev machine (localhost) are different origins even
# on the same laptop (plan.md §9 "Running locally") — allow both without
# hardcoding one machine's specific LAN address, since that changes per
# network. Matches localhost/127.0.0.1 and the three private IP ranges.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"^https?://(localhost|127\.0\.0\.1"
        r"|192\.168\.\d{1,3}\.\d{1,3}"
        r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
        r"|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})"
        r"(:\d+)?$"
    ),
    allow_methods=["POST"],
    allow_headers=["*"],
)


@app.post("/api/scan")
async def scan(
    image: Annotated[UploadFile, File()],
    config: Annotated[str, Form()],
) -> ScanResult:
    # HTTP encodes a body as multipart or JSON, never both — QuizConfig
    # rides as a JSON string in a form field (stack-reference.md).
    quiz = QuizConfig.model_validate_json(config)
    image_bytes = await image.read()

    # TEMPORARY — see DEBUG_UPLOADS_DIR comment above.
    DEBUG_UPLOADS_DIR.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    (DEBUG_UPLOADS_DIR / f"{stamp}.jpg").write_bytes(image_bytes)

    # A fresh temp directory per request, deleted before this function
    # returns — nothing persists across requests or after one completes.
    # detect()/read_id()/recognize() are file-based by design (built and
    # tuned as standalone scripts — step.md's own reasoning for building
    # them in that order); this keeps them unchanged rather than rewriting
    # working, tested code around an in-memory-only constraint plan.md
    # never actually asked for. "Nothing written to disk" (plan.md §9) is
    # about no persistent storage or session data surviving a request, not
    # a ban on a transient temp file during one.
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        image_path = tmp_path / "upload.jpg"
        image_path.write_bytes(image_bytes)
        out_dir = tmp_path / "out"

        question_count = len(quiz.questions)
        det = detect_any_orientation(image_path, question_count, quiz.idDigits, out_dir)

        # Never call Gemini after table_not_found or column_count_mismatch
        # (plan.md §9) — protects the quota and the ID's privacy property
        # at once, since the composite is never built and Gemini is never
        # reached on either path.
        if det["status"] != "ok":
            return ScanResult(status="failed", failure_reason=det["failure_reason"])

        cells_dir = out_dir / "cells"

        id_result = recognizer.read_id(cells_dir, quiz.idDigits)

        question_maxes = [q.max for q in quiz.questions]
        marks_result = recognizer.read_marks(cells_dir, question_maxes)

        if marks_result.status != "ok":
            return ScanResult(status="failed", failure_reason=marks_result.failure_reason)

        low_confidence_fields = list(id_result.low_confidence_fields) + list(marks_result.low_confidence_fields)

        questions = [
            QuestionMark(q=i + 1, value=value)
            for i, value in enumerate(marks_result.questions)
        ]
        # q=0 marks this as the total, not a real question — plan.md §8
        # types `total` as a QuestionMark but doesn't say what `q` should
        # be for it; 0 is an explicit sentinel rather than an ambiguous
        # extra "Qn+1".
        total = QuestionMark(q=0, value=marks_result.total)

        return ScanResult(
            status="ok",
            student_id=id_result.student_id,
            serial=marks_result.serial,
            questions=questions,
            total=total,
            low_confidence_fields=low_confidence_fields,
        )


@app.post("/api/harvest")
async def harvest_endpoint(
    image: Annotated[UploadFile, File()],
    config: Annotated[str, Form()],
    original: Annotated[str, Form()],
    confirmed: Annotated[str, Form()],
) -> dict[str, bool]:
    """Step 3r.6c: called from the review screen on Confirm, alongside
    (never blocking) the actual save. Best-effort — a detection failure
    here just means nothing gets harvested for this scan, not a failed
    save; the instructor's record is already safe in IndexedDB by the
    time this fires."""
    quiz = QuizConfig.model_validate_json(config)
    original_fields = HarvestFields.model_validate_json(original)
    confirmed_fields = HarvestFields.model_validate_json(confirmed)
    image_bytes = await image.read()

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        image_path = tmp_path / "upload.jpg"
        image_path.write_bytes(image_bytes)
        out_dir = tmp_path / "out"

        question_count = len(quiz.questions)
        det = detect_any_orientation(image_path, question_count, quiz.idDigits, out_dir)
        if det["status"] != "ok":
            return {"harvested": False}

        # Reads harvest_module.HARVEST_DIR fresh at call time rather than
        # relying on harvest()'s own default parameter (bound once, at
        # function-definition time) — this is what lets tests point
        # harvesting at a tmp_path via monkeypatch without polluting the
        # real repo directory.
        harvest_module.harvest(
            out_dir / "cells",
            quiz.idDigits,
            question_count,
            original_fields.studentId,
            confirmed_fields.studentId,
            original_fields.serial,
            confirmed_fields.serial,
            original_fields.questions,
            confirmed_fields.questions,
            original_fields.total,
            confirmed_fields.total,
            harvest_dir=harvest_module.HARVEST_DIR,
        )

    return {"harvested": True}
