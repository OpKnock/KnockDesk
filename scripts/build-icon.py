#!/usr/bin/env python3
"""Build the Windows shortcut/installer icon from the source logo.

The source logo is a 1024x1024 canvas with a large transparent margin. Windows
uses the .ico contents as-is for shortcuts, so exporting that canvas makes the
art look undersized at every size. Crop to the visible alpha bounds first, then
emit each frame edge-to-edge.

Frames are written 256-first and use PNG for 256px plus 32-bit BMP entries for
the smaller sizes. That combination is understood by Windows Vista and newer
(including the Explorer shell and NSIS) without relying on Pillow's ICO layout.
"""

from __future__ import annotations

import struct
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image

SIZES = (256, 128, 64, 48, 32, 24, 16)


def square_artwork(source: Path) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        raise SystemExit(f"{source} is fully transparent")
    artwork = image.crop(bbox)

    side = max(artwork.size)
    if artwork.size != (side, side):
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(artwork, ((side - artwork.width) // 2, (side - artwork.height) // 2))
        artwork = canvas
    return artwork


def png_frame(image: Image.Image, size: int) -> bytes:
    frame = image.resize((size, size), Image.Resampling.LANCZOS)
    buffer = BytesIO()
    frame.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def bmp_frame(image: Image.Image, size: int) -> bytes:
    frame = image.resize((size, size), Image.Resampling.LANCZOS)
    pixels = frame.load()

    # ICO stores XOR pixels bottom-up as BGRA, followed by a 1-bit AND mask.
    xor = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            r, g, b, a = pixels[x, y]
            xor += bytes((b, g, r, a))

    mask_row = ((size + 31) // 32) * 4
    and_mask = bytes(mask_row * size)

    header = struct.pack(
        "<IiiHHIIiiII",
        40,          # biSize
        size,        # biWidth
        size * 2,    # biHeight: XOR + AND
        1,           # biPlanes
        32,          # biBitCount
        0,           # biCompression (BI_RGB)
        len(xor) + len(and_mask),
        0, 0, 0, 0,
    )
    return header + bytes(xor) + and_mask


def build_ico(artwork: Image.Image, destination: Path) -> None:
    frames: list[tuple[int, bytes]] = []
    for size in SIZES:
        payload = png_frame(artwork, size) if size == 256 else bmp_frame(artwork, size)
        frames.append((size, payload))

    offset = 6 + 16 * len(frames)
    directory = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    payloads = bytearray()
    for size, payload in frames:
        directory += struct.pack(
            "<BBBBHHII",
            0 if size == 256 else size,
            0 if size == 256 else size,
            0,
            0,
            1,
            32,
            len(payload),
            offset,
        )
        payloads += payload
        offset += len(payload)

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(bytes(directory) + bytes(payloads))


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: build-icon.py SOURCE.png DESTINATION.ico")
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    artwork = square_artwork(source)
    build_ico(artwork, destination)
    print(f"icon: {destination} ({destination.stat().st_size} bytes, art {artwork.width}x{artwork.height})")


if __name__ == "__main__":
    main()
