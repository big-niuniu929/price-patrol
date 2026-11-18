#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成插件图标：extension/icons/icon16|48|128.png（深色玻璃底 + 柱状图 + 市占率曲线）。"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "icons"


def draw(size: int) -> Image.Image:
    scale = 8
    w = size * scale
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角渐变底
    radius = int(w * 0.24)
    bg = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bg)
    for y in range(w):
        t = y / max(1, w - 1)
        r = int(15 + (10 - 15) * t)
        g = int(46 + (86 - 46) * t)
        b = int(74 + (99 - 74) * t)
        bd.line([(0, y), (w, y)], fill=(r, g, b, 255))
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, w - 1], radius=radius, fill=255)
    img.paste(bg, (0, 0), mask)

    # 三根柱子（市占率）
    pad = int(w * 0.2)
    base = int(w * 0.74)
    bar_w = int(w * 0.14)
    gap = int(w * 0.09)
    heights = [0.28, 0.42, 0.56]
    colors = [(120, 226, 214, 255), (94, 200, 235, 255), (247, 208, 132, 255)]
    x = pad
    for h, color in zip(heights, colors):
        top = base - int(w * h)
        d.rounded_rectangle([x, top, x + bar_w, base], radius=int(bar_w * 0.28), fill=color)
        x += bar_w + gap

    # 上升折线
    pts = [(int(w * 0.2), int(w * 0.52)), (int(w * 0.38), int(w * 0.42)),
           (int(w * 0.56), int(w * 0.46)), (int(w * 0.78), int(w * 0.24))]
    lw = max(2, int(w * 0.045))
    d.line(pts, fill=(255, 255, 255, 235), width=lw, joint="curve")
    dot = int(w * 0.055)
    d.ellipse([pts[-1][0] - dot, pts[-1][1] - dot, pts[-1][0] + dot, pts[-1][1] + dot],
              fill=(247, 208, 132, 255))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        draw(size).save(OUT / f"icon{size}.png")
        print(f"generated {OUT / f'icon{size}.png'}")


if __name__ == "__main__":
    main()
