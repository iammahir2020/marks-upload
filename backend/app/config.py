"""Every environment read in one place (step.md step 11.1).

Why one module rather than `os.getenv` scattered through whichever file
happens to need it. Two reasons specific to this codebase:

1. `main.py` resolves `RECOGNIZER` at *import* time, and needed an explicit
   `load_dotenv` to do it reliably — that was found the hard way when the
   CNN default flip made the sub-recognizer imports lazy and nearly broke
   `.env`-based selection as a side effect. Loading dotenv exactly once,
   here, before anything reads a variable, keeps that from recurring.
2. Every setting below has to be readable both from a shell variable on the
   instructor's laptop and from a Lambda environment variable in
   production. One module that resolves them once keeps that from becoming
   several subtly different behaviours.

**Every default reproduces today's laptop behaviour exactly.** An unset
environment is the app as it stood before step 11 — that property is what
makes phase B safe to merge long before any deployment exists, and
`tests/test_config.py` asserts it rather than trusting it.

Not centralised here: `marks.py`'s own `load_dotenv`/`GEMINI_API_KEY`. That
key is read by the `google-genai` SDK itself rather than by our code, and
it only matters on the `remote` path. Left alone deliberately — moving it
would change the one path this step is not touching.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent

# Loaded once, at import, before any value below is read. main.py imports
# this module first for exactly that reason.
load_dotenv(BACKEND_DIR / ".env")


def _flag(name: str, default: bool) -> bool:
    """Accepts the spellings people actually type. Anything unrecognised
    falls back to the default rather than silently reading as False — a
    typo'd HARVEST_ENABLED should not quietly turn collection off."""
    raw = os.getenv(name)
    if raw is None:
        return default
    normalised = raw.strip().lower()
    if normalised in {"1", "true", "yes", "on"}:
        return True
    if normalised in {"0", "false", "no", "off"}:
        return False
    return default


# --- Recognition -----------------------------------------------------------

# "cnn" since step 3r.6e — see main.py's _resolve_recognizer docstring for
# the measurements behind that decision.
RECOGNIZER = os.getenv("RECOGNIZER", "cnn")


# --- CORS ------------------------------------------------------------------

# The phone (LAN) and the dev machine (localhost) are different origins
# even on the same laptop (plan.md §9), and the LAN address changes per
# network — hence a regex over the private ranges rather than one
# hardcoded address. This is the default and must stay byte-identical to
# what shipped before step 11: a deployed frontend on a public domain is
# rejected by it, which is correct for the laptop app and is exactly why
# ALLOWED_ORIGINS exists.
DEFAULT_ALLOWED_ORIGIN_REGEX = (
    r"^https?://(localhost|127\.0\.0\.1"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})"
    r"(:\d+)?$"
)


def allowed_origins() -> list[str] | None:
    """A comma-separated allowlist for a hosted frontend, or None to keep
    the localhost/LAN regex above. Returns None (not an empty list) when
    unset, so the caller can tell "use the default regex" apart from
    "allow nothing"."""
    raw = os.getenv("ALLOWED_ORIGINS")
    if raw is None:
        return None
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    return origins or None


# --- Public-URL hardening (step 11.4) --------------------------------------

# Largest accepted upload. Real captures measured 166 KB on average and
# 807 KB at the largest, so 4 MB is generous by a wide margin while still
# refusing a body that could only be abuse or a mistake.
#
# 4 MB and not 5, and the reason is easy to get wrong: Lambda's 6 MB
# request limit applies to the **base64-encoded event payload**, not to the
# raw bytes. A Function URL base64s the body, which inflates it by 4/3 — so
# a 5 MB image becomes a 6.7 MB payload and is rejected by the platform
# with an opaque error, which is precisely what this cap exists to prevent.
# 4 MB raw is ~5.3 MB encoded, leaving headroom for the multipart and JSON
# envelope. Measured, not assumed: a real 67 KB capture produced an 89 KB
# payload through the runtime emulator.
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(4 * 1024 * 1024)))

# issues.md N39 — the byte cap doesn't bound the WORK: a PNG of a plain grid
# compresses to ~100 KB while claiming 10000x10000 pixels. These are checked
# from the header before decoding (app/imagecheck.py). The app's own camera
# capture asks for 1920x1080 (Scan.tsx), and the largest test photo is
# exactly that; 16 MP still admits 4K (8.3 MP) and a 12 MP phone photo.
MAX_IMAGE_PIXELS = int(os.getenv("MAX_IMAGE_PIXELS", str(16_000_000)))
MAX_IMAGE_SIDE = int(os.getenv("MAX_IMAGE_SIDE", "8000"))

