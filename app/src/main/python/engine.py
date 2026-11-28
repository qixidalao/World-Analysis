# -*- coding: utf-8 -*-
"""engine.py — 脚本调度层（界析 Python 子系统）

Java 侧（PyBridge）调用入口：
    Python.getInstance().getModule("engine").callAttr("dispatch", script, url, html)
    Python.getInstance().getModule("engine").callAttr("set_user_dir", path)
返回 JSON 字符串（统一契约，Java/JS 都吃这个格式）。

脚本来源优先级：
    1. <user_dir>/<id>.py     用户在 App 里新建/编辑的脚本（filesDir/py）
    2. scripts/<id>.py        随 APK 打包的内置脚本（app.imy）
"""
import json, importlib, importlib.util, os, sys, traceback

_VALID = ('home', 'list', 'detail')

# 用户脚本目录（由 Java 在 Python.start 之后调用 set_user_dir 注入）
USER_DIR = ''
_CONFIGS = {}
_ENTRIES = {}


def set_user_dir(path):
    """设置用户脚本目录（幂等）。返回 JSON。"""
    global USER_DIR
    try:
        USER_DIR = path or ''
        if USER_DIR:
            os.makedirs(USER_DIR, exist_ok=True)
            if USER_DIR not in sys.path:
                sys.path.insert(0, USER_DIR)
        return json.dumps({'ok': True, 'dir': USER_DIR}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)


# ---------------------------------------------------------------------
# 运行时 pip：Java 侧（PipBridge）把 wheel 解压到 <USER_DIR>/site/<pkg>-<ver>/，
# 这里负责把目录挂进 sys.path（安装后立即生效，重启后由 load_site_dirs 恢复）。
# ---------------------------------------------------------------------

def _site_root():
    return os.path.join(USER_DIR, 'site') if USER_DIR else ''


def _preload_native(path):
    """把 wheel 内 chaquopy/lib/*.so 预加载进当前进程（lxml 依赖 libxml2/libxslt）。
    只加载已知顺序，失败不抛错；运行时安装的原生模块需要这一步。"""
    try:
        import ctypes
        root = os.path.join(path, 'chaquopy', 'lib')
        if not os.path.isdir(root):
            return
        for name in ('libxml2.so', 'libxslt.so', 'libexslt.so'):
            p = os.path.join(root, name)
            if os.path.isfile(p):
                try:
                    ctypes.CDLL(p, mode=ctypes.RTLD_GLOBAL)
                except Exception:
                    pass
    except Exception:
        pass


def add_site_dir(path):
    try:
        p = os.path.abspath(path) if path else ''
        if p and os.path.isdir(p):
            _preload_native(p)
            if p not in sys.path:
                sys.path.insert(0, p)
                importlib.invalidate_caches()
        return json.dumps({'ok': True, 'path': p}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)


def remove_site_dir(path):
    try:
        p = os.path.abspath(path) if path else ''
        if p in sys.path:
            sys.path.remove(p)
        importlib.invalidate_caches()
        return json.dumps({'ok': True}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)


def load_site_dirs():
    """启动时把 installed.json 里登记的包目录挂回 sys.path。"""
    n = 0
    try:
        root = _site_root()
        f = os.path.join(root, 'installed.json')
        if root and os.path.isfile(f):
            with open(f, encoding='utf-8') as fp:
                db = json.load(fp)
            if isinstance(db, dict):
                for _k, v in db.items():
                    p = v.get('path') if isinstance(v, dict) else None
                    if p and os.path.isdir(p):
                        _preload_native(p)
                    if p and os.path.isdir(p) and p not in sys.path:
                        sys.path.insert(0, p)
                        n += 1
            importlib.invalidate_caches()
    except Exception:
        pass
    return json.dumps({'ok': True, 'loaded': n, 'site': _site_root()}, ensure_ascii=False)


def _builtin_dir():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scripts')


def _user_path(script):
    if not USER_DIR or not script:
        return ''
    p = os.path.join(USER_DIR, script + '.py')
    return p if os.path.isfile(p) else ''


def set_files(script, payload_json):
    """多文件：把文件写到 USER_DIR/<id>/，返回 ok。"""
    try:
        data = json.loads(payload_json or '{}')
        files = data.get('files') or {}
        entry = data.get('entry') or 'index.py'
        d = os.path.join(USER_DIR, str(script))
        os.makedirs(d, exist_ok=True)
        for name, content in files.items():
            name = os.path.basename(str(name))
            if not name or name.startswith('.'):
                continue
            with open(os.path.join(d, name), 'w', encoding='utf-8') as f:
                f.write(str(content))
        _ENTRIES[str(script)] = entry
        return json.dumps({'ok': True, 'entry': entry}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)

