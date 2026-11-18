"""生成「价格监控平台」扩展图标（128/48/32/16）。

设计：电商平台红渐变圆角方块 + 三根升序白色柱（三条业务线 / 价格走势），
16px 下仍然可辨认；纯本地绘制，不依赖任何外部素材。

用法：python tools/build-icons.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

SCALE = 8  # 在 8 倍画布上绘制再缩小，边缘更干净


def lerp(a: int, b: int, t: float) -> int:
    return int(round(a + (b - a) * t))


def draw_icon(size_px: int) -> Image.Image:
    s = size_px * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 背景：圆角方块 + 从左上到右下的电商平台红渐变
    radius = int(s * 0.22)
    top = (255, 90, 74)      # #ff5a4a
    bottom = (186, 21, 27)   # #ba151b
    grad = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / max(1, s - 1)
        gd.line([(0, y), (s, y)], fill=(lerp(top[0], bottom[0], t),
                                       lerp(top[1], bottom[1], t),
                                       lerp(top[2], bottom[2], t), 255))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # 顶部高光：一条很淡的白色内线，让图标不呆板
    hl = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(hl).rounded_rectangle(
        [int(s * 0.06), int(s * 0.045), s - int(s * 0.06), s - int(s * 0.045)],
        radius=int(radius * 0.88), outline=(255, 255, 255, 46), width=max(2, int(s * 0.012)),
    )
    img = Image.alpha_composite(img, hl)
    draw = ImageDraw.Draw(img)

    # 三根升序柱（三条业务线）
    white = (255, 255, 255, 255)
    bar_w = int(s * 0.128)
    gap = int(s * 0.098)
    total = bar_w * 3 + gap * 2
    x0 = (s - total) // 2
    base_y = int(s * 0.775)
    heights = [0.24, 0.36, 0.47]
    for i, h in enumerate(heights):
        x = x0 + i * (bar_w + gap)
        y = base_y - int(s * h)
        draw.rounded_rectangle([x, y, x + bar_w, base_y], radius=bar_w // 2, fill=white)

    # 底部基线与一个青色小点（“监控中”的信号）
    draw.rounded_rectangle(
        [int(s * 0.20), int(s * 0.795), int(s * 0.80), int(s * 0.795) + int(s * 0.022)],
        radius=int(s * 0.011), fill=(255, 255, 255, 165),
    )
    dot_r = int(s * 0.055)
    cx, cy = int(s * 0.845), int(s * 0.165)
    draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=(88, 240, 255, 255))

    return img.resize((size_px, size_px), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (128, 48, 32, 16):
        icon = draw_icon(size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        icon.save(path, "PNG", optimize=True)
        print(f"{path}  {os.path.getsize(path)} bytes  {icon.size}")


if __name__ == "__main__":
    main()
