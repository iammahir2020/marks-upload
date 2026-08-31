"""POST /api/scan (step.md step 4). Steps 1-3 are already proven standalone
(detect.py, id_ocr_accuracy.py, and a live Gemini run — see learn.md); this
is meant to be a thin wrapper over that working code, not a rewrite.

Recognition (steps 2-3) is reached only through the Recognizer protocol
(step.md step 2r.0, `app/recognizers/`) — this module never imports
id_ocr/marks/marks_ocr by name, so the CNN path (step 3r) is a second
implementation of that protocol, not a second call site here.
"""
from __future__ import annotations

import tempfile
import time
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.requests import Request

# Imported first, deliberately: config.py calls load_dotenv at import, and
# every setting below (RECOGNIZER included) is resolved from it. That used
# to be an explicit load_dotenv here, for the same reason — RECOGNIZER is
# read at import time, and making the sub-recognizer imports lazy nearly
# broke .env-based selection as a side effect. One module, loaded once,
# before anything reads a variable (step 11.1).
from . import config as config_module  # noqa: E402
from . import harvest as harvest_module  # noqa: E402
from . import observability as obs  # noqa: E402
from . import ratelimit  # noqa: E402
from . import stores  # noqa: E402
from .detection import detect_any_orientation
from .models import HarvestFields, QuestionMark, QuizConfig, ScanResult
from .recognizers.base import Recognizer
from .recognizers.remote import RemoteRecognizer

app = FastAPI()


def _resolve_recognizer() -> Recognizer:
    """RECOGNIZER selects the implementation once at startup (plan.md §16);
    the pipeline below calls only through the Recognizer protocol from here
    on, never `id_ocr`/`marks`/`marks_ocr` by name.

    The default is "cnn" as of 2026-08-30 (step 3r.6e). Measured on the
    18-photo real-class batch, the local CNN reads IDs at 91.8% per-digit /
    55.2% whole-ID against Tesseract's 58.9% / 0.0%, and marks at 98.1%
    per-question — and it costs nothing, has no rate limit to exhaust
    mid-class, works with no network at all, and keeps every photo on this
    laptop. Serial is its weakest field (63.2%); a low-confidence serial is
    flagged blank rather than guessed, and identity survives on the ID
    alone, so this was accepted deliberately rather than overlooked.

    Because "cnn" is now the default, onnxruntime and scipy are in
    requirements.txt, not requirements-cnn.txt — the app genuinely cannot
    start without them. torch stays training-only: nothing under app/
    imports it, so the running app still never needs it.

    The sub-recognizers are still imported lazily, inside their own
    branches, so that RECOGNIZER=remote keeps working on a machine with no
    CNN dependencies installed at all."""
    name = config_module.RECOGNIZER
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

# Step 11.4. Built here rather than per request so the counters persist
# across calls within one process — which is the only place they can
# persist at all (see ratelimit.py on what that is worth on Lambda).
limiter = ratelimit.SlidingWindowLimiter(
    config_module.RATE_LIMIT_REQUESTS,
    config_module.RATE_LIMIT_WINDOW_SECONDS,
)

# Only the two endpoints that do real work. A limit on everything would
# also throttle CORS preflights, which browsers send automatically and
# which cost nothing to answer — turning a generous limit into a
# surprisingly tight one for no security benefit.
_LIMITED_PATHS = frozenset({"/api/scan", "/api/harvest"})


