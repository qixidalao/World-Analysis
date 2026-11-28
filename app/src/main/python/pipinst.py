# -*- coding: utf-8 -*-
"""pipinst.py — APK 内运行时包管理器（三级检测 + 安装 + 卸载）

Chaquopy 自带的 pip 只在**构建期**跑。运行时安装必须自己实现：
  1) 纯 Python 包   → 从 PyPI 下 *-none-any.whl，解压进私有目录
  2) 带 C 扩展      → 从 Chaquopy 官方仓库下 cpXXX-android_XX_arm64_v8a.whl
  3) 两者都没有     → 只有 sdist，必须电脑交叉编译 → 返回 needs_build + 指南
"""
import json, os, sys, zipfile, urllib.request, urllib.error, shutil, re

PY_VER = '%d%d' % (sys.version_info[0], sys.version_info[1])      # 例 3.13 -> '313'
ANDROID_API = '24'
ABI = 'arm64_v8a'
CHAQUO_IDX = 'https://chaquo.com/pypi-13.1'      # Chaquopy 轮子索引（与插件版本对应）
UA = {'User-Agent': 'RouParser-Installer/1.0'}

# Android: files/pkg ; 桌面测试: /tmp/rvpkg
def pkg_dir():
    base = os.environ.get('ROU_PKG_DIR')
    if base:
        return base
    try:
        from java import jclass
        ctx = jclass('org.rou.parser.AppCtx').get()
        d = ctx.getFilesDir().getAbsolutePath()
        return os.path.join(d, 'pkg')
    except Exception:
        return '/tmp/rvpkg'

def _get(url, timeout=40):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as f:
        return f.read()

def _pypi_meta(pkg):
    d = json.loads(_get('https://pypi.org/pypi/%s/json' % pkg).decode('utf-8', 'replace'))
    return d

def _pick_pure(meta):
    """从 PyPI 当前版本的 urls 里挑 universal wheel"""
    for u in meta.get('urls', []):
        fn = u['filename']
        if fn.endswith('-none-any.whl'):
            return {'kind': 'pure', 'url': u['url'], 'filename': fn,
                    'size': u.get('size', 0)}
    return None

def _pick_android(pkg):
    """在 Chaquopy 索引里找 cp<ver>-android_<api>_<abi>.whl"""
    try:
        html = _get('%s/%s/' % (CHAQUO_IDX, pkg)).decode('utf-8', 'replace')
    except Exception:
        return None
    pat = r'href="[^"]*?/([^"/]*cp%s-android_%s_%s[^"/]*\.whl)' % (PY_VER, ANDROID_API, ABI)
    m = re.search(pat, html)
    if not m:
        pat2 = r'([^"/]*cp%s-android_[^"/]*arm64[^"/]*\.whl)' % PY_VER
        m = re.search(pat2, html)
    if not m:
        return None
    fn = m.group(1)
    return {'kind': 'android', 'url': '%s/%s/%s' % (CHAQUO_IDX, pkg, fn),
            'filename': fn, 'size': 0}

def resolve(pkg, ver=None):
    """三级检测：返回 pure / android / needs_build"""
    try:
        meta = _pypi_meta(pkg if not ver else '%s/%s' % (pkg, ver))
    except Exception as e:
        return {'ok': False, 'pkg': pkg, 'error': 'PyPI 查不到: %s' % e}
    info = meta.get('info', {})
    version = info.get('version', '')

    pure = _pick_pure(meta)
    if pure:
        return {'ok': True, 'pkg': pkg, 'version': version, 'level': 'pure',
                'reason': '纯 Python（universal wheel）',
                'wheel': pure, 'requires': _reqs(info)}

    andr = _pick_android(pkg)
    if andr:
        return {'ok': True, 'pkg': pkg, 'version': version, 'level': 'android',
                'reason': 'Chaquopy 官方预编译轮子（%s）' % andr['filename'],
                'wheel': andr, 'requires': _reqs(info)}

    return {'ok': False, 'pkg': pkg, 'version': version, 'level': 'needs_build',
            'reason': 'PyPI 无 universal wheel，Chaquopy 仓库也无 android 轮子 → 只能从源码编译',
            'guide': BUILD_GUIDE % {'pkg': pkg, 'py': PY_VER, 'api': ANDROID_API, 'abi': ABI}}

def _reqs(info):
    """解析 Requires-Dist，丢掉 extras 和环境不匹配的"""
    out = []
    for r in (info.get('requires_dist') or []):
        if ';' in r:
            cond = r.split(';', 1)[1]
            if 'extra' in cond:
                continue
        name = re.split(r'[<>=!\[; ]', r.strip())[0]
        if name and name not in out:
            out.append(name)
    return out

