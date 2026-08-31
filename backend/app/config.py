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

# What a Function URL will actually accept, for the check below to test
# against. Not configurable — it is AWS's number, not ours.
LAMBDA_PAYLOAD_LIMIT_BYTES = 6 * 1024 * 1024
BASE64_INFLATION = 4 / 3

RATE_LIMIT_ENABLED = _flag("RATE_LIMIT_ENABLED", True)

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
