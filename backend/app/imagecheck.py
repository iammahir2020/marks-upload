"""Upload gate: what kind of image this is and how big it claims to be,
read from the file's own header — before OpenCV decodes a single pixel.

issues.md N39: a byte cap alone doesn't bound the work. A grid-patterned
PNG compresses to almost nothing while claiming a huge resolution — a
126 KB 10000x10000 upload took 17.5 s of CPU to fail, against ~1.5 s for a
real photo, and detection retried three more rotations of it. The pixel
count has to be checked where it is still just two numbers in a header.

issues.md N47: cv2.imread decodes far more than photos (TIFF, JPEG 2000,
PNM, Sun Raster, HDR, ...), and those native decoders are a historical
source of memory-corruption bugs, for no benefit here: the app's camera
capture is always a JPEG. JPEG and PNG are allowed, by their magic bytes,
and nothing else reaches the decoder.

Pure bytes-in, no OpenCV, so it can run first and cheaply.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
JPEG_SOI = b"\xff\xd8"

# JPEG start-of-frame markers — the segments that carry the image size.
# C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding) are not
# frames, which is why this isn't simply C0..CF.
_JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
# Markers with no length field after them.
_JPEG_STANDALONE = {0x01, 0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9}


@dataclass(frozen=True)
class ImageInfo:
    kind: str  # "jpeg" | "png"
    width: int
    height: int


class UnsupportedImage(ValueError):
    """Not a JPEG or PNG at all."""


class UnreadableImage(ValueError):
    """Claims to be a JPEG or PNG, but its header doesn't hold together."""


def sniff(data: bytes) -> ImageInfo:
    if data.startswith(PNG_SIGNATURE):
        return _png(data)
    if data.startswith(JPEG_SOI):
        return _jpeg(data)
    raise UnsupportedImage("only JPEG and PNG images are accepted")


def _png(data: bytes) -> ImageInfo:
    # The first chunk must be IHDR: length(4) type(4) width(4) height(4).
    if len(data) < 24 or data[12:16] != b"IHDR":
        raise UnreadableImage("PNG has no IHDR header")
    width, height = struct.unpack(">II", data[16:24])
    return ImageInfo("png", width, height)


def _jpeg(data: bytes) -> ImageInfo:
    i = 2
    n = len(data)
    while i < n:
        if data[i] != 0xFF:
            raise UnreadableImage("JPEG marker expected")
        while i < n and data[i] == 0xFF:  # fill bytes before a marker
            i += 1
        if i >= n:
            break
        marker = data[i]
        i += 1
        if marker in _JPEG_STANDALONE:
            if marker == 0xD9:  # end of image before any frame
                break
            continue
        if i + 2 > n:
            break
        (length,) = struct.unpack(">H", data[i:i + 2])
        if length < 2:
            raise UnreadableImage("JPEG segment length is invalid")
        if marker in _JPEG_SOF:
            if i + 7 > n:
                break
            height, width = struct.unpack(">HH", data[i + 3:i + 7])
            return ImageInfo("jpeg", width, height)
        i += length
    raise UnreadableImage("JPEG has no frame header")