BUILD_GUIDE = """【%(pkg)s 需要在电脑上预编译】

这个包含 C/C++ 扩展，PyPI 和 Chaquopy 都没有现成的 android 轮子，只能在电脑上交叉编译。

一、准备（一次性）
  1. Android NDK（r25+）  sdkmanager "ndk;25.2.9519653"
  2. Python headers：Chaquopy 的 target python（cp%(py)s）头文件
     位置：~/.gradle/caches/modules-2/files-2.1/com.chaquo.python/runtime.target/*
  3. 我们的 APK 工程（含 chaquopy 插件）

二、编译（在你的电脑工程里）
  在 app/build.gradle 的 chaquopy 块里写：
      pip { install "%(pkg)s" }
  然后 ./gradlew assembleDebug
  Chaquopy 会在构建期用 NDK 自动交叉编译该包，产物打进 APK。

三、如果 Chaquopy 也编不过（少见）
  1. 手动用 NDK clang 交叉编译，产出 libxxx.so
  2. 打一个 wheel：文件名改成 <pkg>-<ver>-cp%(py)s-cp%(py)s-android_%(api)s_%(abi)s.whl
  3. wheel 里放 xxx/*.py + xxx/libxxx.so
  4. 放到电脑本地目录，用 pip { install file:... } 或上传后运行时安装

四、只要纯 Python 部分？
  很多包的核心逻辑是纯 Python，C 扩展只是加速。可以只装 .py 部分（本 App 的
  「仅装纯 Python 部分」按钮会尝试跳过 .so），性能略降但能用。
"""

def install(pkg, ver=None, with_deps=True, pure_only=False, log=None):
    """真正安装：下载 wheel → 解压到私有目录 → 注册到 sys.path"""
    log = log or (lambda *a: None)
    res = resolve(pkg, ver)
    if not res.get('ok'):
        if res.get('level') == 'needs_build' and pure_only:
            log('降级：只尝试拉 sdist 里的纯 py 文件（可能失败）')
            return {'ok': False, 'pkg': pkg, 'level': 'needs_build', 'guide': res.get('guide')}
        return res

    target = os.path.join(pkg_dir(), '%s-%s' % (pkg, res['version']))
    os.makedirs(target, exist_ok=True)
    wheel = res['wheel']
    log('下载 %s (%s)' % (wheel['filename'], res['level']))
    data = _get(wheel['url'])
    tmp = target + '.whl'
    with open(tmp, 'wb') as f:
        f.write(data)
    with zipfile.ZipFile(tmp) as z:
        for name in z.namelist():
            if name.startswith('/') or '..' in name:
                continue
            if pure_only and name.endswith('.so'):
                continue
            z.extract(name, target)
    os.remove(tmp)
    if target not in sys.path:
        sys.path.insert(0, target)
    _mark(pkg, res['version'], target, res['level'])
    log('已安装 %s %s → %s' % (pkg, res['version'], target))

    done = [pkg]
    if with_deps:
        for dep in res.get('requires', []):
            if dep.lower() in ('python',) or dep in done:
                continue
            try:
                sub = install(dep, with_deps=True, log=log)
                if sub.get('ok'):
                    done.append(dep)
                else:
                    log('依赖 %s 跳过（%s）' % (dep, sub.get('level') or sub.get('error')))
            except Exception as e:
                log('依赖 %s 失败: %s' % (dep, e))
    return {'ok': True, 'pkg': pkg, 'version': res['version'],
            'level': res['level'], 'installed': done, 'path': target}

def _mark(pkg, ver, path, level):
    f = os.path.join(pkg_dir(), 'installed.json')
    db = {}
    if os.path.exists(f):
        try: db = json.load(open(f, encoding='utf-8'))
        except Exception: db = {}
    db[pkg] = {'version': ver, 'path': path, 'level': level}
    json.dump(db, open(f, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

def installed_list():
    f = os.path.join(pkg_dir(), 'installed.json')
    if not os.path.exists(f):
        return []
    try:
        db = json.load(open(f, encoding='utf-8'))
    except Exception:
        return []
    out = []
    for k, v in db.items():
        out.append({'pkg': k, **v})
    return out

def uninstall(pkg):
    f = os.path.join(pkg_dir(), 'installed.json')
    if not os.path.exists(f):
        return {'ok': False, 'error': '未安装'}
    db = json.load(open(f, encoding='utf-8'))
    v = db.pop(pkg, None)
    if not v:
        return {'ok': False, 'error': '未安装'}
    shutil.rmtree(v['path'], ignore_errors=True)
    if v['path'] in sys.path:
        sys.path.remove(v['path'])
    json.dump(db, open(f, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return {'ok': True, 'pkg': pkg}

def load_installed():
    """App 启动时调用：把已装包挂回 sys.path"""
    for it in installed_list():
        p = it.get('path')
        if p and os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)
    return len(installed_list())
