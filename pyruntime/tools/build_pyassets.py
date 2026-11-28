#!/usr/bin/env python3
# build_pyassets.py — 把 Chaquopy 工件组装成 APK 需要的 assets/chaquopy + lib/<abi>
#
# 为什么需要这个脚本：Chaquopy 的 Gradle 插件负责三件事，手工构建链必须自己复刻：
#   1) 把 target/运行时的 .so 分成 jniLibs 和 bootstrap-native（启动期就要用的扩展模块）
#   2) 把 stdlib 打成 assets/chaquopy/stdlib-*.imy（.imy 本质是 zip）
#   3) 生成 assets/chaquopy/build.json（AndroidPlatform 用它做资产解包与缓存校验）
#
# 用法:
#   python pyruntime\tools\build_pyassets.py --vendor pyruntime\vendor \
#       --out build\pyruntime --app app\src\main\python --abi x86_64 --py 3.11
#
# 输出:
#   build\pyruntime\assets\chaquopy\...      -> 打包进 APK 的 assets/chaquopy/
#   build\pyruntime\lib\<abi>\*.so           -> 打包进 APK 的 lib/<abi>/
import argparse, hashlib, json, os, shutil, sys, zipfile

# Gradle 插件 MiscAssetsTask.BOOTSTRAP_NATIVE_STDLIB：
# 这些模块在 AssetFinder 就绪之前就会被 import（ctypes/随机数/压缩等），
# 所以必须解包成真实文件放进 bootstrap-native/<abi>/，不能留在 .imy 里。
BOOTSTRAP_NATIVE = [
    "_bz2", "_ctypes", "_datetime", "_lzma", "_random", "_sha512", "_struct",
    "binascii", "math", "mmap", "zlib",
]