def _load(script):
    """加载脚本模块：用户目录优先，其次内置 scripts 包；每次都重新执行（热更新）。"""
    d = os.path.join(USER_DIR, str(script))
    if os.path.isdir(d):
        entry = _ENTRIES.get(str(script), 'index.py')
        p = os.path.join(d, os.path.basename(entry))
        if not os.path.isfile(p):
            raise ImportError('入口文件不存在: ' + p)
        if d not in sys.path:
            sys.path.insert(0, d)
        modname = 'jxb_dir_' + str(script)
        spec = importlib.util.spec_from_file_location(modname, p)
        if spec is None or spec.loader is None:
            raise ImportError('无法加载用户脚本: ' + p)
        m = importlib.util.module_from_spec(spec)
        sys.modules[modname] = m
        spec.loader.exec_module(m)
        return m
    p = _user_path(script)
    if p:
        modname = 'jxb_user_' + script
        spec = importlib.util.spec_from_file_location(modname, p)
        if spec is None or spec.loader is None:
            raise ImportError('无法加载用户脚本: ' + p)
        m = importlib.util.module_from_spec(spec)
        sys.modules[modname] = m
        spec.loader.exec_module(m)
        return m
    mod = 'scripts.' + script
    if mod in sys.modules:
        m = sys.modules[mod]
        importlib.reload(m)
        return m
    return importlib.import_module(mod)


def list_scripts():
    """列出内置 + 用户脚本（id/name/lang）"""
    out, seen = [], set()
    try:
        for f in sorted(os.listdir(_builtin_dir())):
            if f.endswith('.py') and not f.startswith('_'):
                out.append(f[:-3])
                seen.add(f[:-3])
    except Exception:
        pass
    if USER_DIR and os.path.isdir(USER_DIR):
        for f in sorted(os.listdir(USER_DIR)):
            if f.endswith('.py') and not f.startswith('_') and f[:-3] not in seen:
                out.append(f[:-3])
                seen.add(f[:-3])
    res = []
    for name in out:
        try:
            m = _load(name)
            res.append({'id': name, 'name': getattr(m, 'NAME', name), 'lang': 'py',
                        'user': bool(_user_path(name))})
        except Exception:
            res.append({'id': name, 'name': name + '(加载失败)', 'lang': 'py',
                        'user': bool(_user_path(name))})
    return json.dumps({'ok': True, 'scripts': res, 'userDir': USER_DIR}, ensure_ascii=False)


def home_url(script):
    try:
        m = _load(script)
        return json.dumps({'ok': True, 'url': m.home()}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)


def set_config(script, cfg_json):
    try:
        _CONFIGS[str(script)] = json.loads(cfg_json or '{}')
    except Exception:
        _CONFIGS[str(script)] = {}
    return json.dumps({'ok': True}, ensure_ascii=False)


def config_from_source(src):
    try:
        ns = {}
        exec(compile(str(src or ''), '<config>', 'exec'), ns)
        return json.dumps({'ok': True, 'config': ns.get('CONFIG') or []}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)

def config_of(script):
    try:
        m = _load(script)
        cfg = getattr(m, 'CONFIG', None)
        return json.dumps({'ok': True, 'config': cfg or []}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)

def parse(script, url, html):
    """纯解析：Java/JS 抓页面后把 html 传进来（便于接管 UA/Referer/代理）"""
    try:
        m = _load(script)
        try:
            m.CFG = _CONFIGS.get(str(script), {})
        except Exception:
            pass
        d = m.parse(url, html)
        return json.dumps({'ok': True, 'data': d}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e),
                           'trace': traceback.format_exc()}, ensure_ascii=False)


def fetch_and_parse(script, url):
    """脚本自带抓取（Python 里用自己的网络栈）"""
    try:
        m = _load(script)
        html = m.fetch(url) if hasattr(m, 'fetch') else None
        if html is None:
            import rvcore
            html = rvcore.unfix(rvcore.http_get(url))
        d = m.parse(url, html)
        return json.dumps({'ok': True, 'data': d}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e),
                           'trace': traceback.format_exc()}, ensure_ascii=False)


def detail(script, url, html):
    return parse(script, url, html)