@app.middleware("http")
async def guard(request: Request, call_next):
    """Size cap and rate limit, in that order (step 11.4.1, 11.4.2).

    Middleware rather than a route dependency for one specific reason: the
    size check has to happen BEFORE the body is read, and a dependency
    runs after FastAPI has already parsed the multipart form — by which
    point an oversized upload is in memory and the cap has done nothing.
    """
    if request.method == "POST" and request.url.path in _LIMITED_PATHS:
        # Content-Length is a claim, not a fact — but rejecting on it is
        # free and catches the honest oversized upload. The real
        # enforcement is the post-read check in the handlers, which sees
        # the actual bytes.
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > config_module.MAX_UPLOAD_BYTES:
            obs.log_event("rejected_oversize", path=request.url.path,
                          declared_kb=int(declared) // 1024)
            return JSONResponse(
                {"detail": "Image too large."},
                status_code=413,
            )

        if config_module.RATE_LIMIT_ENABLED:
            retry_after = limiter.check(ratelimit.client_ip(request))
            if retry_after is not None:
                obs.log_event("rate_limited", path=request.url.path,
                              retry_after_s=int(retry_after) + 1)
                return JSONResponse(
                    {"detail": "Too many requests. Please slow down."},
                    status_code=429,
                    headers={"Retry-After": str(max(1, int(retry_after) + 1))},
                )
            limiter.prune()

    return await call_next(request)


def _log_scan(
    status: str,
    failure_reason: str | None,
    ms: dict[str, int],
    started: float,
    quiz: QuizConfig,
    image_bytes: bytes,
    low_confidence_fields: list[str],
) -> None:
    """One line per scan, carrying facts about the request and never its
    content. `low_confidence_fields` is a list of FIELD NAMES ("q1",
    "student_id") — which is exactly the useful signal and none of the
    sensitive one. See observability.py for why this is enforced rather
    than merely intended."""
    obs.log_event(
        "scan",
        status=status,
        failure_reason=failure_reason,
        recognizer=config_module.RECOGNIZER,
        questions=len(quiz.questions),
        id_digits=quiz.idDigits,
        image_kb=len(image_bytes) // 1024,
        ms_detect=ms.get("detect"),
        ms_read_id=ms.get("read_id"),
        ms_read_marks=ms.get("read_marks"),
        ms_total=int((time.perf_counter() - started) * 1000),
        flagged_count=len(low_confidence_fields),
        flagged=low_confidence_fields,
    )


def _reject_oversized(image_bytes: bytes) -> None:
    """The real cap. Content-Length can be absent or a lie; this sees what
    actually arrived. Raised as 413 so a client can tell "your photo is too
    big" apart from "the scan failed"."""
    if len(image_bytes) > config_module.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large.")

# The phone (LAN) and the dev machine (localhost) are different origins even
# on the same laptop (plan.md §9 "Running locally") — allow both without
# hardcoding one machine's specific LAN address, since that changes per
# network. Matches localhost/127.0.0.1 and the three private IP ranges.
#
# ALLOWED_ORIGINS replaces that regex with an explicit allowlist for a
# hosted frontend, whose public domain the regex rejects outright (step
# 11.1.1). Unset — the laptop case — keeps the regex exactly as it was.
_origins = config_module.allowed_origins()
if _origins is None:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=config_module.DEFAULT_ALLOWED_ORIGIN_REGEX,
        allow_methods=["POST"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
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
    _reject_oversized(image_bytes)

    ms: dict[str, int] = {}
    started = time.perf_counter()

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
        with obs.timed(ms, "detect"):
            det = detect_any_orientation(image_path, question_count, quiz.idDigits, out_dir)

        # Never call Gemini after table_not_found or column_count_mismatch
        # (plan.md §9) — protects the quota and the ID's privacy property
        # at once, since the composite is never built and Gemini is never
        # reached on either path.
        if det["status"] != "ok":
            _log_scan("failed", det["failure_reason"], ms, started, quiz, image_bytes, [])
            return ScanResult(status="failed", failure_reason=det["failure_reason"])

        cells_dir = out_dir / "cells"

        with obs.timed(ms, "read_id"):
            id_result = recognizer.read_id(cells_dir, quiz.idDigits)

        question_maxes = [q.max for q in quiz.questions]
        with obs.timed(ms, "read_marks"):
            marks_result = recognizer.read_marks(cells_dir, question_maxes)

        if marks_result.status != "ok":
            _log_scan("failed", marks_result.failure_reason, ms, started, quiz, image_bytes, [])
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

        _log_scan("ok", None, ms, started, quiz, image_bytes, low_confidence_fields)

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
    source: Annotated[str | None, Form()] = None,
) -> dict[str, bool]:
    """Step 3r.6c: called from the review screen on Confirm, alongside
    (never blocking) the actual save. Best-effort — a detection failure
    here just means nothing gets harvested for this scan, not a failed
    save; the instructor's record is already safe in IndexedDB by the
    time this fires.

    `source` (step 11.2.5) is an opaque per-browser id the frontend
    generates once and stores in IndexedDB. It is optional: an older
    frontend, or a request without it, files crops under `unknown/`
    rather than being assigned something server-side, because one shared
    backend would label every faculty member identically."""
    if not config_module.HARVEST_ENABLED:
        return {"harvested": False}

    quiz = QuizConfig.model_validate_json(config)
    original_fields = HarvestFields.model_validate_json(original)
    confirmed_fields = HarvestFields.model_validate_json(confirmed)
    image_bytes = await image.read()
    _reject_oversized(image_bytes)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        image_path = tmp_path / "upload.jpg"
        image_path.write_bytes(image_bytes)
        out_dir = tmp_path / "out"

        question_count = len(quiz.questions)
        det = detect_any_orientation(image_path, question_count, quiz.idDigits, out_dir)
        if det["status"] != "ok":
            return {"harvested": False}

        # Built fresh per request rather than once at import, so tests can
        # point harvesting at a tmp_path (and a redeployed environment sees
        # current config) without a module-level default bound at
        # function-definition time.
        store = stores.build_store()

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
            store=store,
            source=source,
        )

    obs.log_event("harvest", harvested=True, questions=question_count,
                  tagged=bool(source))
    return {"harvested": True}
