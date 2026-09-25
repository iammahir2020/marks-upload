"""Per-IP rate limiting and an upload size cap (step.md step 11.4).

There is no auth on this API and there deliberately is not going to be for
a demo, so these two limits are what stands in for it. Both matter more
once the URL is public than they ever did on a laptop, where the only
client was the instructor's own phone.

**What this is honestly worth.** The counter lives in this process's
memory. On Lambda that means per *container instance*, and concurrent
invocations get separate containers, so a determined attacker spreading
requests across many cold starts is limited far less than the numbers
below suggest. Making it exact would need Redis/DynamoDB — real
infrastructure, real cost, and a shared-state dependency on the request
path — for a free demo whose documented answer to sustained abuse is
"take the URL down" (11.4.3). This stops accidental hammering, a stuck
retry loop, and casual abuse. It is not a defence against a motivated
adversary, and pretending otherwise would be worse than the limit itself.

No new dependency for the same reason: `slowapi` would carry the identical
per-instance limitation on Lambda, so it buys nothing this does not.
"""
from __future__ import annotations

import ipaddress

import time
from collections import defaultdict, deque
from typing import Deque

from starlette.requests import Request


def client_ip(request: Request, source: str = "socket") -> str:
    """The client to charge a request to — from a source that CAN'T be
    forged by the caller, chosen per deployment (config.CLIENT_IP_SOURCE).

    issues.md N41. This used to key on the first X-Forwarded-For entry,
    which is whatever the caller wrote there: CloudFront keeps a
    viewer-sent X-Forwarded-For and only appends the real address after it,
    so a new fake value per request gave an unlimited budget. It is never
    read now, on either path.

    "cloudfront" (the hosted app): CloudFront-Viewer-Address, which
    CloudFront sets itself from the TCP connection ("198.51.100.10:46532")
    and forwards through the managed AllViewerExceptHostHeader policy. It is
    only trustworthy while CloudFront is the ONLY way in — deploy.sh turns
    off API Gateway's direct execute-api URL for exactly that reason (N42).
    Missing or malformed, it falls back to the socket (the proxy's address):
    one shared bucket, which fails safe — throttled, never unlimited.

    "socket" (the laptop, the default): there is no proxy, so the peer
    address IS the client; a forwarded-for header there is just text anyone
    on the Wi-Fi can type.
    """
    if source == "cloudfront":
        viewer = _viewer_address(request.headers.get("cloudfront-viewer-address", ""))
        if viewer:
            return viewer
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _viewer_address(value: str) -> str | None:
    """"198.51.100.10:46532" or "2001:db8::1:46532" -> the IP, dropping the
    source port (a new port per connection would otherwise be a new bucket).
    None for anything that isn't an IP address."""
    host = value.strip().rsplit(":", 1)[0].strip("[]")
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return None


class SlidingWindowLimiter:
    """Fixed request budget over a rolling window, per key.

    A sliding window rather than a fixed calendar-minute bucket, which
    would let a caller spend the whole budget at 11:59:59 and the whole
    budget again at 12:00:00 — twice the intended rate at the boundary,
    exactly when a retry storm is most likely.
    """

    def __init__(self, max_requests: int, window_seconds: float) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, Deque[float]] = defaultdict(deque)

    def check(self, key: str, now: float | None = None) -> float | None:
        """Records a request. Returns None if allowed, or the number of
        seconds until the caller may retry if it is over the limit.

        An over-limit request is NOT recorded. Otherwise a client that
        keeps hammering would keep pushing its own window forward and stay
        locked out indefinitely — a limiter that punishes retrying harder
        than it punishes the original burst.
        """
        now = time.monotonic() if now is None else now
        hits = self._hits[key]

        cutoff = now - self.window_seconds
        while hits and hits[0] <= cutoff:
            hits.popleft()

        if len(hits) >= self.max_requests:
            return max(0.0, hits[0] + self.window_seconds - now)

        hits.append(now)
        return None

    def prune(self, now: float | None = None) -> None:
        """Drops keys with no recent activity, so a long-lived process
        does not accumulate an entry per IP that ever visited. Called on a
        request rather than a timer — there is no scheduler here, and on
        Lambda the container is frozen between invocations anyway."""
        now = time.monotonic() if now is None else now
        cutoff = now - self.window_seconds
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= cutoff]:
            del self._hits[key]
