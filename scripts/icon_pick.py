#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""icon_pick.py - 界析 图标最终候选（A1/A2/A3/B1），对比 192/96/48/32"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SS = 4
C = 512
BG_TOP = (10, 15, 20)
BG_BOT = (21, 33, 43)
ACCENT = (255, 90, 60)
ACCENT_HI = (255, 138, 96)
INK = (237, 243, 248)
SIMHEI = r"C:\Windows\Fonts\simhei.ttf"
YAHEI_B = r"C:\Windows\Fonts\msyhbd.ttc"


def bg(size):
    img = Image.new("RGB", (1, size), BG_TOP)
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))
    img = img.resize((size, size), Image.BILINEAR).convert("RGBA")
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    r = int(size * 0.58)
    gd.ellipse([int(size * 0.84) - r, int(size * 0.90) - r, int(size * 0.84) + r, int(size * 0.90) + r],
               fill=(255, 90, 60, 40))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.10))
    return Image.alpha_composite(img, glow)


def glyph(size, ch, font_path, ratio, fill):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    font = ImageFont.truetype(font_path, int(size * ratio))
    d = ImageDraw.Draw(layer)
    b = d.textbbox((0, 0), ch, font=font)
    w, h = b[2] - b[0], b[3] - b[1]
    d.text(((size - w) / 2 - b[0], (size - h) / 2 - b[1]), ch, font=font, fill=fill)
    return layer


def ring(size, r_pct, w_pct, color, gap=None):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    r = size * r_pct
    w = max(2, int(size * w_pct))
    box = [size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r]
    if gap is None:
        d.ellipse(box, outline=color, width=w)
    else:
        # gap: (中心角度, 宽度角度)，从 12 点方向起算
        a0, aw = gap
        d.arc(box, a0 + aw / 2, a0 - aw / 2 + 360, fill=color, width=w)
    return layer


def badge_dot(img, size, r_pct, deg, rad_pct):
    d = ImageDraw.Draw(img)
    r = size * r_pct
    a = math.radians(deg - 90)
    x = size / 2 + r * math.cos(a)
    y = size / 2 + r * math.sin(a)
    rr = size * rad_pct
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=ACCENT_HI + (255,))
    return img


def rounded(img, r_pct=0.225):
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * r_pct), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def make(kind, size=C * SS):
    img = bg(size)
    if kind == "A1":     # 闭合环 + 黑体界
        img = Image.alpha_composite(img, ring(size, 0.352, 0.023, ACCENT + (255,)))
        img = Image.alpha_composite(img, glyph(size, "界", SIMHEI, 0.365, INK + (255,)))
    elif kind == "A2":   # 开口环 + 轨道点 + 黑体界
        img = Image.alpha_composite(img, ring(size, 0.352, 0.023, ACCENT + (255,), gap=(40, 26)))
        img = badge_dot(img, size, 0.352, 40, 0.028)
        img = Image.alpha_composite(img, glyph(size, "界", SIMHEI, 0.365, INK + (255,)))
    elif kind == "A3":   # 开口环 + 轨道点 + 雅黑界
        img = Image.alpha_composite(img, ring(size, 0.352, 0.023, ACCENT + (255,), gap=(40, 26)))
        img = badge_dot(img, size, 0.352, 40, 0.028)
        img = Image.alpha_composite(img, glyph(size, "界", YAHEI_B, 0.375, INK + (255,)))
    elif kind == "B1":   # 双环（轨道感更强）+ 黑体界
        img = Image.alpha_composite(img, ring(size, 0.362, 0.016, ACCENT + (90,)))
        img = Image.alpha_composite(img, ring(size, 0.322, 0.021, ACCENT + (255,), gap=(40, 26)))
        img = badge_dot(img, size, 0.322, 40, 0.026)
        img = Image.alpha_composite(img, glyph(size, "界", SIMHEI, 0.345, INK + (255,)))
    return rounded(img).resize((512, 512), Image.LANCZOS)


def main():
    kinds = ["A1", "A2", "A3", "B1"]
    cell = 240
    sheet = Image.new("RGBA", (len(kinds) * (cell + 24) + 24, 260 + 240), (16, 18, 22, 255))
    x = 24
    for k in kinds:
        v = make(k)
        sheet.alpha_composite(v.resize((cell, cell), Image.LANCZOS), (x, 24))
        sx = x
        for px in (96, 48, 32):
            sheet.alpha_composite(v.resize((px, px), Image.LANCZOS), (sx, 290))
            sx += px + 10
        x += cell + 24
    out = os.path.join(ROOT, "shots", "icon-final-candidates.png")
    sheet.save(out)
    print("->", out)
    for k in kinds:
        make(k).save(os.path.join(ROOT, "shots", "icon-%s.png" % k))


if __name__ == "__main__":
    main()
