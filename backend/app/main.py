"""POST /api/scan (step.md step 4). Steps 1-3 are already proven standalone
(detect.py, id_ocr_accuracy.py, and a live Gemini run — see learn.md); this
is meant to be a thin wrapper over that working code, not a rewrite.

Recognition (steps 2-3) is reached only through the Recognizer protocol
(step.md step 2r.0, `app/recognizers/`) — this module never imports
id_ocr/marks/marks_ocr by name, so the CNN path (step 3r) is a second
implementation of that protocol, not a second call site here.
"""
from __future__ import annotations

import hmac
import os
import tempfile
import time
import traceback
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request

# Imported first, deliberately: config.py calls load_dotenv at import, and
# every setting below (RECOGNIZER included) is resolved from it. That used
# to be an explicit load_dotenv here, for the same reason — RECOGNIZER is
# read at import time, and making the sub-recognizer imports lazy nearly
# broke .env-based selection as a side effect. One module, loaded once,
# before anything reads a variable (step 11.1).
from . import config as config_module  # noqa: E402
from . import imagecheck  # noqa: E402
from . import harvest as harvest_module  # noqa: E402
from . import observability as obs  # noqa: E402
from . import ratelimit  # noqa: E402
from . import stores  # noqa: E402
from .detection import detect_any_orientation
from .marks import MarksResult
from .models import HarvestFields, QuestionMark, QuizConfig, ScanResult, TableMismatch
from .recognizers.base import IdResult, Recognizer
from .recognizers.remote import RemoteRecognizer

# No /docs, /redoc or /openapi.json (issues.md N42): nothing in this app
# uses them, and on the public URL they were a ready-made map of the API.
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


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

# X-Ray's boto3 patch is NOT done here, on purpose — see stores.py's
# S3Store.__init__ for why, and for a real incident that made the reason
# concrete: calling `aws_xray_sdk.core.patch(("boto3",))` eagerly at
# cold start forces `botocore` to import immediately, and that alone
# added ~7s to Lambda's init phase, on top of an already-heavy import
# chain — enough to blow past the platform's ~10s init-phase timeout and
# break every request, not just ones that touch S3. Deferred to the one
# place boto3 itself is actually imported, lazily, per /api/harvest
# request, which is also the only place that needs it patched.

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
    # issues.md N42 — first, before any other work: when deployed, only a
    # request that came through CloudFront (which adds the secret header)
    # reaches the API. Compared in constant time.
    if config_module.ORIGIN_SECRET and request.url.path.startswith("/api/"):
        sent = request.headers.get("x-origin-verify", "")
        if not hmac.compare_digest(sent.encode(), config_module.ORIGIN_SECRET.encode()):
            obs.log_event("rejected_origin", path=request.url.path)
            return JSONResponse({"detail": "Forbidden."}, status_code=403)

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
            retry_after = limiter.check(ratelimit.client_ip(request, config_module.CLIENT_IP_SOURCE))
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


def _parse(model, raw: str, field: str):
    """Parse a JSON form field into a model, as a 400 rather than a 500.

    `model_validate_json` raises `pydantic.ValidationError`, and FastAPI
    installs default handlers only for `HTTPException`,
    `RequestValidationError` and `WebSocketRequestValidationError` — a
    ValidationError raised inside a route body is none of those, so it
    surfaced as a bare 500 (issues.md #8). That mattered more once
    QuizConfig gained real validation rules: every bound, the q-order check
    and the totalMax check now reject through this path, and "the quiz
    config is wrong" is a client error with a fixable cause, not a server
    fault.

    The message is included because it names the offending field, and the
    only clients are the instructor's own browser and whoever is holding
    the demo URL — there is nothing secret in "totalMax must equal the sum
    of question maxima".
    """
    try:
        return model.model_validate_json(raw)
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"Invalid {field}: {e.errors()[0]['msg']}")


def _reject_oversized(image_bytes: bytes) -> None:
    """The real cap. Content-Length can be absent or a lie; this sees what
    actually arrived. Raised as 413 so a client can tell "your photo is too
    big" apart from "the scan failed"."""
    if len(image_bytes) > config_module.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large.")
    _reject_unsafe_image(image_bytes)


def _reject_unsafe_image(image_bytes: bytes) -> None:
    """issues.md N39/N47, before OpenCV sees a byte: only JPEG and PNG (415
    otherwise), and a pixel count read from the header (413 when it's more
    than a phone photo could need). Runs inside _reject_oversized so both
    endpoints that decode an upload — /api/scan and /api/harvest — get it
    from the one call they already make."""
    try:
        info = imagecheck.sniff(image_bytes)
    except imagecheck.UnsupportedImage:
        raise HTTPException(status_code=415, detail="Only JPEG and PNG images are accepted.")
    except imagecheck.UnreadableImage:
        raise HTTPException(status_code=400, detail="The image file is damaged or incomplete.")
    if (
        info.width <= 0 or info.height <= 0
        or max(info.width, info.height) > config_module.MAX_IMAGE_SIDE
        or info.width * info.height > config_module.MAX_IMAGE_PIXELS
    ):
        raise HTTPException(status_code=413, detail="Image dimensions too large.")

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


