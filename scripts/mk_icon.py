#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""mk_icon.py — 界析（JieXi · 世界解析器）启动图标

设计：深色圆角底 + 右下暖橙辉光；中央「界」字（黑体），外圈一道**开口的橙色轨道环**，
缺口处一颗小卫星点 —— 寓意「世界（界）被解析（析）」，接口/轨道感也对应可编程解析。

产出：
  mipmap-<density>/ic_launcher.png        旧系统（API<26）完整图标（圆角）
  mipmap-<density>/ic_launcher_round.png  圆形版
  mipmap-xxxhdpi/ic_bg.png                自适应图标背景（108dp 全幅）
  mipmap-xxxhdpi/ic_fg.png                自适应图标前景（108dp，内容在 66dp 安全区内）
  shots/icon-1024.png                     母版
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "app", "src", "main", "res")

SS = 4
C = 512
BG_TOP = (10, 15, 20)
BG_BOT = (21, 33, 43)
ACCENT = (255, 90, 60)
ACCENT_HI = (255, 138, 96)
INK = (237, 243, 248)
SIMHEI = r"C:\Windows\Fonts\simhei.ttf"

# 自适应图标：108dp 画布，内容必须落在中间 66dp
ADAPTIVE = 432              # 108dp @ xxxhdpi
SAFE = 66.0 / 108.0         # 安全区比例


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (1, size), BG_TOP)
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))
    return img.resize((size, size), Image.BILINEAR).convert("RGBA")


def glow(size: int) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    r = size * 0.58
    cx, cy = size * 0.86, size * 0.92
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT + (40,))
    return layer.filter(ImageFilter.GaussianBlur(size * 0.10))


def glyph(size: int, ch: str, ratio: float, fill) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    font = ImageFont.truetype(SIMHEI, int(size * ratio))
    d = ImageDraw.Draw(layer)
    b = d.textbbox((0, 0), ch, font=font)
    w, h = b[2] - b[0], b[3] - b[1]
    d.text(((size - w) / 2 - b[0], (size - h) / 2 - b[1]), ch, font=font, fill=fill)
    return layer


def orbit(size: int, r_pct: float, w_pct: float, gap_deg: float, gap_at: float):
    """开口轨道环 + 缺口处卫星点"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    r = size * r_pct
    w = max(2, int(size * w_pct))
    box = [size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r]
    # PIL 的 arc 角度：0 = 3 点钟方向，顺时针；这里从 12 点起算更直观
    start = gap_at + gap_deg / 2 - 90
    end = gap_at - gap_deg / 2 + 90 + 180
    d.arc(box, start, 360 + gap_at - gap_deg / 2 - 90, fill=ACCENT + (255,), width=w)
    a = math.radians(gap_at - 90)
    x = size / 2 + r * math.cos(a)
    y = size / 2 + r * math.sin(a)
    rr = size * (w_pct * 1.55)
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=ACCENT_HI + (255,))
    return layer


def round_mask(img: Image.Image) -> Image.Image:
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.225), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def circle_mask(img: Image.Image) -> Image.Image:
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def full_icon(canvas: int) -> Image.Image:
    """完整图标（含底、圆角）：界 + 开口轨道环。"""
    size = canvas * SS
    base = Image.alpha_composite(gradient(size), glow(size))
    # 轨道环（开口 26°，缺口在 1 点钟方向）
    base = Image.alpha_composite(base, orbit(size, 0.352, 0.023, 26, 40))
    # 「界」字略小于环内径，留呼吸
    base = Image.alpha_composite(base, glyph(size, "界", 0.365, INK + (255,)))
    return round_mask(base).resize((canvas, canvas), Image.LANCZOS)


def adaptive_bg(canvas: int = ADAPTIVE) -> Image.Image:
    size = canvas * SS
    base = Image.alpha_composite(gradient(size), glow(size))
    return base.resize((canvas, canvas), Image.LANCZOS)


def adaptive_fg(canvas: int = ADAPTIVE) -> Image.Image:
    """前景层：108dp 画布，环+字整体缩到安全区（66dp）内。"""
    size = canvas * SS
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = Image.alpha_composite(inner, orbit(size, 0.44, 0.023, 26, 40))
    inner = Image.alpha_composite(inner, glyph(size, "界", 0.455, INK + (255,)))
    # 缩到安全区：内容半径 0.44*108dp = 47.5dp，安全区半径 33dp → 缩放 0.695
    scale = SAFE * 0.72
    small = inner.resize((int(size * scale), int(size * scale)), Image.LANCZOS)
    off = (size - small.size[0]) // 2
    layer.alpha_composite(small, (off, off))
    return layer.resize((canvas, canvas), Image.LANCZOS)


def main() -> int:
    densities = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    master = full_icon(1024)
    for name, px in densities.items():
        d = os.path.join(RES, "mipmap-" + name)
        os.makedirs(d, exist_ok=True)
        img = master.resize((px, px), Image.LANCZOS)
        img.save(os.path.join(d, "ic_launcher.png"))
        circle_mask(img).save(os.path.join(d, "ic_launcher_round.png"))
        print("[icon] %-8s %dx%d" % (name, px, px))

    # 自适应图标：只有 xxxhdpi 需要清晰度，其它密度让系统缩放
    best = os.path.join(RES, "mipmap-xxxhdpi")
    adaptive_bg().save(os.path.join(best, "ic_bg.png"))
    adaptive_fg().save(os.path.join(best, "ic_fg.png"))
    print("[icon] adaptive bg/fg ->", best)

    shots = os.path.join(ROOT, "shots")
    os.makedirs(shots, exist_ok=True)
    master.save(os.path.join(shots, "icon-1024.png"))

    # 对照图：1024 / 192 / 96 / 48 / 32
    sheet = Image.new("RGBA", (1024 + 192 + 96 + 48 + 32 + 90, 300), (18, 20, 24, 255))
    x = 20
    for px in (1024, 192, 96, 48, 32):
        s = master.resize((px, px), Image.LANCZOS) if px < 1024 else master.resize((256, 256), Image.LANCZOS)
        sheet.alpha_composite(s, (x, 20))
        x += s.size[0] + 14
    sheet.save(os.path.join(shots, "icon-preview.png"))
    print("[icon] master/preview -> shots/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