def check(src):
    """语法检查（用于编辑器保存前/语法检查按钮）"""
    try:
        compile(src or '', '<script>', 'exec')
        return json.dumps({'ok': True}, ensure_ascii=False)
    except SyntaxError as e:
        msg = '%s (line %s, col %s)' % (e.msg, e.lineno, e.offset)
        return json.dumps({'ok': False, 'error': msg, 'line': e.lineno}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)


def run_source(src, url, html):
    """直接跑一段脚本源码（编辑器「测试运行」，不必先保存）"""
    try:
        g = {'__name__': 'jxb_inline', '__file__': '<inline>'}
        exec(compile(src or '', '<inline>', 'exec'), g)
        fn = g.get('parse')
        if not callable(fn):
            return json.dumps({'ok': False, 'error': '脚本缺少 parse(url, html) 函数'},
                              ensure_ascii=False)
        d = fn(url, html)
        return json.dumps({'ok': True, 'data': d}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e),
                           'trace': traceback.format_exc()}, ensure_ascii=False)


def unwrap_b64(b64):
    """PNG(roUd) → 返回 m3u8 文本或 base64 的 TS（Java 侧解码）"""
    import base64, rvcore
    try:
        raw = base64.b64decode(b64)
        out = rvcore.unwrap(raw)
        if out is None:
            return json.dumps({'ok': False, 'error': 'no roUd'})
        if out[:7] == b'#EXTM3U' or b'#EXTM3U' in out[:200]:
            return json.dumps({'ok': True, 'kind': 'm3u8',
                               'text': out.decode('utf-8', 'replace')}, ensure_ascii=False)
        return json.dumps({'ok': True, 'kind': 'ts',
                           'b64': base64.b64encode(out).decode()})
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)})


def dispatch(script, url, html=''):
    """统一入口：html 为空则自己抓"""
    if not html:
        return fetch_and_parse(script, url)
    return parse(script, url, html)


# =====================================================================
# 交互式解释器 / 脚本执行（终端 P-09 用）
#   Java: PyBridge.replJson / execFileJson / execCodeJson / replVarsJson
#   全部返回 JSON 字符串；输出用 StringIO 截获（Chaquopy 的 sys.stdout 默认进 logcat）。
# =====================================================================
import codeop
import io
import contextlib
import builtins as _bi

_repl_g = None            # 交互会话命名空间（跨次保留）
_REPL_OUT_MAX = 48000     # 单次输出上限，超出截断（避免一次 print 撑爆桥）
_VALID_VAR_MAX = 200      # 变量面板最多列出多少个

def _new_repl_globals():
    def _rou_hint(*a, **k):
        print('Python REPL 没有 shell 的 rou 命令；请在 shell 提示符下使用 rou py / rou js。')
    return {'__name__': '__console__', '__doc__': None, '__builtins__': _bi, 'rou': _rou_hint}

def repl_reset():
    """清空交互会话命名空间（终端「重置」）。"""
    global _repl_g
    _repl_g = None
    return json.dumps({'ok': True, 'reset': True}, ensure_ascii=False)

def _clip(text, limit=_REPL_OUT_MAX):
    s = '' if text is None else str(text)
    if len(s) <= limit:
        return s
    return s[:limit] + '\n… 输出超过 %d 字符，已截断（完整内容请看日志）' % limit

def _chdir(cwd):
    """切到终端当前工作目录；失败不致命（返回错误串）。"""
    try:
        if cwd and os.path.isdir(cwd):
            os.chdir(cwd)
    except Exception as e:
        return str(e)
    return ''

def _fmt_syntax(e):
    parts = []
    try:
        if e.text:
            parts.append('  File "<repl>", line %s' % e.lineno)
            parts.append('    ' + e.text.rstrip())
            if e.offset:
                parts.append('    ' + ' ' * max(0, int(e.offset) - 1) + '^')
        parts.append('%s: %s' % (type(e).__name__, e.msg))
    except Exception:
        return '%s: %s' % (type(e).__name__, e)
    return '\n'.join(parts)

