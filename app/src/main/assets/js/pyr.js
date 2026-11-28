/* pyr.js — Python 运行时门面（Chaquopy / build.ps1 -WithPython 出包时可用）
 *
 * 设计：Java 侧通过反射暴露 Native.py*（见 JsBridge），这里统一包一层 Promise + 错误归一化，
 * 页面/引擎只跟 Py 打交道；没有内置 Python 的包会得到 available()=false，调用方负责降级。
 *
 * API：
 *   Py.available()                 -> boolean（已启动且版本可读）
 *   Py.info(force?)                -> {ok, version, abi, userDir} | {ok:false, err}
 *   Py.versionText()               -> "3.11.17 · x86_64" | ''
 *   Py.eval(code)                  -> {ok, repr, kind} | {ok:false, err}
 *   Py.check(src)                  -> {ok} | {ok:false, err, line}
 *   Py.put(id, src)                -> {ok, path, bytes} | {ok:false, err}
 *   Py.read(id)                    -> {ok, src} | {ok:false, err}
 *   Py.list()                      -> {ok, scripts:[{id,name,lang,user}]}
 *   Py.run(src, url, html)         -> {ok, data} | {ok:false, err}   （编辑器测试运行）
 *   Py.dispatch(site, url, html)   -> {ok, data} | {ok:false, err}   （站点解析）
 */
const Py = {
  _info: null,
  _asked: false,

  native() {
    return (window.Native && typeof window.Native.pyInfo === 'function') ? window.Native : null;
  },

  info(force) {
    if (!force && this._asked) return this._info || { ok: false, err: 'unknown' };
    this._asked = true;
    const n = this.native();
    if (!n) { this._info = { ok: false, err: 'python-not-linked' }; return this._info }
    try {
      const raw = n.pyInfo();
      this._info = JSON.parse(raw || '{}');
      if (this._info && this._info.err === 'python-not-linked') this._info.ok = false;
    } catch (e) {
      this._info = { ok: false, err: 'pyInfo 解析失败: ' + e.message };
    }
    return this._info;
  },

  available() {
    return !!(this.info() || {}).ok;
  },

  versionText() {
    const i = this.info();
    if (!i || !i.ok) return '';
    const v = String(i.version || '').split(' ')[0];
    return v + (i.abi ? ' · ' + i.abi : '');
  },

  /* 统一调用：所有 Native.py* 都是同步返回 JSON 字符串 */
  _raw(name, args) {
    const n = this.native();
    if (!n || typeof n[name] !== 'function') return { ok: false, err: 'python-not-linked' };
    try {
      const out = n[name].apply(n, args);
      const j = JSON.parse(out || '{}');
      if (!j || typeof j.ok !== 'boolean') return { ok: false, err: 'bad-json', raw: out };
      return j;
    } catch (e) {
      return { ok: false, err: e.message || String(e) };
    }
  },

  eval(code) {
    const j = this._raw('pyEval', [String(code == null ? '' : code)]);
    if (j.ok && j.err === 'python-not-linked') return Promise.resolve({ ok: false, err: 'python-not-linked' });
    return Promise.resolve(j);
  },

  check(src) {
    const j = this._raw('pyCheck', [String(src == null ? '' : src)]);
    return Promise.resolve(j);
  },

  put(id, src) {
    const j = this._raw('pyPut', [String(id), String(src == null ? '' : src)]);
    return Promise.resolve(j);
  },

  read(id) {
    const j = this._raw('pyRead', [String(id)]);
    return Promise.resolve(j);
  },

  list() {
    const j = this._raw('pyList', []);
    return Promise.resolve(j);
  },

  run(src, url, html) {
    const j = this._raw('pyRun', [String(src == null ? '' : src), String(url || ''), String(html == null ? '' : html)]);
    if (!j.ok) return Promise.resolve({ ok: false, err: j.err });
    const box = j.data || {};
    if (box.ok === false) return Promise.resolve({ ok: false, err: box.error || '脚本返回失败', trace: box.trace });
    return Promise.resolve({ ok: true, data: box.data });
  },

  reset() {
    const j = this._raw('pyReset', []);
    return Promise.resolve(j);
  },

  /* ---- 终端用：真交互解释器 / 脚本执行 ---- */
  /* repl 返回 {ok, more} 或 {ok, out, err, exit}；cwd 让 os.getcwd() 与终端一致 */
  repl(code, cwd) {
    return Promise.resolve(this._raw('pyRepl', [String(code == null ? '' : code), String(cwd || '')]));
  },
  /* python <file> [args] → {ok, code, out, err} */
  execFile(path, argv, cwd) {
    return Promise.resolve(this._raw('pyExecFile', [String(path || ''),
      JSON.stringify(argv || []), String(cwd || '')]));
  },
  /* python -c 'code' → {ok, code, out, err} */
  execCode(code, argv, cwd) {
    return Promise.resolve(this._raw('pyExecCode', [String(code == null ? '' : code),
      JSON.stringify(argv || []), String(cwd || '')]));
  },
  /* 交互会话变量 [{n,r,t}] */
  vars() {
    return Promise.resolve(this._raw('pyVars', []));
  },

  dispatch(site, url, html) {
    const j = this._raw('pyDispatch', [String(site), String(url || ''), String(html == null ? '' : html)]);
    if (!j.ok) return Promise.resolve({ ok: false, err: j.err });
    const box = j.data || {};
    if (box.ok === false) return Promise.resolve({ ok: false, err: box.error || '解析失败', trace: box.trace });
    return Promise.resolve({ ok: true, data: box.data });
  },
  setConfig(site, cfg) {
    return Promise.resolve(this._raw('pySetConfig', [String(site || ''), JSON.stringify(cfg || {})]));
  },
  config(site) {
    const j = this._raw('pyConfig', [String(site || '')]);
    return (j && typeof j === 'object') ? j : { ok: false, err: String(j) };
  },

  putFiles(site, files, entry) {
    return Promise.resolve(this._raw('pyPutFiles', [String(site || ''), JSON.stringify({ files: files || {}, entry: entry || 'index.py' })]));
  },

  configFromSource(src) {
    return this._raw('pyConfigSrc', [String(src == null ? '' : src)]);
  },

  sysPath() {
    return this._raw('pySysPath', []);
  },

};

window.Py = Py;
