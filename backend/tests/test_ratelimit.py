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


def test_a_forwarded_for_header_is_never_trusted_in_either_mode():
    """issues.md N41. The first X-Forwarded-For entry is whatever the caller
    wrote; keying on it gave an unlimited budget to anyone who varied it."""
    req = _request({"x-forwarded-for": "203.0.113.7, 70.1.1.1"})
    assert client_ip(req) == "10.0.0.1"
    assert client_ip(req, "cloudfront") == "10.0.0.1"


def test_cloudfront_mode_keys_on_the_address_cloudfront_wrote():
    req = _request({"cloudfront-viewer-address": "198.51.100.10:46532", "x-forwarded-for": "1.2.3.4"})
    assert client_ip(req, "cloudfront") == "198.51.100.10"


def test_the_source_port_is_dropped_so_new_connections_share_a_bucket():
    a = _request({"cloudfront-viewer-address": "198.51.100.10:1111"})
    b = _request({"cloudfront-viewer-address": "198.51.100.10:2222"})
    assert client_ip(a, "cloudfront") == client_ip(b, "cloudfront")


def test_an_ipv6_viewer_address_is_parsed():
    req = _request({"cloudfront-viewer-address": "2001:db8::1:46532"})
    assert client_ip(req, "cloudfront") == "2001:db8::1"


def test_a_missing_or_malformed_viewer_address_falls_back_to_the_socket():
    """The proxy's own address: one shared bucket — throttled, never unlimited."""
    assert client_ip(_request({}), "cloudfront") == "10.0.0.1"
    assert client_ip(_request({"cloudfront-viewer-address": "evil:80"}), "cloudfront") == "10.0.0.1"


def test_socket_mode_ignores_the_cloudfront_header():
    """On the laptop no CloudFront exists, so anyone on the Wi-Fi could type
    that header; only the connection's own address counts."""
    req = _request({"cloudfront-viewer-address": "198.51.100.10:1"})
    assert client_ip(req) == "10.0.0.1"


def test_an_unknown_ip_source_setting_refuses_to_start(monkeypatch):
    monkeypatch.setenv("CLIENT_IP_SOURCE", "x-forwarded-for")
    with pytest.raises(ValueError):
        importlib.reload(config_module)
    monkeypatch.delenv("CLIENT_IP_SOURCE")
    importlib.reload(config_module)


# --- Endpoint behaviour ----------------------------------------------------

@pytest.fixture
def client(monkeypatch):
    """A fresh limiter per test, so ordering cannot leak a spent budget."""
    monkeypatch.setattr(main_module, "limiter", SlidingWindowLimiter(3, 60))
    monkeypatch.setattr(config_module, "RATE_LIMIT_ENABLED", True)
    # The hosted configuration: the TestClient's socket address is the same
    # for every request, so clients are told apart the way CloudFront does it.
    monkeypatch.setattr(config_module, "CLIENT_IP_SOURCE", "cloudfront")
    return TestClient(main_module.app)


# A real (blank) JPEG. These tests are about the limiter, so any quick,
# non-429 answer will do — a blank page fails fast as "blurry". Arbitrary
# bytes no longer reach the scan at all: they are refused as not-an-image
# (issues.md N47), which would be a different 4xx for the wrong reason.
import cv2  # noqa: E402
import numpy as np  # noqa: E402

TINY_JPEG = cv2.imencode(".jpg", np.full((60, 80, 3), 255, np.uint8))[1].tobytes()


def _scan(client, ip="203.0.113.9", image=TINY_JPEG):
    return client.post(
        "/api/scan",
        files={"image": ("capture.jpg", image, "image/jpeg")},
        data={"config": json.dumps(CONFIG)},
        headers={"cloudfront-viewer-address": f"{ip}:443"},
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


def test_rotating_a_fake_forwarded_for_header_no_longer_escapes_the_limit(client):
    """The audit's actual attack (N40/N41 probe): a new X-Forwarded-For value
    per request, from one real viewer."""
    for i in range(3):
        r = client.post("/api/scan", files={"image": ("c.jpg", TINY_JPEG, "image/jpeg")},
                        data={"config": json.dumps(CONFIG)},
                        headers={"cloudfront-viewer-address": "203.0.113.9:443", "x-forwarded-for": f"10.9.9.{i}"})
        assert r.status_code == 200
    r = client.post("/api/scan", files={"image": ("c.jpg", TINY_JPEG, "image/jpeg")},
                    data={"config": json.dumps(CONFIG)},
                    headers={"cloudfront-viewer-address": "203.0.113.9:443", "x-forwarded-for": "10.9.9.99"})
    assert r.status_code == 429


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
        headers={"cloudfront-viewer-address": "203.0.113.9:443", "origin": "http://localhost:5173"},
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
                "cloudfront-viewer-address": "203.0.113.9:443",
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
