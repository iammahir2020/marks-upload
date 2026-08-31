"""Step 11.2's storage seam.

`LocalStore` gets real filesystem coverage here and through
`test_harvest.py`. `S3Store` gets one narrow test with `boto3` stubbed,
per the step's own reasoning: everything interesting about it is the key,
and the key is testable without AWS. This suite must never touch the
network or require credentials — same rule as every other test here.
"""
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.stores import CONSTANT_MTIME, LocalStore, S3Store  # noqa: E402


def _a_crop(tmp_path: Path) -> Path:
    src = tmp_path / "crop.png"
    src.write_bytes(b"fake png bytes")
    return src


def test_local_store_writes_the_key_as_a_relative_path(tmp_path):
    """The key IS the local path. That equivalence is what lets
    `aws s3 sync` reproduce the training layout byte for byte."""
    root = tmp_path / "harvested"
    LocalStore(root).put("fac-abc/id_digits/confirmed/7_deadbeef.png", _a_crop(tmp_path))
    written = root / "fac-abc" / "id_digits" / "confirmed" / "7_deadbeef.png"
    assert written.read_bytes() == b"fake png bytes"


def test_local_store_creates_intermediate_directories(tmp_path):
    root = tmp_path / "does" / "not" / "exist"
    LocalStore(root).put("a/b/c/d.png", _a_crop(tmp_path))
    assert (root / "a" / "b" / "c" / "d.png").exists()


def test_local_store_flattens_the_mtime(tmp_path):
    """Step 11.0.2 lives here now that _save delegates to a store — the
    guard against ordering-based re-identification has to survive the
    refactor, not just the original implementation."""
    root = tmp_path / "harvested"
    store = LocalStore(root)
    for i in range(3):
        store.put(f"src/id_digits/confirmed/{i}_{i:032x}.png", _a_crop(tmp_path))
    assert {p.stat().st_mtime for p in root.rglob("*.png")} == {CONSTANT_MTIME}


class _FakeS3Client:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def put_object(self, **kwargs) -> None:
        self.calls.append(kwargs)


@pytest.fixture
def stubbed_boto3(monkeypatch):
    """boto3 isn't installed on the laptop — it's a dependency of the
    deployed path only, which is why S3Store imports it inside __init__.
    Stubbing the module here is what lets this test run anywhere."""
    client = _FakeS3Client()
    fake = types.ModuleType("boto3")
    fake.client = lambda service: client  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "boto3", fake)
    return client


def test_s3_store_prefixes_the_key_and_sends_the_bytes(tmp_path, stubbed_boto3):
    S3Store("my-bucket", "harvested").put("fac-abc/id_digits/confirmed/7_x.png", _a_crop(tmp_path))
    (call,) = stubbed_boto3.calls
    assert call["Bucket"] == "my-bucket"
    assert call["Key"] == "harvested/fac-abc/id_digits/confirmed/7_x.png"
    assert call["Body"] == b"fake png bytes"
    assert call["ContentType"] == "image/png"


def test_s3_store_does_not_double_up_slashes(tmp_path, stubbed_boto3):
    S3Store("my-bucket", "/harvested/").put("a/b.png", _a_crop(tmp_path))
    assert stubbed_boto3.calls[0]["Key"] == "harvested/a/b.png"


def test_s3_store_with_an_empty_prefix_writes_at_the_root(tmp_path, stubbed_boto3):
    S3Store("my-bucket", "").put("a/b.png", _a_crop(tmp_path))
    assert stubbed_boto3.calls[0]["Key"] == "a/b.png"