# What a Function URL will actually accept, for the check below to test
# against. Not configurable — it is AWS's number, not ours.
LAMBDA_PAYLOAD_LIMIT_BYTES = 6 * 1024 * 1024
BASE64_INFLATION = 4 / 3

RATE_LIMIT_ENABLED = _flag("RATE_LIMIT_ENABLED", True)

# Where the rate limiter learns who a caller is (ratelimit.client_ip,
# issues.md N41). "socket" — the laptop, no proxy — is the default;
# deploy.sh sets "cloudfront" for the hosted app, which trusts only the
# address CloudFront itself writes. Anything else is refused at startup
# rather than silently treated as one of the two.
CLIENT_IP_SOURCE = os.getenv("CLIENT_IP_SOURCE", "socket")
if CLIENT_IP_SOURCE not in ("socket", "cloudfront"):
    raise ValueError(f"CLIENT_IP_SOURCE must be 'socket' or 'cloudfront', not {CLIENT_IP_SOURCE!r}")

# 30 requests per minute per IP. Chosen against real use rather than picked
# round: an instructor scanning a class does roughly 3 a minute, so this is
# ~10x headroom for one person. It also has to survive several faculty
# behind one institutional NAT, who all share an apparent IP — five people
# scanning hard is ~15/min, still inside it. And a single IP sustaining the
# full 30/min for a month lands around 43,000 scans, which is still within
# Lambda's always-free tier, so even a hostile-but-slow caller cannot
# generate a bill. See ratelimit.py for what this is honestly worth.
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "30"))
RATE_LIMIT_WINDOW_SECONDS = float(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))


# --- Tesseract (the `remote` path only) ------------------------------------

# Explicit path to the tesseract binary, for when it is installed but not
# on PATH. On Linux `apt install tesseract-ocr` puts it on PATH and this
# stays unset; the Windows installer (UB Mannheim) does NOT add itself to
# PATH by default, so id_ocr.py falls back to probing the standard install
# locations when this is empty. Unused on the default `cnn` recognizer,
# which calls no Tesseract at all.
TESSERACT_CMD = os.getenv("TESSERACT_CMD")


# --- Harvesting (step 3r.6c's crop collection) -----------------------------

# Kill switch. A deployment that would rather not collect handwriting at
# all sets this to false and the endpoint becomes a no-op.
HARVEST_ENABLED = _flag("HARVEST_ENABLED", True)

# "local" (the laptop default) or "s3".
HARVEST_BACKEND = os.getenv("HARVEST_BACKEND", "local")

# Local destination. Same path harvest.py hardcoded before this step.
HARVEST_DIR = Path(os.getenv("HARVEST_DIR", str(BACKEND_DIR / "training_data" / "harvested")))

# S3 destination. Unset on the laptop; required when HARVEST_BACKEND=s3.
HARVEST_BUCKET = os.getenv("HARVEST_BUCKET")
HARVEST_PREFIX = os.getenv("HARVEST_PREFIX", "harvested")


# --- Tracing (X-Ray service map + CloudWatch dashboard) --------------------

# Off by default, same shape as every other deploy-only seam here: the
# laptop app must not need `aws-xray-sdk` at all, and this flag is what
# keeps it from trying. `deploy.sh` sets it only on the real Lambda
# function's environment — never on local-stack.sh's container, which
# runs the identical image OUTSIDE a real Lambda invocation (`docker run`,
# not an actual `Invoke` call). That distinction matters beyond taste:
# the X-Ray SDK expects Lambda's own runtime to have already opened a
# facade SEGMENT for the invocation (it reads that from the
# `_X_AMZN_TRACE_ID` env var Lambda sets), and application code only ever
# opens SUBSEGMENTS under it. Outside a real invocation no such segment
# exists, so turning this on there would mean every request tracing
# against a parent that was never created — flip it under local-stack.sh
# to reproduce that failure mode on purpose, not by accident.
XRAY_ENABLED = _flag("XRAY_ENABLED", False)

# issues.md N42 — the API is reachable at API Gateway's own execute-api URL,
# skipping CloudFront and anything added there. That URL can't be turned
# off without a custom domain, because it is also CloudFront's origin. So
# CloudFront sends this secret as an `X-Origin-Verify` header on every
# request it forwards (deploy.sh sets both ends), and main.py refuses any
# /api/* request that doesn't carry it. Unset — the laptop — checks nothing.
ORIGIN_SECRET = os.getenv("ORIGIN_SECRET") or None
