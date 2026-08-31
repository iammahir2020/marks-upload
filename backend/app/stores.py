"""Where harvested crops go (step.md step 11.2).

Two implementations behind one narrow method. `LocalStore` is today's
laptop behaviour, unchanged and still the default; `S3Store` is the
deployed path, because no free hosting tier offers a persistent disk and
Lambda's filesystem is read-only outside `/tmp` — a crop written under
`backend/` there raises `OSError` on the first scan rather than merely
being lost later.

**The key is the whole design.** It is the exact relative path `LocalStore`
writes today:

    <source-id>/<field>/<confirmed|corrected>/<value>_<uuid>.png

Keeping it identical across both backends is what lets `aws s3 sync`
reproduce the training layout byte for byte, so the fine-tuning code
(plan.md §16) never has to know which backend collected the data.

The interface is deliberately one method. Anything wider — listing,
deleting, reading back — would be inventing requirements; harvesting only
ever appends. Narrow also keeps R2 or any other S3-compatible store a
drop-in later.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Protocol

# Every harvested crop gets this exact mtime instead of its real one
# (step.md 11.0.2). The per-crop uuid4 filename was meant to make one
# student's seven ID digits unlinkable, but it does not on its own: they
# are written in loop order within a single request, so sorting by mtime
# puts them straight back into ID order — 2 of this project's 18 real
# class IDs were recoverable verbatim that way before this was added.
#
# This looks like a bug to a reader who does not know why it is here, so:
# it is defeating ordering-based re-identification, not cosmetics. Do not
# "clean it up". The value itself is arbitrary (1970-01-01T00:00:00Z) —
# only its constancy matters. Guarded by
# test_harvest.py::test_mtime_ordering_cannot_reconstruct_a_student_id.
CONSTANT_MTIME = 0.0


class Store(Protocol):
    """`key` is always the full relative path described above."""

    def put(self, key: str, src: Path) -> None: ...


class LocalStore:
    """Today's behaviour, byte for byte: copy the crop under a root
    directory, then flatten its mtime."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def put(self, key: str, src: Path) -> None:
        import os

        dest = self.root / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        # Stamped here rather than at each call site, so no field added
        # later can forget it — see CONSTANT_MTIME.
        os.utime(dest, (CONSTANT_MTIME, CONSTANT_MTIME))


class S3Store:
    """boto3 `put_object` under a bucket and prefix.

    `boto3` is imported inside `__init__`, not at module level, for the
    same reason the CNN recognizer is imported lazily in `main.py`: the
    laptop path must keep working on a machine that has never installed
    it. It lives in `requirements-deploy.txt` and is installed only into
    the container.

    Note that it genuinely has to be installed there. AWS docs say boto3
    ships with the Lambda runtime, and that is true of the *managed*
    Python runtime — but this deploys a custom container on a plain slim
    base, where nothing is provided. Assuming otherwise cost one build to
    find out.

    There is no mtime to flatten here — S3 stamps its own `LastModified`
    server-side and we cannot set it. That is not a residual to live with:
    measured against a real S3 API, sorting one harvest's ID crops by
    LastModified reproduced the student ID exactly. It is handled in
    `harvest.py`'s `_write_unordered`, which randomises write order so
    arrival time carries no information on any backend. Do not "optimise"
    that back into a straight loop.
    """

    def __init__(self, bucket: str, prefix: str = "harvested") -> None:
        import boto3

        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self._client = boto3.client("s3")

    def put(self, key: str, src: Path) -> None:
        full_key = f"{self.prefix}/{key}" if self.prefix else key
        self._client.put_object(
            Bucket=self.bucket,
            Key=full_key,
            Body=src.read_bytes(),
            ContentType="image/png",
        )


def build_store() -> Store:
    """Resolves the configured backend. Called per request rather than
    once at import so tests and a redeployed environment both see current
    config, and so an S3 misconfiguration surfaces as a failed harvest
    (which is best-effort and swallowed) rather than as a backend that
    will not start at all."""
    from . import config

    if config.HARVEST_BACKEND == "s3":
        if not config.HARVEST_BUCKET:
            raise ValueError("HARVEST_BACKEND=s3 requires HARVEST_BUCKET to be set.")
        return S3Store(config.HARVEST_BUCKET, config.HARVEST_PREFIX)
    return LocalStore(config.HARVEST_DIR)
