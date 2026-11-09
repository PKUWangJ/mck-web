#!/usr/bin/env python3
"""Generate the PWA PNG icons from the same design as docs/icons/icon.svg.

Run from anywhere:

    python3 scripts/make_icons.py

Requires Pillow: run ``pip install -r scripts/requirements-icons.txt`` first.
No network access and no external assets are used.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

RED = "#8c0000"
WHITE = "#ffffff"
SIZES = (180, 192, 512)

OUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "icons"

# (x, y, width, height, radius) in the 512-unit design grid.
WHITE_RECTS = [
    (64, 64, 160, 160, 24),
    (288, 64, 160, 160, 24),
    (64, 288, 160, 160, 24),
    (288, 288, 32, 32, 4),
    (352, 288, 32, 32, 4),
    (416, 288, 32, 32, 4),
    (320, 320, 32, 32, 4),
    (384, 320, 32, 32, 4),
    (288, 352, 32, 32, 4),
    (352, 352, 32, 32, 4),
    (320, 384, 32, 32, 4),
    (384, 384, 32, 32, 4),
    (352, 416, 32, 32, 4),
    (416, 416, 32, 32, 4),
]

RED_RECTS = [
    (96, 96, 96, 96, 14),
    (320, 96, 96, 96, 14),
    (96, 320, 96, 96, 14),
]

WHITE_DOTS = [
    (128, 128, 32, 32, 4),
    (352, 128, 32, 32, 4),
    (128, 352, 32, 32, 4),
]


def draw_rect(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int, int],
    size: int,
    fill: str,
) -> None:
    x, y, width, height, radius = box
    scale = size / 512
    draw.rounded_rectangle(
        [
            round(x * scale),
            round(y * scale),
            round((x + width) * scale),
            round((y + height) * scale),
        ],
        radius=max(1, round(radius * scale)),
        fill=fill,
    )


def make_icon(size: int) -> Image.Image:
    # Full-bleed square: iOS applies its own rounded mask to touch icons, and
    # Android may mask manifest icons too.
    image = Image.new("RGB", (size, size), RED)
    draw = ImageDraw.Draw(image)
    for rect in WHITE_RECTS:
        draw_rect(draw, rect, size, WHITE)
    for rect in RED_RECTS:
        draw_rect(draw, rect, size, RED)
    for rect in WHITE_DOTS:
        draw_rect(draw, rect, size, WHITE)
    return image


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon-{size}.png"
        make_icon(size).save(path, "PNG", optimize=True)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
