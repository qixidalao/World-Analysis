#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""icon_proto.py - 界析 图标方案对比（A/B/C/D 四版），输出 shots/icon-variants.png"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SS = 4
C = 512

BG_TOP = (10, 15, 20)
BG_BOT = (20, 32, 42)
ACCENT = (255, 90, 60)
ACCENT_L = (255, 132, 92)
INK = (236, 242, 247)
FONT_BOLD = r"C:\Windows\Fonts\simhei.ttf"
FONT_YAHEI = r"C:\Windows\Fonts\msyhbd.ttc"


def bg(size):
    img = Image.new("RGB", (1, size), BG_TOP)
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))
    img = img.resize((size, size), Image.BILINEAR).convert("RGBA")
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    r = int(size * 0.60)
    cx, cy = int(size * 0.84), int(size * 0.90)
    gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 90, 60, 42))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.10))
    return Image.alpha_composite(img, glow)


def rounded(img, radius_pct=0.225, circle=False):
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    if circle:
        d.ellipse([0, 0, size - 1, size - 1], fill=255)
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_pct), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def glyph(size, ch, font_path, ratio, fill):
    """居中渲染一个字，返回 RGBA 图层"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    font = ImageFont.truetype(font_path, int(size * ratio))
    d = ImageDraw.Draw(layer)
    bbox = d.textbbox((0, 0), ch, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1]
    d.text((x, y), ch, font=font, fill=fill)
    return layer


def ring(size, r_pct, width_pct, color, dash_gap=False):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    r = size * r_pct
    w = max(2, int(size * width_pct))
    box = [size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r]
    if dash_gap:
        for a in range(0, 360, 12):
            if (a // 12) % 2:
                continue
            d.arc(box, a, a + 12, fill=color, width=w)
    else:
        d.ellipse(box, outline=color, width=w)
    return layer


def variant(kind, size=C * SS):
    img = bg(size)
    if kind == "A":      # 白字 + 橙环
        img = Image.alpha_composite(img, ring(size, 0.355, 0.020, ACCENT + (255,)))
        img = Image.alpha_composite(img, glyph(size, "界", FONT_BOLD, 0.40, INK + (255,)))
    elif kind == "B":    # 橙字 + 白环 + 轨道点
        img = Image.alpha_composite(img, ring(size, 0.355, 0.018, INK + (150,)))
        img = Image.alpha_composite(img, glyph(size, "界", FONT_BOLD, 0.40, ACCENT + (255,)))
        d = ImageDraw.Draw(img)
        r = size * 0.355
        cx, cy = size / 2, size / 2
        import math
        px, py = cx + r * math.cos(math.radians(-38)), cy + r * math.sin(math.radians(-38))
        rr = size * 0.026
        d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=ACCENT_L + (255,))
    elif kind == "C":    # 破环（缺口）+ 白字
        img = Image.alpha_composite(img, ring(size, 0.355, 0.022, ACCENT + (255,), dash_gap=False))
        # 用背景色再盖一段，形成开口
        cut = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        cd = ImageDraw.Draw(cut)
        r = size * 0.40
        cd.arc([size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r], -55, 15, fill=(255, 255, 255, 255),
               width=int(size * 0.07))
        img = Image.alpha_composite(img, glyph(size, "界", FONT_YAHEI, 0.40, INK + (255,)))
    elif kind == "D":    # 白字 + 环 + 右下角播放三角徽标
        img = Image.alpha_composite(img, ring(size, 0.345, 0.017, INK + (135,)))
        img = Image.alpha_composite(img, glyph(size, "界", FONT_YAHEI, 0.39, INK + (255,)))
        d = ImageDraw.Draw(img)
        s = size * 0.115
        bx, by = size * 0.735, size * 0.735
        d.ellipse([bx - s, by - s, bx + s, by + s], fill=(16, 22, 28, 255), outline=ACCENT + (255,), width=int(size * 0.012))
        tri = [(bx - s * 0.30, by - s * 0.42), (bx - s * 0.30, by + s * 0.42), (bx + s * 0.46, by)]
        d.polygon(tri, fill=ACCENT + (255,))
    # 圆角
    out = rounded(img)
    return out.resize((512, 512), Image.LANCZOS)


def main():
    sheet = Image.new("RGBA", (4 * 512 + 5 * 20, 512 + 200), (18, 20, 24, 255))
    x = 20
    for kind in "ABCD":
        v = variant(kind)
        sheet.alpha_composite(v, (x, 20))
        # 小尺寸预览
        sx = x
        for px in (96, 48):
            sheet.alpha_composite(v.resize((px, px), Image.LANCZOS), (sx, 560))
            sx += px + 12
        x += 512 + 20
    out = os.path.join(ROOT, "shots", "icon-variants.png")
    sheet.save(out)
    print("->", out)
    for kind in "ABCD":
        variant(kind).save(os.path.join(ROOT, "shots", "icon-%s.png" % kind))
    print("saved icon-A..D")


if __name__ == "__main__":
    main()
