#!/usr/bin/env python3
"""Rasterisasi public/assets/logo.svg jadi PNG + ICO multi-ukuran.

Note: sengaja pakai Python stdlib saja supaya bisa dijalankan di mana pun
tanpa ImageMagick / PIL / librsvg. Bukan general SVG renderer — khusus logo
JekInteract yang bentuknya poligon + gradient sederhana.

Jalankan: python3 tools/make-icon.py
"""
import os
import struct
import zlib

SZ = 256
SS = 3  # supersampling per sumbu

# Geometri dari public/assets/logo.svg (viewBox 0 0 64 64)
FRAME = [(16, 3), (61, 3), (61, 48), (48, 61), (3, 61), (3, 16)]
LETTER_J = [(27, 15), (36, 15), (36, 38), (28, 46), (15, 46), (15, 37), (22, 37), (27, 32)]
LETTER_I = [(42, 15), (51, 15), (51, 46), (42, 46)]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def edge_gradient(x, y):
    t = max(0.0, min(1.0, ((x - 3) + (y - 3)) / 116.0))
    c1, c2, c3 = (0x29, 0xF3, 0xFF), (0x8B, 0x5C, 0xFF), (0xFF, 0x2D, 0x8F)
    return lerp(c1, c2, t / 0.55) if t <= 0.55 else lerp(c2, c3, (t - 0.55) / 0.45)


def fill_gradient(y):
    return lerp((0x1A, 0x13, 0x40), (0x09, 0x07, 0x16), max(0.0, min(1.0, y / 64.0)))


def bar_gradient(x):
    return lerp((0x29, 0xF3, 0xFF), (0xFF, 0x2D, 0x8F), max(0.0, min(1.0, (x - 15) / 36.0)))


def inside(poly, x, y):
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def dist_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    norm = dx * dx + dy * dy
    if norm == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / norm))
    return ((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2) ** 0.5


def min_edge_distance(x, y):
    best = 1e9
    for i in range(len(FRAME)):
        ax, ay = FRAME[i]
        bx, by = FRAME[(i + 1) % len(FRAME)]
        d = dist_segment(x, y, ax, ay, bx, by)
        if d < best:
            best = d
    return best


def sample(x, y):
    color = None
    if min_edge_distance(x, y) <= 1.2:
        color = edge_gradient(x, y)
    elif inside(FRAME, x, y):
        color = fill_gradient(y)

    # Lapisan huruf mengikuti urutan SVG: magenta, cyan, putih.
    if inside(LETTER_J, x - 1.6, y - 1) or inside(LETTER_I, x - 1.6, y - 1):
        color = (0xFF, 0x2D, 0x8F)
    if inside(LETTER_J, x + 1.6, y + 1) or inside(LETTER_I, x + 1.6, y + 1):
        color = (0x29, 0xF3, 0xFF)
    if inside(LETTER_J, x, y) or inside(LETTER_I, x, y):
        color = (0xFF, 0xFF, 0xFF)

    if 15 <= x <= 51 and 50 <= y <= 52.2:
        color = bar_gradient(x)
    return color


def render():
    out = []
    for py in range(SZ):
        row = []
        for px in range(SZ):
            r = g = b = hits = 0
            for sy in range(SS):
                y = (py + (sy + 0.5) / SS) * 64.0 / SZ
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) * 64.0 / SZ
                    c = sample(x, y)
                    if c:
                        r += c[0]
                        g += c[1]
                        b += c[2]
                        hits += 1
            if not hits:
                row.append((0, 0, 0, 0))
            else:
                row.append((r // hits, g // hits, b // hits, round(255 * hits / (SS * SS))))
        out.append(row)
    return out


def downsample(src, size):
    dst = []
    for oy in range(size):
        y0 = oy * SZ // size
        y1 = (oy + 1) * SZ // size
        row = []
        for ox in range(size):
            x0 = ox * SZ // size
            x1 = (ox + 1) * SZ // size
            a = r = g = b = 0
            for y in range(y0, y1):
                for x in range(x0, x1):
                    pr, pg, pb, pa = src[y][x]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            n = max(1, (x1 - x0) * (y1 - y0))
            if not a:
                row.append((0, 0, 0, 0))
            else:
                row.append((min(255, r // a), min(255, g // a), min(255, b // a), a // n))
        dst.append(row)
    return dst


def png_bytes(pixels, size):
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for r, g, b, a in row:
            raw.extend((r, g, b, a))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def ico_bytes(images):
    header = struct.pack("<HHH", 0, 1, len(images))
    directory = bytearray()
    offset = 6 + 16 * len(images)
    for size, data in images:
        side = 0 if size == 256 else size
        directory.extend(struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    return header + bytes(directory) + b"".join(data for _, data in images)


def main():
    base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "assets")
    big = render()
    png_path = os.path.join(base, "logo.png")
    ico_path = os.path.join(base, "jekinteract.ico")
    with open(png_path, "wb") as f:
        f.write(png_bytes(big, SZ))
    images = [(SZ, png_bytes(big, SZ))]
    for size in (16, 24, 32, 48, 64, 128):
        images.append((size, png_bytes(downsample(big, size), size)))
    with open(ico_path, "wb") as f:
        f.write(ico_bytes(images))
    print("ditulis:", png_path, ico_path)


if __name__ == "__main__":
    main()