@app.middleware("http")
async def trace(request: Request, call_next):
    """Wraps every request in an X-Ray subsegment (step 11.8, the
    monitoring dashboard). Off entirely unless XRAY_ENABLED — the laptop
    app never imports `aws_xray_sdk` at all.

    Registered LAST, deliberately: Starlette wraps middleware in REVERSE
    registration order (the last one added is the OUTERMOST), so this
    wraps `guard` and CORS rather than sitting inside them. That means a
    request `guard` rejects with 429/413 still gets a real, correctly-
    statused trace instead of silently vanishing from the map — which is
    exactly the kind of thing worth being able to SEE in the graph, not
    the kind of thing tracing should hide because it happened early.

    No first-party ASGI/FastAPI integration exists in `aws-xray-sdk`
    (Django/Flask/Bottle/aiohttp only) — this is the ~15 lines that
    middleware class would have been, written directly. Lambda's own
    runtime opens the top-level SEGMENT per invocation before any of this
    code runs (from the `_X_AMZN_TRACE_ID` env var it sets); application
    code only ever opens a SUBSEGMENT under it, never a new segment —
    `begin_segment()` here would create a second, disconnected root
    instead of nesting under the one Lambda already started.

    **The env-var sync below is load-bearing, not defensive.** A second
    real incident, found by actually checking a live trace rather than
    trusting the deploy: every subsegment this middleware opened was
    silently discarded ("Subsegment ... discarded due to Lambda worker
    still initializing"), on every request, warm or cold — the platform's
    own top-level segment recorded fine, but nothing this app added ever
    showed up under it, which would have meant a Service Map with a bare
    Lambda box and no S3 edge, the one thing this feature exists to draw.
    Root cause, confirmed against the SDK's own source
    (`lambda_launcher.py`): it re-reads `_X_AMZN_TRACE_ID` from the
    environment FRESH on every subsegment call, which is correct for a
    native Lambda handler — but the Lambda Web Adapter this app runs
    behind forks uvicorn ONCE at cold start, and a forked child's
    environment is a private copy from that moment; nothing updates it
    per invocation the way Lambda updates the platform process's own. So
    the SDK was reading a value frozen at cold start on every request
    after the first. What IS fresh per request is the `X-Amzn-Trace-Id`
    HTTP header — LWA forwards the real one on every proxied call, by
    design, for exactly this — so this middleware copies it into the
    environment itself before asking the recorder for a subsegment,
    keeping the SDK's own already-correct re-read logic pointed at
    reality instead of a stale snapshot.

    Writing process-global state per request is safe here for one
    specific reason worth stating rather than leaving implicit: Lambda
    runs exactly one invocation at a time per execution environment, so
    requests through this process are serialised and two cannot race to
    set it. That is a property of the platform, not of this code — which
    is the other half of why XRAY_ENABLED must stay off anywhere that is
    not a real Lambda invocation (see config.py). Under a concurrent
    server it would cross-attribute one request's spans to another's
    trace.

    Follows `observability.py`'s own rule for the same reason it exists
    there: **tracing must never be able to fail or slow a scan.** Any
    exception from the X-Ray SDK itself — including "no parent segment",
    the exact failure mode of enabling this outside a real Lambda
    invocation — is caught and logged, never allowed to reach the
    response.
    """
    if not config_module.XRAY_ENABLED:
        return await call_next(request)

    try:
        from aws_xray_sdk.core import xray_recorder
        from aws_xray_sdk.core.models import http as xray_http

        incoming_trace_header = request.headers.get("x-amzn-trace-id")
        if incoming_trace_header:
            os.environ["_X_AMZN_TRACE_ID"] = incoming_trace_header
        segment = xray_recorder.begin_subsegment(request.url.path)
    except Exception:  # noqa: BLE001 - tracing must never break a request
        obs.log_event("xray_error", stage="begin")
        return await call_next(request)

    try:
        if segment is not None:
            segment.put_http_meta(xray_http.METHOD, request.method)
            segment.put_http_meta(xray_http.URL, str(request.url))
        response = await call_next(request)
        if segment is not None:
            segment.put_http_meta(xray_http.STATUS, response.status_code)
        return response
    except Exception as exc:
        if segment is not None:
            segment.add_exception(exc, traceback.format_exc())
        raise
    finally:
        try:
            xray_recorder.end_subsegment()
        except Exception:  # noqa: BLE001 - see docstring
            obs.log_event("xray_error", stage="end")


