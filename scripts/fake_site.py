#!/usr/bin/env python
"""fake_site.py - 本地假站点，离线跑通 首页/列表/详情/PNG-HLS 整条链路（真机 QA 用）。

用法：
    python scripts\\fake_site.py [--port 8000]
    adb -s 127.0.0.1:16384 reverse tcp:8000 tcp:8000
    App 里新建站点 site=http://127.0.0.1:8000（脚本用内置 demo_site 的源码，把 SITE 换成本地地址）

路由：
    /home /cat /t/* /v/* /s/*   -> fixtures/*.html（/v/ 用 detail.html，/t/ 用 tag.html）
    /api/hls/<id>               -> 302 -> /index.png
    /index.png                  -> 合成 PNG：roUd(flag=1) = zlib(m3u8)
    /seg/<n>.png                -> 合成 PNG：roUd(flag=0) = 真实 TS（fixtures/seg.png 解出来的）
    /img/<name>                 -> fixtures 里的图片（没有就 1x1 png）
"""
from __future__ import annotations

import argparse
import os
import struct
import sys
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "fixtures")

SEG_COUNT = 6
SEG_SECONDS = 4


def ro_ud_png(payload: bytes, flag: int) -> bytes:
    """合成一张只有 roUd 的最小 PNG（IHDR 1x1 + roUd + IEND）。flag=1 表示 payload 先 zlib 压缩。"""
    body = bytes([flag]) + (zlib.compress(payload, 9) if flag == 1 else payload)

    def chunk(typ: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00\x00\x00\x00")
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"roUd", body) + chunk(b"IEND", b"")


def read(name: str, default=b"") -> bytes:
    p = os.path.join(FIX, name)
    if not os.path.exists(p):
        return default
    with open(p, "rb") as f:
        return f.read()


def ts_payload() -> bytes:
    """从 fixtures/seg.png 里解出真实 TS 分片；没有就返回一段占位字节。"""
    raw = read("seg.png")
    if not raw:
        return b"\x47" + b"\x00" * 188 * 100
    i, n = 8, len(raw)
    while i + 12 <= n:
        ln = struct.unpack(">I", raw[i:i + 4])[0]
        typ = raw[i + 4:i + 8]
        if typ == b"roUd":
            ro = raw[i + 8:i + 8 + ln]
            if len(ro) > 1:
                return zlib.decompress(ro[1:]) if ro[0] == 1 else ro[1:]
            break
        if typ == b"IEND":
            break
        i += 12 + ln
    return b"\x47" + b"\x00" * 188 * 100


M3U8_HEAD = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:{td}\n#EXT-X-MEDIA-SEQUENCE:0\n"
M3U8_SEG = "#EXTINF:{d:.3f},\nhttp://127.0.0.1:{port}/seg/{n}.png\n"


def gen_cover(seed: str, w: int = 320, h: int = 200) -> bytes:
    """按 seed 生成一张渐变色封面 PNG（离线 QA 用，避免满屏空白）。"""
    import hashlib
    hv = hashlib.md5(seed.encode("utf-8")).digest()
    r0, g0, b0 = 40 + hv[0] % 120, 40 + hv[1] % 110, 60 + hv[2] % 140
    r1, g1, b1 = min(255, r0 + 60), min(255, g0 + 80), min(255, b0 + 70)
    rows = bytearray()
    for y in range(h):
        rows.append(0)                                  # filter type 0
        t = y / float(max(1, h - 1))
        for x in range(w):
            s = (t + x / float(max(1, w - 1))) / 2.0
            rows += bytes((int(r0 + (r1 - r0) * s), int(g0 + (g1 - g0) * s), int(b0 + (b1 - b0) * s)))
    raw = zlib.compress(bytes(rows), 6)

    def chunk(typ: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


class Handler(BaseHTTPRequestHandler):
    server_version = "FakeRou/1.0"
    port = 8000

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stderr.write("[fake] " + (fmt % args) + "\n")

    def _send(self, code: int, body: bytes, ctype: str, extra=None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _m3u8(self) -> bytes:
        out = [M3U8_HEAD.format(td=SEG_SECONDS)]
        for n in range(SEG_COUNT):
            out.append(M3U8_SEG.format(d=SEG_SECONDS, n=n, port=self.port))
        out.append("#EXT-X-ENDLIST\n")
        return "".join(out).encode()

    def do_HEAD(self):  # noqa: N802
        self.do_GET()

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        p = unquote(u.path)

        if p in ("/", "/home", "/index.html"):
            return self._send(200, read("home.html", b"<html><body>fake home</body></html>"), "text/html; charset=utf-8")
        if p == "/cat":
            return self._send(200, read("cat.html"), "text/html; charset=utf-8")
        if p.startswith("/t/") or p.startswith("/search"):
            return self._send(200, read("tag.html"), "text/html; charset=utf-8")
        if p.startswith("/v/"):
            return self._send(200, read("detail.html"), "text/html; charset=utf-8")
        if p.startswith("/s/"):
            return self._send(200, read("detail.html"), "text/html; charset=utf-8")
        if p.startswith("/api/hls/"):
            self.send_response(302)
            self.send_header("Location", "/index.png")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if p == "/index.png":
            return self._send(200, ro_ud_png(self._m3u8(), 1), "image/png")
        if p.startswith("/seg/"):
            return self._send(200, ro_ud_png(ts_payload(), 0), "image/png")
        if p.startswith("/img/") or p.startswith("/m/") or p.startswith("/cover"):
            name = p
            body = read(os.path.basename(p), b"")
            if body:
                return self._send(200, body, "image/jpeg")
            return self._send(200, gen_cover(p), "image/png")
        return self._send(404, b"not found", "text/plain; charset=utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    Handler.port = args.port
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"[fake] serving fixtures on http://127.0.0.1:{args.port}  (segments={SEG_COUNT}x{SEG_SECONDS}s)")
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