def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def write_zip(path, entries):
    """entries: list[(arcname, bytes|path)]"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, src in entries:
            if isinstance(src, bytes):
                z.writestr(name, src)
            else:
                z.write(src, name)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vendor", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--app", required=True)
    ap.add_argument("--abi", default="x86_64")
    ap.add_argument("--py", default="3.11")
    ap.add_argument("--no-alias", action="store_true", help="不生成兼容命名的重复 .imy（体积更小）")
    a = ap.parse_args()

    v = os.path.abspath(a.vendor)
    out = os.path.abspath(a.out)
    assets = os.path.join(out, "assets", "chaquopy")
    libs = os.path.join(out, "lib", a.abi)
    for d in (assets, libs):
        os.makedirs(d, exist_ok=True)

    def vf(name):
        p = os.path.join(v, name)
        if not os.path.exists(p):
            sys.exit("缺少工件: %s（先跑 pyruntime\\fetch.ps1）" % p)
        return p

    # ---- 1. jniLibs: target 里的 .so + 两个 chaquopy .so ----
    # 版本号由 fetch.ps1 命名；这里按实际文件探测，避免写死
    import glob
    cands = sorted(glob.glob(os.path.join(v, "target-*-%s.zip" % a.abi)))
    # vendor 里可能同时放多个 Python 版本，必须选与 --py 匹配的 target
    pref = "target-%s." % a.py
    pick = [c for c in cands if os.path.basename(c).startswith(pref)]
    if pick:
        cands = pick
    if not cands:
        sys.exit("vendor 下没有 target-*-%s.zip" % a.abi)
    target = cands[0]
    tver = os.path.basename(target)[len("target-"):-len("-%s.zip" % a.abi)]

    with zipfile.ZipFile(target) as z:
        for n in z.namelist():
            if n.startswith("jniLibs/%s/" % a.abi) and n.endswith(".so"):
                data = z.read(n)
                open(os.path.join(libs, os.path.basename(n)), "wb").write(data)
        dyn = [n for n in z.namelist()
               if n.startswith("lib-dynload/%s/" % a.abi) and n.endswith(".so")]

    # 运行时 .so 必须用最终名字：System.loadLibrary("chaquopy_java") / import 时 dlopen("chaquopy.so")
    for src, dst in (("libchaquopy_java-17.2.0-%s-%s.so" % (a.py, a.abi), "libchaquopy_java.so"),
                     ("chaquopy-17.2.0-%s-%s.so" % (a.py, a.abi), "chaquopy.so")):
        p = os.path.join(v, src)
        if not os.path.exists(p):
            sys.exit("缺少运行时 .so: %s" % p)
        shutil.copy2(p, os.path.join(libs, dst))
    # java/__init__.py 第 29 行是 `from .chaquopy import ...`（level=1，即 java.chaquopy），
    # 所以 chaquopy 扩展必须能在 java 包里被找到：放到 bootstrap-native/<abi>/java/ 下。
    javadir = os.path.join(assets, "bootstrap-native", a.abi, "java")
    os.makedirs(javadir, exist_ok=True)
    shutil.copy2(os.path.join(v, "chaquopy-17.2.0-%s-%s.so" % (a.py, a.abi)),
                 os.path.join(javadir, "chaquopy.cpython-%s-%s-linux-android.so" % (
                     a.py.replace(".", ""), "x86_64" if a.abi == "x86_64" else "aarch64")))

    # ---- 2. bootstrap / cacert ----
    shutil.copy2(vf("bootstrap-17.2.0-%s.imy" % a.py), os.path.join(assets, "bootstrap.imy"))
    shutil.copy2(vf("cacert.pem"), os.path.join(assets, "cacert.pem"))

    # ---- 3. stdlib-common.imy = 官方已编译好的 .pyc zip（扁平结构） ----
    shutil.copy2(vf("target-%s-stdlib-pyc.zip" % tver), os.path.join(assets, "stdlib-common.imy"))

    # ---- 4. lib-dynload 拆分：启动期核心模块进 bootstrap-native，其余打包 ----
    with zipfile.ZipFile(target) as z:
        core, rest = [], []
        for n in dyn:
            base = os.path.basename(n)
            stem = base.split(".")[0]
            (core if stem in BOOTSTRAP_NATIVE else rest).append((n, base))
        bn = os.path.join(assets, "bootstrap-native", a.abi)
        os.makedirs(bn, exist_ok=True)
        for n, base in core:
            open(os.path.join(bn, base), "wb").write(z.read(n))
        dyn_entries = [(base, z.read(n)) for n, base in rest]

    write_zip(os.path.join(assets, "stdlib-%s.imy" % a.abi), dyn_entries)
    if not a.no_alias:
        # Chaquopy 17 的 AndroidPlatform.onStart 传的是 "stdlib-<abi>"，
        # 而 AssetFinder 内部会再拼 "-common"/"-<abi>"；这里同时给出两种命名，
        # 避免因版本间命名差异导致 Python.start 直接 FileNotFoundError。
        data = open(os.path.join(assets, "stdlib-%s.imy" % a.abi), "rb").read()
        for alias in ("stdlib-%s-common.imy" % a.abi, "stdlib-%s-%s.imy" % (a.abi, a.abi)):
            open(os.path.join(assets, alias), "wb").write(data)

    # ---- 5. app / requirements：应用 Python 代码 ----
    app_files = []
    appdir = os.path.abspath(a.app)
    for root, _, files in os.walk(appdir):
        for fn in files:
            if fn.endswith(".py"):
                p = os.path.join(root, fn)
                app_files.append((os.path.relpath(p, appdir).replace("\\", "/"), p))
    if not app_files:
        sys.exit("app python 目录里没有 .py: %s" % appdir)
    write_zip(os.path.join(assets, "app-common.imy"), app_files)
    empty = os.path.join(assets, "requirements-common.imy")
    write_zip(empty, [])
    if not a.no_alias:
        shutil.copy2(os.path.join(assets, "app-common.imy"), os.path.join(assets, "app.imy"))
        shutil.copy2(empty, os.path.join(assets, "requirements.imy"))

    # ---- 6. build.json ----
    assets_json = {}
    for root, _, files in os.walk(assets):
        for fn in files:
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, assets).replace("\\", "/")
            assets_json[rel] = sha1(p)
    build = {
        "python_version": a.py,
        "assets": dict(sorted(assets_json.items())),
        "extract_packages": [],
    }
    with open(os.path.join(assets, "build.json"), "w", encoding="utf-8") as f:
        json.dump(build, f, indent=4)

    # ---- 7. 汇总 ----
    print("target version: %s" % tver)
    print("lib/%s: %d 个 .so" % (a.abi, len(os.listdir(libs))))
    for n in sorted(os.listdir(libs)):
        print("   %-40s %9d" % (n, os.path.getsize(os.path.join(libs, n))))
    print("assets/chaquopy:")
    total = 0
    for root, _, files in os.walk(assets):
        for fn in sorted(files):
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, assets).replace("\\", "/")
            sz = os.path.getsize(p); total += sz
            print("   %-46s %9d" % (rel, sz))
    print("assets 合计 %.1f MB, lib 合计 %.1f MB" % (
        total / 1e6, sum(os.path.getsize(os.path.join(libs, f)) for f in os.listdir(libs)) / 1e6))

if __name__ == "__main__":
    main()