@app.post("/api/scan")
async def scan(
    image: Annotated[UploadFile, File()],
    config: Annotated[str, Form()],
) -> ScanResult:
    # HTTP encodes a body as multipart or JSON, never both — QuizConfig
    # rides as a JSON string in a form field (stack-reference.md).
    quiz = _parse(QuizConfig, config, "config")
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

        # Every stage below is synchronous, CPU-bound and slow: OpenCV
        # detection, the ONNX session, and on the remote path Tesseract and
        # a network round trip. Run directly in this `async def` they would
        # occupy the single event-loop thread for the whole scan, so a
        # second request could not even begin parsing until the first
        # finished (issues.md #7) — which silently defeated `scanQueue.ts`,
        # built specifically so several captures can be in flight at once.
        #
        # run_in_threadpool hands each stage to the same worker pool
        # FastAPI already uses for plain `def` routes. The route stays
        # `async def` because `await image.read()` genuinely is async, and
        # because the stages need to stay individually timed.
        question_count = len(quiz.questions)
        with obs.timed(ms, "detect"):
            det = await run_in_threadpool(
                detect_any_orientation, image_path, question_count, quiz.idDigits, out_dir, quiz.hasSerial
            )

        # A column_count_mismatch in ONE table no longer fails the whole
        # scan: the ID, Serial and Marks rows are separate printed tables,
        # so whichever matched is still read and only the miscounted one is
        # left blank and flagged (a partial scan). A mismatched table is
        # still never read — detection writes no crops for it — so the
        # "never write Q4's mark into Q3" guarantee holds per table.
        #
        # Never call Gemini for a table that failed (plan.md §9): after
        # table_not_found, or when the marks table itself mismatched, the
        # composite is never built and Gemini is never reached on either
        # path. Only a matched marks table is ever sent.
        if det["status"] != "ok" and not _is_partial(det, quiz):
            _log_scan("failed", det["failure_reason"], ms, started, quiz, image_bytes, [])
            return ScanResult(status="failed", failure_reason=det["failure_reason"],
                              lighting=det.get("lighting"))

        mismatches = [
            TableMismatch(table=t["type"], found=t["col_count"], expected=t["expected_col_count"])
            for t in det["tables"]
            if not t["match"]
        ]
        failed_tables = {m.table for m in mismatches}
        cells_dir = out_dir / "cells"
        question_maxes = [q.max for q in quiz.questions]
        question_keys = [f"q{i + 1}" for i in range(len(question_maxes))]

        if "id" in failed_tables:
            id_result = IdResult(student_id=None, low_confidence_fields=["student_id"])
        else:
            with obs.timed(ms, "read_id"):
                id_result = await run_in_threadpool(recognizer.read_id, cells_dir, quiz.idDigits)

        if "marks" in failed_tables:
            # Serial is read alongside the marks (read_marks), so it goes
            # unread with them rather than growing a serial-only path.
            flagged = (["serial"] if quiz.hasSerial else []) + question_keys + ["total"]
            marks_result = MarksResult(
                status="ok", questions=[None] * len(question_maxes), low_confidence_fields=flagged
            )
        else:
            serial_readable = quiz.hasSerial and "serial" not in failed_tables
            with obs.timed(ms, "read_marks"):
                # Step 16 — False for the no-Serial-box paper layout, and
                # here also for a Serial row whose count was wrong: the
                # recognizer then never looks for serial.png at all.
                marks_result = await run_in_threadpool(
                    recognizer.read_marks, cells_dir, question_maxes, has_serial=serial_readable
                )
            if marks_result.status == "ok" and quiz.hasSerial and not serial_readable:
                marks_result.low_confidence_fields = ["serial", *marks_result.low_confidence_fields]

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

        if mismatches:
            _log_scan("partial", det["failure_reason"], ms, started, quiz, image_bytes, low_confidence_fields)
        else:
            _log_scan("ok", None, ms, started, quiz, image_bytes, low_confidence_fields)

        return ScanResult(
            status="ok",
            student_id=id_result.student_id,
            serial=marks_result.serial,
            questions=questions,
            total=total,
            low_confidence_fields=low_confidence_fields,
            unmatched_fields=marks_result.unmatched_fields,
            crossed_out_fields=list(id_result.crossed_out_fields) + list(marks_result.crossed_out_fields),
            suggestions=marks_result.suggestions,
            choices=marks_result.choices,
            table_mismatches=mismatches,
            # Only set when a table went unread — the light may be why.
            lighting=det.get("lighting") if mismatches else None,
        )


