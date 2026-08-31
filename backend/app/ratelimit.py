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

import time
from collections import defaultdict, deque
from typing import Deque

from starlette.requests import Request


def client_ip(request: Request) -> str:
    """The originating client, as well as it can be known.

    Behind a Lambda Function URL and CloudFront, `request.client.host` is
    the *proxy*, so every caller would share one bucket and the limit
    would effectively become global. AWS sets `X-Forwarded-For` with the
    real client first, so that is what we key on.

    This is spoofable — anyone can send an X-Forwarded-For header — which
    would let an attacker evade the limit by varying it. That is accepted
    deliberately: the alternative (keying on the proxy IP) rate-limits
    every legitimate user as though they were one person, which is a
    guaranteed outage rather than a possible evasion. Given the honest
    threat model in this module's docstring, the trade goes this way.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


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
