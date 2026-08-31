"""Step 11.4 — the upload cap and per-IP rate limit.

Two layers get tested separately: the limiter as a pure data structure
(fast, exact, no HTTP), and the endpoint behaviour that matters to a
browser (status codes, headers, and the CORS interaction that decides
whether a client sees a real 429 or an opaque failure).
"""
import importlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import config as config_module  # noqa: E402
from app import main as main_module  # noqa: E402
from app.ratelimit import SlidingWindowLimiter, client_ip  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.requests import Request  # noqa: E402

TESTSET = Path(__file__).parent.parent.parent / "testset"

CONFIG = {
    "quizName": "rate limit",
    "idDigits": 7,
    "questions": [{"q": i, "max": 5.0} for i in range(1, 6)],
    "totalMax": 25.0,
}


# --- The limiter itself ----------------------------------------------------

def test_allows_up_to_the_budget_then_refuses():
    limiter = SlidingWindowLimiter(3, 60)
    assert [limiter.check("ip", now=0) for _ in range(3)] == [None, None, None]
    assert limiter.check("ip", now=0) is not None


def test_the_window_slides_rather_than_resetting_on_a_boundary():
    """A fixed calendar-minute bucket would let a caller spend the whole
    budget at 11:59:59 and the whole budget again at 12:00:00 — double the
    intended rate at exactly the moment a retry storm is likeliest."""
    limiter = SlidingWindowLimiter(2, 60)
    limiter.check("ip", now=0)
    limiter.check("ip", now=59)
    assert limiter.check("ip", now=60.5) is None  # the t=0 hit has aged out
    assert limiter.check("ip", now=60.5) is not None  # the t=59 hit has not


def test_an_over_limit_request_is_not_recorded():
    """Otherwise a client that keeps hammering keeps pushing its own
    window forward and stays locked out indefinitely — punishing the retry
    harder than the original burst."""
    limiter = SlidingWindowLimiter(1, 10)
    limiter.check("ip", now=0)
    for t in range(1, 10):          # hammering throughout the window
        assert limiter.check("ip", now=t) is not None
    assert limiter.check("ip", now=10.5) is None  # still recovers on time


def test_limits_are_per_key_not_global():
    limiter = SlidingWindowLimiter(1, 60)
    assert limiter.check("a", now=0) is None
    assert limiter.check("b", now=0) is None


def test_retry_after_counts_down_toward_the_oldest_hit():
    limiter = SlidingWindowLimiter(1, 60)
    limiter.check("ip", now=0)
    assert limiter.check("ip", now=10) == pytest.approx(50)


def test_prune_drops_idle_keys_so_memory_does_not_grow_forever():
    limiter = SlidingWindowLimiter(5, 60)
    for i in range(100):
        limiter.check(f"ip{i}", now=0)
    limiter.prune(now=1000)
    assert limiter._hits == {}


# --- Client identification -------------------------------------------------

def _request(headers: dict[str, str], client=("10.0.0.1", 1234)) -> Request:
    return Request({
        "type": "http",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": client,
    })


def test_client_ip_prefers_the_originating_address_not_the_proxy():
    """Behind a Function URL and CloudFront, request.client.host is the
    proxy — keying on it would put every caller in one bucket and turn the
    limit into a global one."""
    req = _request({"x-forwarded-for": "203.0.113.7, 70.1.1.1, 130.176.1.1"})
    assert client_ip(req) == "203.0.113.7"


def test_client_ip_falls_back_to_the_socket_when_unproxied():
    assert client_ip(_request({})) == "10.0.0.1"


def test_client_ip_ignores_a_blank_forwarded_header():
    assert client_ip(_request({"x-forwarded-for": "  "})) == "10.0.0.1"


# --- Endpoint behaviour ----------------------------------------------------

@pytest.fixture
def client(monkeypatch):
    """A fresh limiter per test, so ordering cannot leak a spent budget."""
    monkeypatch.setattr(main_module, "limiter", SlidingWindowLimiter(3, 60))
    monkeypatch.setattr(config_module, "RATE_LIMIT_ENABLED", True)
    return TestClient(main_module.app)


