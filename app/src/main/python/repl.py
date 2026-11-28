# -*- coding: utf-8 -*-
"""repl.py — APK 内 Python 调试命令行（REPL）

App 里的"终端"页调这几个入口：
    execute(src)  -> {"more":bool,"out":str}   执行一条/一段，含多行续行
    run_file(path)-> {"ok":bool,"out":str}     跑脚本文件
    reset()       -> 清空命名空间
    vars_list()   -> 当前变量名列表（调试面板用）
    history()     -> 历史输入
"""
import io, sys, os, code, json, traceback, contextlib

class _S:
    def __init__(self):
        self.ns = {'__name__': '__main__', '__builtins__': __builtins__}
        self.console = code.InteractiveConsole(self.ns)
        self.hist = []
        self.banner = ('Python %s · 解析器内置终端\n'
                       '直接 import pipinst 可用：pipinst.install("requests")\n'
                       % sys.version.split()[0])

_s = None
def _st():
    global _s
    if _s is None:
        _s = _S()
        for m in ('pipinst', 'rvcore', 'engine', 'repl'):
            try:
                __import__(m)
                _s.ns[m] = sys.modules[m]
            except Exception:
                pass
    return _s

def execute(src):
    """执行一段代码（多行 OK）。单表达式会打印 repr；以 : 结尾视为未闭合。"""
    st = _st()
    out = io.StringIO()
    more = False
    src_c = (src or '').rstrip('\n')
    if not src_c.strip():
        return json.dumps({'more': False, 'out': ''}, ensure_ascii=False)

    # 只输入了一行且以冒号结尾 → 等缩进块
    lines = src_c.split('\n')
    if len(lines) == 1 and src_c.rstrip().endswith(':'):
        return json.dumps({'more': True, 'out': ''}, ensure_ascii=False)

    try:
        import ast
        tree = ast.parse(src_c)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            if len(tree.body) == 1 and isinstance(tree.body[0], ast.Expr):
                val = eval(compile(ast.Expression(tree.body[0].value), '<app>', 'eval'), st.ns)
                if val is not None:
                    out.write(repr(val) + '\n')
            else:
                exec(compile(src_c, '<app>', 'exec'), st.ns)
    except SyntaxError as e:
        msg = str(e)
        if 'unexpected EOF' in msg or 'was never closed' in msg or 'expecting an indented block' in msg:
            more = True
        else:
            out.write(traceback.format_exc())
    except SystemExit:
        out.write('\n(SystemExit)\n')
    except BaseException:
        out.write(traceback.format_exc())

    if src.strip():
        st.hist.append(src)
    return json.dumps({'more': bool(more), 'out': out.getvalue()}, ensure_ascii=False)

def run_file(path):
    st = _st()
    out = io.StringIO()
    ok = True
    try:
        src = open(path, encoding='utf-8', errors='replace').read()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(compile(src, path, 'exec'), st.ns)
    except BaseException:
        out.write(traceback.format_exc())
        ok = False
    return json.dumps({'ok': ok, 'out': out.getvalue()}, ensure_ascii=False)

def reset():
    global _s
    _s = None
    _st()
    return json.dumps({'ok': True}, ensure_ascii=False)

def vars_list():
    st = _st()
    names = [k for k in st.ns.keys() if not k.startswith('__')]
    return json.dumps({'vars': names}, ensure_ascii=False)

def history():
    return json.dumps({'history': _st().hist[-50:]}, ensure_ascii=False)

def banner():
    return json.dumps({'banner': _st().banner}, ensure_ascii=False)

def installed():
    """终端里 pip 视角的已装包"""
    try:
        import pipinst
        return json.dumps({'ok': True, 'pkgs': pipinst.installed_list()}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)