def repl(code, cwd=''):
    """执行一次交互输入。

    返回 {'more': true}   —— 代码块还没写完（提示符显示 ...）
         {'out','err'}   —— 已执行（out 里已含表达式 repr / print 输出）
         {'exit': true}  —— 用户调用了 exit() / quit()
    """
    global _repl_g
    src = code or ''
    if not src.strip():
        return json.dumps({'ok': True, 'more': False, 'out': '', 'err': ''}, ensure_ascii=False)
    if _repl_g is None:
        _repl_g = _new_repl_globals()
    _chdir(cwd)
    if not src.endswith('\n'):
        src += '\n'
    kind = 'single'
    obj = None
    try:
        obj = codeop.compile_command(src, '<repl>', 'single')
    except SyntaxError as e:
        if 'multiple statements' not in (e.msg or ''):
            return json.dumps({'ok': True, 'more': False, 'out': '',
                               'err': _fmt_syntax(e)}, ensure_ascii=False)
        # 一次贴进来多条语句：退回 exec 模式（不再自动打印表达式）
        kind = 'exec'
        try:
            obj = compile(src, '<repl>', 'exec')
        except SyntaxError as e2:
            return json.dumps({'ok': True, 'more': False, 'out': '',
                               'err': _fmt_syntax(e2)}, ensure_ascii=False)
    except (ValueError, OverflowError) as e:
        return json.dumps({'ok': True, 'more': False, 'out': '',
                           'err': '%s: %s' % (type(e).__name__, e)}, ensure_ascii=False)
    if obj is None:
        return json.dumps({'ok': True, 'more': True}, ensure_ascii=False)

    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(obj, _repl_g)
    except SystemExit:
        return json.dumps({'ok': True, 'more': False, 'kind': kind,
                           'out': _clip(out.getvalue()), 'err': _clip(err.getvalue()),
                           'exit': True}, ensure_ascii=False)
    except BaseException:
        err.write(traceback.format_exc(limit=12))
    return json.dumps({'ok': True, 'more': False, 'kind': kind,
                       'out': _clip(out.getvalue()), 'err': _clip(err.getvalue())},
                      ensure_ascii=False)

def sys_path():
    try:
        return json.dumps({'ok': True, 'items': [str(x) for x in sys.path]}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)

def repl_vars():
    """交互会话里的变量（终端 ƒ 面板）。"""
    out = []
    if _repl_g:
        for k, v in list(_repl_g.items()):
            if k.startswith('__'):
                continue
            try:
                r = repr(v)
            except Exception:
                r = '<repr 失败>'
            if len(r) > 160:
                r = r[:160] + '…'
            out.append({'n': k, 'r': r, 't': type(v).__name__})
            if len(out) >= _VALID_VAR_MAX:
                break
    return json.dumps({'ok': True, 'vars': out}, ensure_ascii=False)

def _run_source(src, filename, argv, cwd):
    """以 __main__ 身份跑一段源码，截获 stdout/stderr，返回退出码。"""
    g = {'__name__': '__main__', '__file__': filename, '__doc__': None, '__builtins__': _bi}
    out, err = io.StringIO(), io.StringIO()
    old_argv = list(sys.argv)
    try:
        old_cwd = os.getcwd()
    except Exception:
        old_cwd = ''
    chdir_err = _chdir(cwd)
    code = 0
    try:
        sys.argv = [filename] + list(argv or [])
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                exec(compile(src, filename, 'exec'), g)
        except SystemExit as e:
            c = e.code
            if isinstance(c, int):
                code = c
            elif c is None:
                code = 0
            else:
                err.write(str(c) + '\n')
                code = 1
        except BaseException:
            err.write(traceback.format_exc(limit=25))
            code = 1
    finally:
        sys.argv = old_argv
        if old_cwd:
            try:
                os.chdir(old_cwd)
            except Exception:
                pass
    return json.dumps({'ok': True, 'code': code, 'out': _clip(out.getvalue()),
                       'err': _clip(err.getvalue()), 'file': filename,
                       'cwdErr': chdir_err}, ensure_ascii=False)

def exec_file(path, argv_json='[]', cwd=''):
    """python <file> [args]：跑磁盘上的 .py 文件。"""
    try:
        if not path or not os.path.isfile(path):
            return json.dumps({'ok': False, 'error': '文件不存在: %s' % path}, ensure_ascii=False)
        with open(path, 'r', encoding='utf-8') as f:
            src = f.read()
        argv = json.loads(argv_json) if argv_json else []
        if not isinstance(argv, list):
            argv = []
        return _run_source(src, os.path.abspath(path), [str(a) for a in argv], cwd)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)

def exec_code(src, argv_json='[]', cwd=''):
    """python -c '<code>'：直接跑一段源码。"""
    try:
        argv = json.loads(argv_json) if argv_json else []
        if not isinstance(argv, list):
            argv = []
        return _run_source(src or '', '<string>', [str(a) for a in argv], cwd)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)