def _scan(client, ip="203.0.113.9", image=b"not really an image"):
    return client.post(
        "/api/scan",
        files={"image": ("capture.jpg", image, "image/jpeg")},
        data={"config": json.dumps(CONFIG)},
        headers={"x-forwarded-for": ip},
    )


def test_the_fourth_request_from_one_ip_is_refused_with_retry_after(client):
    for _ in range(3):
        assert _scan(client).status_code == 200
    refused = _scan(client)
    assert refused.status_code == 429
    assert int(refused.headers["retry-after"]) >= 1


def test_a_different_ip_is_unaffected_by_a_neighbours_burst(client):
    """Several faculty behind one institutional NAT already share an
    apparent IP; distinct clients must not also share a budget."""
    for _ in range(3):
        _scan(client, ip="203.0.113.9")
    assert _scan(client, ip="198.51.100.4").status_code == 200


def test_a_429_still_carries_cors_headers(client):
    """Without them a browser reports an opaque CORS failure instead of
    the real status, so the frontend can never tell the user to slow down.
    This depends on CORSMiddleware wrapping the guard middleware, which is
    an ordering property of how they are registered — worth pinning."""
    for _ in range(3):
        _scan(client)
    refused = client.post(
        "/api/scan",
        files={"image": ("capture.jpg", b"x", "image/jpeg")},
        data={"config": json.dumps(CONFIG)},
        headers={"x-forwarded-for": "203.0.113.9", "origin": "http://localhost:5173"},
    )
    assert refused.status_code == 429
    assert refused.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_preflights_are_never_rate_limited(client):
    """Browsers send these automatically and they cost nothing to answer.
    Counting them would silently halve an instructor's real budget."""
    for _ in range(20):
        resp = client.options(
            "/api/scan",
            headers={
                "origin": "http://localhost:5173",
                "access-control-request-method": "POST",
                "x-forwarded-for": "203.0.113.9",
            },
        )
        assert resp.status_code == 200


def test_rate_limiting_can_be_turned_off(client, monkeypatch):
    monkeypatch.setattr(config_module, "RATE_LIMIT_ENABLED", False)
    for _ in range(10):
        assert _scan(client).status_code == 200


# --- Upload size cap -------------------------------------------------------

def test_an_oversized_upload_is_refused_with_413(client, monkeypatch):
    monkeypatch.setattr(config_module, "MAX_UPLOAD_BYTES", 1024)
    resp = _scan(client, image=b"x" * 4096)
    assert resp.status_code == 413


def test_a_real_capture_is_comfortably_under_the_default_cap():
    """Measured captures average 166 KB and peak at 807 KB. If a real test
    photo ever exceeds the cap, the cap is wrong — not the photo."""
    importlib.reload(config_module)
    photo = TESTSET / "images" / "filled_file.jpeg"
    if not photo.exists():
        pytest.skip("filled_file.jpeg not present")
    assert photo.stat().st_size < config_module.MAX_UPLOAD_BYTES


def test_the_cap_sits_under_the_lambda_payload_ceiling_after_base64():
    """An oversized request should get a clear 413 from us rather than an
    opaque rejection from the platform.

    The subtlety this pins: Lambda's 6 MB limit applies to the
    **base64-encoded** event payload, not the raw bytes. A Function URL
    base64s the body, inflating it by 4/3 — so comparing the raw cap
    against 6 MB directly (as this test originally did) passes while
    letting through uploads the platform will reject. Confirmed against
    the real runtime emulator: a 67 KB capture became an 89 KB payload."""
    importlib.reload(config_module)
    encoded = config_module.MAX_UPLOAD_BYTES * config_module.BASE64_INFLATION
    assert encoded < config_module.LAMBDA_PAYLOAD_LIMIT_BYTES, (
        f"a max-size upload encodes to {encoded / 1024 / 1024:.2f} MB, over Lambda's "
        f"{config_module.LAMBDA_PAYLOAD_LIMIT_BYTES / 1024 / 1024:.0f} MB payload limit"
    )
