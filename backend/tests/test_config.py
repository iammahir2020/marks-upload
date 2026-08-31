"""Step 11.1's load-bearing property: **an unset environment is exactly
today's laptop app.**

That property is what makes phase B safe to merge long before any
deployment exists, and it is the kind of thing that silently stops being
true — a default gets "tidied", a regex gets reformatted, and the phone
can no longer reach the backend over the LAN. So it is asserted rather
than trusted.

`config` resolves most values at import, so tests that need a different
environment set the variable and reload the module rather than
monkeypatching attributes — that also exercises the real resolution code
instead of a stand-in for it.
"""
import importlib
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import config, stores  # noqa: E402


@pytest.fixture
def reloaded(monkeypatch):
    """Reload app.config with a given environment, then restore it."""

    def _reload(**env):
        for key, value in env.items():
            if value is None:
                monkeypatch.delenv(key, raising=False)
            else:
                monkeypatch.setenv(key, value)
        return importlib.reload(config)

    yield _reload
    # Order matters, and getting it wrong is silent. `reloaded` is set up
    # after `monkeypatch`, so its finalizer runs FIRST — reloading here
    # without an explicit undo would re-resolve config from the still-
    # patched environment and leak (e.g.) HARVEST_BACKEND=s3 into every
    # later test in the session, which fails nothing here and breaks
    # test_harvest_endpoint.py.
    monkeypatch.undo()
    importlib.reload(config)


# --- The unchanged-default property ---------------------------------------

# The exact regex that shipped before step 11. Written out literally here
# rather than imported, so that editing config.py cannot silently edit the
# thing that is supposed to be checking config.py.
PRE_STEP_11_REGEX = (
    r"^https?://(localhost|127\.0\.0\.1"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})"
    r"(:\d+)?$"
)


def test_cors_regex_is_byte_identical_to_what_shipped_before_step_11():
    assert config.DEFAULT_ALLOWED_ORIGIN_REGEX == PRE_STEP_11_REGEX


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost:5173",
        "https://127.0.0.1:5173",
        "https://192.168.0.104:5173",  # the phone, over the LAN
        "https://10.0.0.7:5173",
        "https://172.20.1.1:5173",
    ],
)
def test_the_default_regex_still_admits_every_origin_the_laptop_needs(origin):
    assert re.match(config.DEFAULT_ALLOWED_ORIGIN_REGEX, origin)


@pytest.mark.parametrize(
    "origin",
    ["https://marks.example.com", "https://172.32.0.1:5173", "https://evil.localhost.example"],
)
def test_the_default_regex_still_rejects_a_public_origin(origin):
    """Rejecting a public domain is correct for the laptop app, and is
    precisely why ALLOWED_ORIGINS has to exist for a hosted one."""
    assert not re.match(config.DEFAULT_ALLOWED_ORIGIN_REGEX, origin)


def test_unset_environment_reproduces_the_laptop_defaults(reloaded):
    cfg = reloaded(
        ALLOWED_ORIGINS=None, HARVEST_BACKEND=None, HARVEST_DIR=None,
        HARVEST_ENABLED=None, HARVEST_BUCKET=None, RECOGNIZER=None,
    )
    assert cfg.allowed_origins() is None  # -> the regex above
    assert cfg.HARVEST_BACKEND == "local"
    assert cfg.HARVEST_ENABLED is True
    assert cfg.RECOGNIZER == "cnn"
    assert cfg.HARVEST_DIR == cfg.BACKEND_DIR / "training_data" / "harvested"


def test_unset_environment_still_builds_a_local_store(reloaded):
    reloaded(HARVEST_BACKEND=None, HARVEST_BUCKET=None)
    store = stores.build_store()
    assert isinstance(store, stores.LocalStore)


# --- The new seams --------------------------------------------------------

def test_allowed_origins_parses_a_comma_separated_list(reloaded):
    cfg = reloaded(ALLOWED_ORIGINS="https://a.example.com, https://b.example.com")
    assert cfg.allowed_origins() == ["https://a.example.com", "https://b.example.com"]


def test_an_all_whitespace_allowlist_falls_back_rather_than_allowing_nothing(reloaded):
    """None and [] mean different things to the caller — None keeps the
    LAN regex, [] would allow no origin at all and silently break every
    client. A blank string is a mistake, not a request to lock everyone
    out."""
    cfg = reloaded(ALLOWED_ORIGINS="  , ,  ")
    assert cfg.allowed_origins() is None


@pytest.mark.parametrize("raw,expected", [
    ("false", False), ("0", False), ("no", False), ("OFF", False),
    ("true", True), ("1", True), ("yes", True), ("On", True),
])
def test_harvest_enabled_accepts_the_spellings_people_type(reloaded, raw, expected):
    assert reloaded(HARVEST_ENABLED=raw).HARVEST_ENABLED is expected


def test_a_typo_in_harvest_enabled_keeps_the_default_rather_than_reading_as_false(reloaded):
    """A misspelled flag silently disabling collection would be found
    weeks later, as an empty bucket."""
    assert reloaded(HARVEST_ENABLED="ture").HARVEST_ENABLED is True


def test_s3_backend_without_a_bucket_fails_loudly(reloaded):
    reloaded(HARVEST_BACKEND="s3", HARVEST_BUCKET=None)
    with pytest.raises(ValueError, match="HARVEST_BUCKET"):
        stores.build_store()
