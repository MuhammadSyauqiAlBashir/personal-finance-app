"""Draw the Financial Management app icon (gradient + rising bars) as PNGs, no dependencies."""
import math
import struct
import sys
import zlib
from pathlib import Path

C1, C2 = (16, 120, 90), (34, 184, 207)  # deep emerald -> teal, diagonal
BARS = [0.20, 0.32, 0.26, 0.46, 0.60]  # rising columns, as a fraction of the icon


def rounded_rect_sd(px, py, cx, cy, hw, hh, r):
    qx, qy = abs(px - cx) - hw + r, abs(py - cy) - hh + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def draw(size):
    bar_w, gap = size * 0.085, size * 0.045
    total = len(BARS) * bar_w + (len(BARS) - 1) * gap
    x0, base = (size - total) / 2, size * 0.74
    bars = []
    for i, h in enumerate(BARS):
        hh = h * size / 2
        bars.append((x0 + i * (bar_w + gap) + bar_w / 2, base - hh, bar_w / 2, hh, i == len(BARS) - 1))
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            glow = max(0.0, 1 - math.hypot(x - size * 0.25, y - size * 0.2) / (size * 0.95)) * 0.22
            r, g, b = (min(255, c1 + (c2 - c1) * t + 255 * glow) for c1, c2 in zip(C1, C2))
            a, gold = 0.0, 0.0
            for cx, cy, hw, hh, last in bars:
                sd = rounded_rect_sd(x + 0.5, y + 0.5, cx, cy, hw, hh, hw * 0.6)
                cov = min(1.0, max(0.0, 0.5 - sd))
                if cov > a:
                    a = cov
                    gold = 1.0 if last else 0.0
            ink = (255, 214, 102) if gold else (255, 255, 255)
            row += bytes(int(round(v * (1 - a) + c * a)) for v, c in zip((r, g, b), ink))
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "web/icons")
    out.mkdir(parents=True, exist_ok=True)
    for s in (180, 192, 512):
        (out / f"icon-{s}.png").write_bytes(draw(s))
        print("wrote", out / f"icon-{s}.png")
