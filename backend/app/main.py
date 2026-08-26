"""POST /api/scan (step.md step 4). Steps 1-3 are already proven standalone
(detect.py, id_ocr_accuracy.py, and a live Gemini run — see learn.md); this
is meant to be a thin wrapper over that working code, not a rewrite.
"""
from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .detection import detect_any_orientation
from .id_ocr import read_id
from .marks import recognize
from .marks_ocr import recognize_locally
from .models import QuestionMark, QuizConfig, ScanResult

app = FastAPI()

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

        student_id, id_low_confidence = read_id(cells_dir, quiz.idDigits)

        question_maxes = [q.max for q in quiz.questions]
        marks_result = recognize(cells_dir, question_maxes)

        if marks_result.status != "ok":
            # Gemini itself failed (rate_limited/model_error), not
            # detection — cells_dir already has real crops. Try a local,
            # deliberately weaker OCR read rather than forcing the
            # instructor to hand-type every field for the rest of the
            # session; recognize_locally returns None if it couldn't
            # recover anything, in which case this is a genuine failure
            # same as before.
            fallback = recognize_locally(cells_dir, question_maxes)
            if fallback is None:
                return ScanResult(status="failed", failure_reason=marks_result.failure_reason)
            marks_result = fallback

        low_confidence_fields = list(id_low_confidence) + list(marks_result.low_confidence_fields)

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
            student_id=student_id,
            serial=marks_result.serial,
            questions=questions,
            total=total,
            low_confidence_fields=low_confidence_fields,
        )
