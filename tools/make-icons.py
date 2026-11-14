#!/usr/bin/env python3
"""Developer tool: draw the app icons in app/icons/ (needs Pillow; not used at runtime).

    python3 tools/make-icons.py

The drawing matches app/icons/icon.svg: a day-rating ring, four fifths full.
"""
import math
import pathlib

from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parent.parent / "app" / "icons"
BG, TRACK, ACCENT, INK = "#131716", "#2B3331", "#56B9A4", "#E6E9E6"
SCALE = 4  # draw large, then downsample for smooth edges


def draw(size, rounded):
    s = size * SCALE
    u = s / 512.0
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=112 * u, fill=BG)
    else:
        d.rectangle([0, 0, s, s], fill=BG)
    c, r, w = 256 * u, 132 * u, 40 * u
    box = [c - r - w / 2, c - r - w / 2, c + r + w / 2, c + r + w / 2]
    d.arc(box, 0, 360, fill=TRACK, width=round(w))
    d.arc(box, -90, -90 + 288, fill=ACCENT, width=round(w))
    for deg in (-90, -90 + 288):  # round line caps
        x, y = c + r * math.cos(math.radians(deg)), c + r * math.sin(math.radians(deg))
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=ACCENT)
    d.ellipse([c - 34 * u, c - 34 * u, c + 34 * u, c + 34 * u], fill=INK)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    draw(192, True).save(OUT / "icon-192.png", optimize=True)
    draw(512, True).save(OUT / "icon-512.png", optimize=True)
    draw(512, False).convert("RGB").save(OUT / "icon-maskable-512.png", optimize=True)
    draw(180, False).convert("RGB").save(OUT / "icon-180.png", optimize=True)
    for f in sorted(OUT.glob("*.png")):
        print(f.name, f.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
