"""Serial and marks recognition via Gemini (step.md step 3).

Cell crops from step 1 are tiled into one composite image and read in a
single API call. The student ID never appears here — see plan.md §12 and
the assertion in build_composite (step 3.1: a code-level check, not just a
convention, because the privacy property is one bug away from being false).
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from dotenv import load_dotenv
from pydantic import BaseModel

# backend/.env, not the repo root — the key is backend-only (plan.md §9).
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

MODEL = "gemini-3.6-flash"  # stack-reference.md's starting point (2.5-flash)
                             # is a 404 as of this project: "no longer
                             # available to new users." Google's own error
                             # named this replacement — confirmed live, not
                             # guessed. Free-tier availability still moves;
                             # re-check if this 404s again later.


class ScanPayload(BaseModel):
    """Gemini's response_schema. Constrains structure only, not range — a
    7 can still come back for a 5-mark question (step.md 3.3-3.4)."""
    serial: str | None
    questions: list[float | None]
    total: float | None


class MarksResult(BaseModel):
    status: Literal["ok", "failed"]
    failure_reason: str | None = None  # "model_error" | "rate_limited"
    serial: str | None = None
    questions: list[float | None] = []
    total: float | None = None
    low_confidence_fields: list[str] = []


def legal_values(max_mark: float) -> set[float]:
    """0, 0.5, 1, ..., max_mark (plan.md §4)."""
    steps = round(max_mark * 2)
    return {i / 2 for i in range(steps + 1)}


def _fmt(v: float) -> str:
    return str(int(v)) if v == int(v) else str(v)


def build_composite(cells_dir: Path, questions: int) -> tuple[np.ndarray | None, list[str]]:
    """Tile the serial crop and every marks answer-row crop into one
    labelled composite, left to right. Returns (composite, labels); labels
    names each tile in the same order they appear in the image, which the
    prompt refers to by name.

    Never includes an id_d*.png crop. The composite is built from an
    explicit allow-list (serial.png, marks_r1_c*.png only) rather than a
    directory scan, and the assertion below is the actual guarantee, not
    the allow-list itself — step 3.1 wants this checked in code."""
    sources: list[tuple[str, Path]] = []

    serial_path = cells_dir / "serial.png"
    if serial_path.exists():
        sources.append(("serial", serial_path))

    for c in range(questions + 1):  # columns 0..questions-1 = Qn, questions = Total
        crop_path = cells_dir / f"marks_r1_c{c}.png"
        if crop_path.exists():
            label = f"Q{c + 1}" if c < questions else "Total"
            sources.append((label, crop_path))

    assert all("id_d" not in path.name for _, path in sources), (
        "an ID crop was about to be included in the Gemini composite — "
        "this must never happen (plan.md §12)"
    )

    if not sources:
        return None, []

    labels = [label for label, _ in sources]
    images = [cv2.imread(str(path)) for _, path in sources]

    target_h = 120
    caption_h = 30
    tiles = []
    for label, img in zip(labels, images):
        h, w = img.shape[:2]
        scale = target_h / h
        resized = cv2.resize(img, (max(int(w * scale), 1), target_h))
        canvas = np.full((target_h + caption_h, resized.shape[1], 3), 255, dtype=np.uint8)
        canvas[:target_h] = resized
        cv2.putText(canvas, label, (4, target_h + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1, cv2.LINE_AA)
        tiles.append(canvas)

    gap = np.full((target_h + caption_h, 10, 3), 255, dtype=np.uint8)
    parts = []
    for i, tile in enumerate(tiles):
        if i > 0:
            parts.append(gap)
        parts.append(tile)
    composite = np.hstack(parts)

    return composite, labels


def build_prompt(question_maxes: list[float]) -> str:
    """Legal value set per question, derived from each question's own max,
    and the instruction to read the serial as written. Nothing about
    output shape — response_schema already fixes that, and restating the
    format degrades results (stack-reference.md)."""
    total_max = sum(question_maxes)
    lines = [
        "Read the labelled tiles in this image, left to right.",
        "If a tile is labelled \"serial\", read the number exactly as written.",
    ]
    for i, max_mark in enumerate(question_maxes, start=1):
        values_str = ", ".join(_fmt(v) for v in sorted(legal_values(max_mark)))
        lines.append(f"Tile \"Q{i}\" is a mark out of {_fmt(max_mark)}. Its value must be one of: {values_str}.")
    total_values_str = ", ".join(_fmt(v) for v in sorted(legal_values(total_max)))
    lines.append(f"Tile \"Total\" is out of {_fmt(total_max)}. Its value must be one of: {total_values_str}.")
    return "\n".join(lines)


def validate_payload(payload: ScanPayload, question_maxes: list[float]) -> MarksResult:
    """Reject any value outside the legal set for its question (step 3.4).
    The schema constrains structure, not range — this is the check that
    catches a 7 coming back for a 5-mark question. Rejected fields land in
    low_confidence_fields and stay blank; never store a wrong number."""
    low_confidence_fields: list[str] = []

    questions: list[float | None] = []
    for i, max_mark in enumerate(question_maxes):
        value = payload.questions[i] if i < len(payload.questions) else None
        if value is not None and value in legal_values(max_mark):
            questions.append(value)
        else:
            questions.append(None)
            low_confidence_fields.append(f"q{i + 1}")

    total_max = sum(question_maxes)
    if payload.total is not None and payload.total in legal_values(total_max):
        total = payload.total
    else:
        total = None
        low_confidence_fields.append("total")

    if payload.serial is None or not payload.serial.strip():
        low_confidence_fields.append("serial")

    return MarksResult(
        status="ok",
        serial=payload.serial,
        questions=questions,
        total=total,
        low_confidence_fields=low_confidence_fields,
    )


def check_blocked(response) -> str | None:
    """A blocked or empty response is a 200, not an exception — nothing
    retries it and nothing raises unless this is checked explicitly
    (stack-reference.md). Returns "model_error" if the response can't be
    trusted, else None. Skipping this turns a blocked reply into an
    unhandled None at parse time."""
    from google.genai import types  # local import: keeps this module

    feedback = getattr(response, "prompt_feedback", None)
    block_reason = getattr(feedback, "block_reason", None)
    if block_reason and block_reason != types.BlockedReason.BLOCKED_REASON_UNSPECIFIED:
        return "model_error"

    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        return "model_error"

    finish_reason = getattr(candidates[0], "finish_reason", None)
    if finish_reason is not None and finish_reason != types.FinishReason.STOP:
        return "model_error"

    if not getattr(response, "parsed", None):
        return "model_error"

    return None


def recognize(cells_dir: Path, question_maxes: list[float]) -> MarksResult:
    """The actual API call (step 3.2-3.5). Requires GEMINI_API_KEY in the
    environment — everything above this function is a pure function,
    testable without network or a key (step.md's Test section deliberately
    separates the two)."""
    from google import genai
    from google.genai import types

    composite, labels = build_composite(cells_dir, len(question_maxes))
    if composite is None:
        return MarksResult(status="failed", failure_reason="model_error")

    ok, png = cv2.imencode(".png", composite)
    if not ok:
        return MarksResult(status="failed", failure_reason="model_error")

    client = genai.Client()
    prompt = build_prompt(question_maxes)

    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=[
                prompt,
                types.Part.from_bytes(data=png.tobytes(), mime_type="image/png"),
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=ScanPayload,
                http_options=types.HttpOptions(
                    retry_options=types.HttpRetryOptions(
                        attempts=5, initial_delay=1.0, exp_base=2.0, max_delay=30.0,
                    ),
                ),
            ),
        )
    except Exception as e:  # noqa: BLE001 — SDK raises APIError; narrow this once live-tested
        if getattr(e, "code", None) == 429:
            return MarksResult(status="failed", failure_reason="rate_limited")
        return MarksResult(status="failed", failure_reason="model_error")

    blocked = check_blocked(response)
    if blocked:
        return MarksResult(status="failed", failure_reason=blocked)

    payload = response.parsed
    return validate_payload(payload, question_maxes)
