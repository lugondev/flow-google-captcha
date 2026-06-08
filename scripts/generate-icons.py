#!/usr/bin/env python3
"""Flow Helper logo generator.

Renders a circular indigo→blue gradient badge with the wordmark "FH",
matching the side-panel accent gradient (#6366f1 → #3b82f6, 135deg).
Master is drawn at 512px and downscaled with LANCZOS for crisp small icons.

Run:  python3 scripts/generate-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

MASTER = 512
SIZES = [16, 32, 48, 96, 128]
TEXT = "FH"
C1 = (99, 102, 241)   # #6366f1 indigo (top-left)
C2 = (59, 130, 246)   # #3b82f6 blue   (bottom-right)
FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icon")


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def build_master():
    n = MASTER
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))

    # 135deg diagonal gradient (top-left → bottom-right).
    grad = Image.new("RGBA", (n, n))
    px = grad.load()
    denom = 2 * (n - 1)
    for y in range(n):
        for x in range(n):
            t = (x + y) / denom
            px[x, y] = lerp(C1, C2, t) + (255,)

    # Circular mask (slight inset so the edge antialiases cleanly).
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, n - 1, n - 1), fill=255)
    img.paste(grad, (0, 0), mask)

    # Wordmark, optically centered.
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, int(n * 0.46))
    l, t_, r, b = draw.textbbox((0, 0), TEXT, font=font)
    tx = (n - (r - l)) / 2 - l
    ty = (n - (b - t_)) / 2 - t_
    draw.text((tx, ty), TEXT, font=font, fill=(255, 255, 255, 255))
    return img


def main():
    master = build_master()
    for s in SIZES:
        master.resize((s, s), Image.LANCZOS).save(os.path.join(OUT_DIR, f"{s}.png"))
        print(f"wrote {s}.png")


if __name__ == "__main__":
    main()