def _is_partial(det: dict, quiz: QuizConfig) -> bool:
    """A column_count_mismatch where every table was found and at least one
    matched. table_not_found and blurry stay whole-scan failures, and so
    does a mismatch in every table — there is nothing left to read.

    So does a paper whose layout contradicts the quiz's "Serial box on
    paper" setting (step 16). Which box is the ID is decided by POSITION
    above the marks table, so a wrong setting shifts every pick by one:
    layout B read with the setting on takes the Name/Section table as the
    ID, and a Name/Section table that happened to have idDigits+1 columns
    would be read as a student ID. Its signature is unambiguous — the box
    taken as the Serial has an ID row's column count, or the box taken as
    the ID has a Serial box's — and it is a per-quiz setting error, not a
    per-photo one, so it fails loudly on every script until it is fixed."""
    if det["failure_reason"] != "column_count_mismatch":
        return False
    tables = {t["type"]: t for t in det["tables"]}
    if quiz.hasSerial and tables["serial"]["col_count"] == quiz.idDigits + 1:
        return False
    if not quiz.hasSerial and tables["id"]["col_count"] == 2:
        return False
    return all(t["found"] for t in tables.values()) and any(t["match"] for t in tables.values())


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

    quiz = _parse(QuizConfig, config, "config")
    original_fields = _parse(HarvestFields, original, "original")
    confirmed_fields = _parse(HarvestFields, confirmed, "confirmed")
    image_bytes = await image.read()
    _reject_oversized(image_bytes)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        image_path = tmp_path / "upload.jpg"
        image_path.write_bytes(image_bytes)
        out_dir = tmp_path / "out"

        question_count = len(quiz.questions)
        det = await run_in_threadpool(
            detect_any_orientation, image_path, question_count, quiz.idDigits, out_dir, quiz.hasSerial
        )
        # A partial scan is harvested too, from the tables that matched —
        # the same rule /api/scan reads them by. Nothing extra is needed to
        # keep a miscounted table out: detect() writes no crops for it, and
        # harvest() only stores crops that exist, so whatever the instructor
        # typed into that table's fields has no image to be attached to. A
        # wrong Serial setting is not partial (_is_partial) and stays refused.
        partial = det["status"] != "ok" and _is_partial(det, quiz)
        if det["status"] != "ok" and not partial:
            obs.log_event("harvest", harvested=False, reason=det["failure_reason"])
            return {"harvested": False}

        # "Best-effort" now actually holds on THIS side of the wire too
        # (issues.md N14). It only ever held on the client: `harvestScan`
        # swallows every error, so an S3 permission problem, a missing
        # HARVEST_BUCKET or a malformed crop raised out of here as a bare
        # 500 that nothing anywhere reported. Collection would simply stop,
        # silently, and the only evidence would be the *absence* of a log
        # line — which is exactly the thing nobody notices.
        #
        # So: swallow, but say so. A failed harvest must never fail a scan
        # (the instructor's record is already safe in IndexedDB by now),
        # and it must never be invisible either.
        try:
            # Built fresh per request rather than once at import, so tests
            # can point harvesting at a tmp_path (and a redeployed
            # environment sees current config) without a module-level
            # default bound at function-definition time.
            store = stores.build_store()

            await run_in_threadpool(
                harvest_module.harvest,
                out_dir / "cells",
                quiz.idDigits,
                question_count,
                original_fields.studentId,
                confirmed_fields.studentId,
                # Step 16 — no Serial box on the paper, so no serial crop
                # exists and nothing is harvested for it, whatever was sent.
                original_fields.serial if quiz.hasSerial else None,
                confirmed_fields.serial if quiz.hasSerial else None,
                original_fields.questions,
                confirmed_fields.questions,
                original_fields.total,
                confirmed_fields.total,
                store,
                source,
                # N31 — only the ORIGINAL scan's flags matter here: what
                # was actually decoded before the instructor touched
                # anything. confirmed_fields.unmatchedFields is never
                # sent by the frontend (Review.tsx only populates this on
                # `original`) and is ignored even if it were.
                frozenset(original_fields.unmatchedFields),
                # Step 15 — same rule, same side: a crop the original scan
                # found a crossed-out glyph in is never labelled with
                # whatever the instructor corrected it to.
                frozenset(original_fields.crossedOutFields),
            )
        except Exception as e:  # noqa: BLE001 — see the comment above
            # Type and message only: never the exception's own repr, which
            # can carry a key path and therefore a confirmed value.
            obs.log_event("harvest_failed", error_type=type(e).__name__, detail=str(e)[:200])
            return {"harvested": False}

    obs.log_event("harvest", harvested=True, questions=question_count,
                  tagged=bool(source), partial=partial)
    return {"harvested": True}
