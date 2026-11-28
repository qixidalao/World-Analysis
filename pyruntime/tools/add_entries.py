#!/usr/bin/env python3
# add_entries.py — 往 APK 里补 Chaquopy 资产/so，并强制 STORED（不压缩）
#
# 为什么不用 .NET ZipArchive：Windows PowerShell 5.1 的 ZipArchive 只有 Deflate，
# CompressionLevel.NoCompression 只是 deflate level 0（compression method 仍是 8），
# 而 Chaquopy 的 AssetFile / Android 的 native lib 直接映射都要求 method=0。
#
# 用法:
#   python add_entries.py --apk build\unsigned.apk --assets build\pyruntime\assets\chaquopy \
#       --libs build\pyruntime\lib\x86_64 --abi x86_64 --out build\unsigned2.apk
import argparse, os, shutil, sys, zipfile

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", required=True)
    ap.add_argument("--assets", required=True)
    ap.add_argument("--libs", required=True)
    ap.add_argument("--abi", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    extra = []  # (apk_name, disk_path)
    for root, _, files in os.walk(a.assets):
        for fn in sorted(files):
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, a.assets).replace("\\", "/")
            extra.append(("assets/chaquopy/" + rel, p))
    for fn in sorted(os.listdir(a.libs)):
        if fn.endswith(".so"):
            extra.append(("lib/%s/%s" % (a.abi, fn), os.path.join(a.libs, fn)))

    names = {n for n, _ in extra}
    count = 0
    with zipfile.ZipFile(a.apk, "r") as src, zipfile.ZipFile(a.out, "w") as dst:
        for info in src.infolist():
            if info.filename in names:
                continue  # 同名（理论上没有）以新文件为准
            data = src.read(info.filename)
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = info.compress_type     # resources.arsc 等保持原样
            zi.external_attr = info.external_attr
            zi.internal_attr = info.internal_attr
            zi.create_system = info.create_system
            dst.writestr(zi, data)
        for name, p in extra:
            zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_STORED
            zi.external_attr = 0o644 << 16
            with open(p, "rb") as f:
                dst.writestr(zi, f.read())
            count += 1
    print("add_entries: %d 个 STORED 条目 -> %s" % (count, a.out))

if __name__ == "__main__":
    main()
