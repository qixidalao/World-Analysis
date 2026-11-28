/* terminal.js — P-09 终端（Android shell / Python / JS 三模式）
 *
 * 以前这里是「JS 控制台 + Python REPL」两个模式，没有工作目录的概念：
 *   - JS 代码跑在 WebView 的页面上下文里，根本没有 cwd；
 *   - Python 跑在应用进程内（Chaquopy），用户脚本目录是 filesDir/py。
 * 现在改成「真实进程的 shell」（不是 Linux 发行版，也不是前端模拟）：
 *   sh  Android shell（/system/bin/setsid /system/bin/sh -c "…"），cwd/env 由本页维护，
 *       管道 |、重定向 >、&&、$VAR、通配符、sh 脚本、ls/cat/grep/find 都是真的；
 *       中断 = 杀掉整个进程组（setsid 起的组）。
 *   py  内置 CPython 3.14（Chaquopy）交互解释器：>>> / ...，exit() 或 Ctrl+D 回 shell；
 *       os.getcwd() 与终端 cwd 同步。
 *   js  WebView 内的 JS 控制台：>，exit 回 shell。
 * 启动目录 = HOME = filesDir/home（TermBridge 创建并写 README.txt）。
 * 没有 Java 桥（桌面预览 / 纯 WebView 包）时 sh 与 py 如实提示不可用，js 仍可用。
 * 另：rou 子命令把 App 的能力直接搬进终端（抓网页 / 跑解析器 / 打开页面 / 执行 py、js）。
 * 契约见 docs/16-终端.md；Java 侧见 app/src/main/java/com/rou/parser/TermBridge.java。 */

App.pages['terminal'] = function (root, params, st) {
  params = params || {};
  var HIST_KEY = 'termHist';
  var CMD_KEY = 'termCmds';
  var MEM_MAX = 4000;      // 输出内存上限（行）
  var SHOW_MAX = 2000;     // 未展开时最多渲染的行数
  var HIST_MAX = 50;       // 历史命令条数（docs/07）
  var PY_MSG = 'Python 运行时未内置（请安装 build.ps1 -WithPython 包）';

  var alive = true;
  var hasTerm = !!(window.Native && typeof window.Native.termRun === 'function');
  var hasPy = !!(window.Native && typeof window.Native.pyInfo === 'function');

  function firstLine(e) {
    var s = (e && (e.message || e)) ? String(e.message || e) : '未知错误';
    return s.split('\n')[0];
  }

  function callJSON(fn, args) {
    try {
      if (!window.Native || typeof window.Native[fn] !== 'function') return { ok: false, err: 'no-bridge' };
      var out = window.Native[fn].apply(window.Native, args || []);
      if (typeof out !== 'string') return { ok: false, err: 'bad-return' };
      return JSON.parse(out || '{}');
    } catch (e) {
      return { ok: false, err: firstLine(e) };
    }
  }

  /* ---------------- 状态（跨页面挂载保留，见 KEEP） ---------------- */
  /* 从终端跳到别的页面再返回时，输出 / cwd / 环境变量 / 正在跑的任务都要还在 */
  var KEEP = window.__termKeep || (window.__termKeep = {
    lines: [], dropped: 0, cwd: '', env: {}, mode: 'sh', job: null, sb: { o: '', e: '' }
  });

  var S = {
    mode: 'sh',            // sh | py | js
    more: false,           // py 缩进块 / 未完成输入
    pyBuf: [],             // py 多行累积
    cwd: KEEP.cwd || '/', home: '/', prevCwd: '',
    env: KEEP.env,         // export 出来的变量
    lines: KEEP.lines, dropped: KEEP.dropped, expanded: false,
    busy: false, job: KEEP.job, _done: null,
    hist: (DB._get(HIST_KEY, []) || []).slice(-HIST_MAX),
    hi: -1, draft: '',
    jsScope: Object.create(null),
    pyChecked: false, pyOK: false, info: null,
    termInfo: null
  };
  if (KEEP.mode === 'js') S.mode = 'js';

  /* ---------------- 骨架 ---------------- */
  root.innerHTML = '';
  root.classList.add('tm-page');

  var tb = UI.topbar({
    title: '终端',
    right: [
      { i: '📁', cls: 'tm-ico', act: 'files' },
      { i: '⋮', cls: 'tm-ico', act: 'more' },
      { i: 'SH', cls: 'tm-badge tm-mode', act: 'mode' }
    ]
  });
  root.appendChild(tb);
  var modeEl = $('[data-act=mode]', tb);
  if (modeEl) {
    modeEl.setAttribute('role', 'button');
    modeEl.setAttribute('tabindex', '0');
    modeEl.setAttribute('aria-label', '切换终端模式');
    modeEl.onclick = function () { showModes() };
    modeEl.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showModes(); }
    };
  }
  var filesBtn = $('[data-act=files]', tb);
  if (filesBtn) filesBtn.onclick = function () { openPanel(); };
  var moreBtn = $('[data-act=more]', tb);
  if (moreBtn) moreBtn.onclick = function () { showMore(); };

  var shell = document.createElement('div');
  shell.className = 'tm-shell';
  var outWrap = document.createElement('div');
  outWrap.className = 'tm-out';
  var term = document.createElement('div');
  term.className = 'term';
  outWrap.appendChild(term);
  shell.appendChild(outWrap);

  var inWrap = document.createElement('div');
  inWrap.className = 'tm-input';
  inWrap.innerHTML = '<span class="tm-ps"></span><b class="tm-live" hidden>●</b>' +
    '<textarea class="tm-ta" spellcheck="false" autocapitalize="off" autocorrect="off" ' +
    'autocomplete="off"></textarea><b class="tm-go" data-go="run" aria-label="运行">⏎</b>';
  shell.appendChild(inWrap);
  root.appendChild(shell);

  var psEl = $('.tm-ps', inWrap);
  var liveEl = $('.tm-live', inWrap);
  var ta = $('textarea', inWrap);
  var goBtn = $('[data-go]', inWrap);

  /* 快捷命令胶囊（常显）+ 手机键盘按键条（输入时显示） */
  var chips = document.createElement('div');
  chips.className = 'tm-chips';
  chips.innerHTML = [
    ['py', 'python'], ['js', 'js'], ['help', 'help'], ['caps', '能力'],
    ['ls', 'ls -l'], ['rou', 'rou'], ['files', '文件'], ['upd', '⟳ 刷新']
  ].map(function (x) {
    return '<b data-chip="' + x[0] + '">' + esc(x[1]) + '</b>';
  }).join('');
  root.appendChild(chips);

  var keys = document.createElement('div');
  keys.className = 'tm-keys';
  keys.innerHTML = [
    ['ctrl', 'Ctrl'], ['shift', 'Shift'], ['alt', 'Alt'], ['fn', 'Fn'],
    ['tab', 'Tab'], ['esc', 'Esc'], ['cc', '^C'], ['cd', '^D'], ['cl', '^L'],
    ['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'],
    ['home', '⇤'], ['end', '⇥'], ['enter', '⏎']
  ].map(function (x) {
    return '<b data-key="' + x[0] + '">' + esc(x[1]) + '</b>';
  }).join('');
  root.appendChild(keys);

  var fnRow = document.createElement('div');
  fnRow.className = 'tm-fnkeys';
  fnRow.innerHTML = Array.apply(null, { length: 12 }).map(function (_, i) {
    return '<b data-fk="' + (i + 1) + '">F' + (i + 1) + '</b>';
  }).join('');
  root.appendChild(fnRow);

  /* 右侧文件面板（覆盖终端内容区，不挡顶栏） */
  var panel = document.createElement('div');
  panel.className = 'tm-files';
  panel.innerHTML =
    '<div class="tm-fhead">' +
      '<b data-fx="close" aria-label="关闭">✕</b>' +
      '<span class="tt">文件</span>' +
      '<b data-fx="jump" aria-label="跳转路径">路径</b>' +
      '<b data-fx="new" aria-label="新建">＋</b>' +
      '<b data-fx="refresh" aria-label="刷新">⟳</b>' +
    '</div>' +
    '<div class="tm-fpath"></div>' +
    '<div class="tm-fquick">' +
      '<b data-fq="home">~</b><b data-fq="root">/</b><b data-fq="system">/system</b>' +
      '<b data-fq="tmp">/data/local/tmp</b><b data-fq="cache">cache</b>' +
    '</div>' +
    '<div class="tm-flist"></div>' +
    '<div class="tm-ffoot" hidden></div>';
  root.appendChild(panel);

  var FP = { open: false, path: '' };

  /* ---------------- 提示符 / 顶栏 / 提示行 ---------------- */
  function shortCwd() {
    var h = S.home || '', c = S.cwd || '/';
    if (h && c === h) return '~';
    if (h && c.indexOf(h + '/') === 0) return '~' + c.slice(h.length);
    if (c.length > 26) {
      var parts = c.split('/').filter(function (x) { return !!x });
      return '…/' + parts.slice(-2).join('/');
    }
    return c;
  }
  function promptText() {
    if (S.mode === 'py') return S.more ? '...' : '>>>';
    if (S.mode === 'js') return '>';
    return shortCwd() + ' $';
  }
  function pyVer() {
    var i = S.info;
    if (!i || !i.ok) return '';
    var v = String(i.version || '').split(/[\s(]/)[0];
    return v || '';
  }

  function syncChrome() {
    if (psEl) psEl.textContent = promptText();
    if (liveEl) {
      if (S.busy) liveEl.removeAttribute('hidden');
      else liveEl.setAttribute('hidden', 'hidden');
    }
    if (modeEl) {
      modeEl.textContent = S.mode === 'py' ? 'PY' : (S.mode === 'js' ? 'JS' : 'SH');
      if (S.mode === 'py') modeEl.classList.add('tm-mode-py');
      else modeEl.classList.remove('tm-mode-py');
      modeEl.title = '当前 ' + (S.mode === 'py' ? 'Python' : S.mode === 'js' ? 'JS' : 'shell') +
        ' 模式 · 点击切换';
    }
    if (ta) {
      ta.placeholder = S.mode === 'py'
        ? 'Python 代码…'
        : S.mode === 'js'
          ? 'JS 代码…'
          : '命令…';
    }
  }

  /* ---------------- 输出 ---------------- */
  var flushTimer = null;
  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; render() }, 0);
  }
  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    render();
  }
  function add(cls, text, prefix) {
    var s = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var arr = s.split('\n');
    for (var i = 0; i < arr.length; i++) {
      S.lines.push({ c: cls || '', p: i === 0 ? (prefix || '') : '', t: arr[i] });
    }
    while (S.lines.length > MEM_MAX) { S.lines.shift(); S.dropped++ }
    KEEP.dropped = S.dropped;
    schedule();
  }
  function echo(src, ps) {
    var pre = ps == null ? promptText() : ps;
    String(src).split('\n').forEach(function (l, i) {
      add('cmd', (i ? '  ' : pre + ' ') + l);
    });
  }
  function render() {
    if (!term) return;
    var stick = term.scrollHeight - (term.scrollTop + term.clientHeight) < 8;
    var list = S.lines, omitted = S.dropped;
    if (!S.expanded && list.length > SHOW_MAX) {
      omitted += list.length - SHOW_MAX;
      list = list.slice(list.length - SHOW_MAX);
    }
    var h = '';
    if (omitted > 0) {
      h += '<div class="tm-fold">… 已省略 ' + omitted + ' 行 <b data-fold>[' +
        (S.expanded ? '收起' : '展开') + ']</b></div>';
    }
    h += list.map(function (l) {
      return '<div class="tm-line ' + l.c + '">' +
        (l.p ? '<span class="tm-pfx">' + esc(l.p) + '</span>' : '') +
        esc(l.t) + '</div>';
    }).join('');
    term.innerHTML = h;
    var f = $('[data-fold]', term);
    if (f) f.onclick = function () { S.expanded = !S.expanded; render() };
    if (stick) term.scrollTop = term.scrollHeight;
  }

  function setBusy(b) {
    if (S.busy === b) return;
    S.busy = b;
    syncChrome();
  }
  function fmtDur(ms) {
    if (ms == null || isNaN(ms)) return '';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
  }

  /* ---------------- 历史 ---------------- */
  function pushHist(src) {
    var s = String(src == null ? '' : src).replace(/\s+$/, '');
    if (!s) return;
    if (S.hist.length && S.hist[S.hist.length - 1] === s) { S.hi = -1; return }
    S.hist.push(s);
    if (S.hist.length > HIST_MAX) S.hist = S.hist.slice(S.hist.length - HIST_MAX);
    S.hi = -1;
    DB._set(HIST_KEY, S.hist);
  }
  function navHist(dir) {
    if (!S.hist.length) return;
    if (S.hi === -1) {
      S.draft = ta.value;
      S.hi = dir < 0 ? S.hist.length - 1 : -1;
      if (S.hi === -1) return;
    } else {
      S.hi += dir;
    }
    if (S.hi >= S.hist.length) {
      S.hi = -1;
      ta.value = S.draft || '';
      caretEnd();
      return;
    }
    if (S.hi < 0) S.hi = 0;
    ta.value = S.hist[S.hi];
    caretEnd();
  }
  function caretEnd() {
    try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) } catch (e) { }
  }

  /* ---------------- 值格式化（JS 控制台） ---------------- */
  function fmtVal(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'string') return v;
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return String(v);
    if (t === 'function') return '[Function ' + ((v.name) || 'anonymous') + ']';
    var s;
    try { s = JSON.stringify(v) } catch (e) { s = undefined }
    if (s === undefined) { try { return String(v) } catch (e2) { return '[无法显示的对象]' } }
    if (s.length > 20000) s = s.slice(0, 20000) + ' …（已截断）';
    return s;
  }
  function stackTop(e, n) {
    var s = (e && e.stack) ? String(e.stack) : firstLine(e);
    return s.split('\n').slice(0, n || 5).join('\n');
  }

  /* ---------------- JS 控制台 ---------------- */
  function termPrint() {
    var arr = Array.prototype.slice.call(arguments).map(fmtVal);
    add('o', arr.join(' '));
    return undefined;
  }
  var GLB = Object.create(null);
  GLB.App = App; GLB.UI = UI; GLB.DB = DB; GLB.Net = Net; GLB.Engine = Engine;
  GLB.Py = window.Py; GLB.Log = Log; GLB.Native = window.Native;
  GLB.$ = $; GLB.$$ = $$; GLB.esc = esc; GLB.fmtSize = fmtSize; GLB.fmtTime = fmtTime;
  GLB.sleep = sleep; GLB.now = now; GLB.uid = uid; GLB.clamp = clamp;
  GLB.log = termPrint; GLB.print = termPrint;
  GLB.addLine = function (t) { add('o', t) };

  function makeScope() {
    var own = S.jsScope;
    return new Proxy(own, {
      has: function () { return true },
      get: function (t, k) {
        if (k === Symbol.unscopables) return undefined;
        if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
        if (Object.prototype.hasOwnProperty.call(GLB, k)) return GLB[k];
        if (k in window) return window[k];
        throw new ReferenceError(String(k) + ' is not defined');
      },
      set: function (t, k, v) { t[k] = v; return true },
      deleteProperty: function (t, k) { delete t[k]; return true }
    });
  }
  function canExpr(s) {
    if (/[{};]\s*$/.test(s)) return false;
    try { new Function('return (async () => (' + s + '\n))();'); return true } catch (e) { return false }
  }
  function buildRunner(src) {
    var lines = String(src).replace(/\s+$/, '').split('\n');
    var last = -1;
    for (var i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { last = i; break } }
    if (last >= 0) {
      var cand = lines[last].trim().replace(/;\s*$/, '');
      if (cand && canExpr(cand)) {
        return {
          body: lines.slice(0, last).join('\n') + '\nreturn (' + cand + '\n);',
          autoExpr: true
        };
      }
    }
    return { body: lines.join('\n'), autoExpr: false };
  }
  /* 返回 true 表示代码没写完，保留输入区 */
  function runJS(src) {
    var built = buildRunner(src);
    var fn;
    try {
      fn = new Function('__S', 'with(__S){ return (async () => {\n' + built.body + '\n})(); }');
    } catch (e) {
      add('err', '语法错误：' + firstLine(e));
      if (/Unexpected end of input|Unterminated|Invalid or unexpected token|missing \) /i.test(String(e.message || ''))) {
        add('hint', '代码似乎没写完，已保留输入区内容');
        return true;
      }
      return false;
    }
    return fn.call(null, makeScope()).then(function (v) {
      if (v !== undefined || built.autoExpr) {
        S.jsScope._ = v;
        if (v !== undefined) add('o', fmtVal(v));
      }
      return false;
    }, function (e) {
      add('err', '异常（堆栈前 5 行）：');
      add('err', stackTop(e, 5));
      return false;
    });
  }

  /* ---------------- shell：执行 + 事件回填 ---------------- */
  var jobSeq = 0;
  function newJobId() { return 't' + (++jobSeq) + Date.now().toString(36); }

  function runShell(cmd) {
    if (!hasTerm) {
      add('err', '没有 Java 桥：shell / Python 都不可用，只能执行 JS（WebView 直连模式）。');
      return Promise.resolve();
    }
    var id = newJobId();
    S.job = id;
    KEEP.job = id;
    SB.o = ''; SB.e = '';
    var r = callJSON('termRun', [id, cmd, S.cwd, JSON.stringify(S.env), 30000]);
    if (!r || !r.ok) {
      S.job = null;
      add('err', '启动失败：' + ((r && r.err) || '未知错误'));
      return Promise.resolve();
    }
    if (r.cwd && r.cwd !== S.cwd) { S.cwd = r.cwd; syncChrome(); }
    setBusy(true);
    return new Promise(function (resolve) { S._done = resolve; });
  }

  /* shell 输出按行拼接：块中间不额外插入空行（chunk 可能把一个行切断） */
  var SB = KEEP.sb;
  function streamAdd(kind, text) {
    var s = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var cls = kind === 'o' ? 'o' : 'err';
    var parts = (SB[kind] + s).split('\n');
    SB[kind] = parts.pop();
    if (parts.length) add(cls, parts.join('\n'));
    if (SB[kind].length > 4000) { add(cls, SB[kind]); SB[kind] = ''; }
  }
  function flushStreams() {
    if (SB.o) { add('o', SB.o); SB.o = ''; }
    if (SB.e) { add('err', SB.e); SB.e = ''; }
  }

  /* Java 推回来的输出：{j:任务,t:'o'|'e'|'x',d:文本,c:退出码,ms,k:是否被杀} */
  var onTermEv = function (e) {
    if (!alive || !e || !S.job || e.j !== S.job) return;
    if (e.t === 'o' || e.t === 'e') {
      streamAdd(e.t, e.d);
      return;
    }
    if (e.t !== 'x') return;
    flushStreams();
    S.job = null;
    KEEP.job = null;
    if (e.k) add('dimx', '[已中断' + (e.ms != null ? ' · ' + fmtDur(e.ms) : '') + ']');
    else if (e.c) {
      add('dimx', '[退出码 ' + e.c + (e.ms != null ? ' · ' + fmtDur(e.ms) : '') + ']');
      if (e.c === 127) add('dimx', 'python / js / rou 是终端内置命令，只能在提示符下直接用，不能放进管道或脚本里。');
    }
    setBusy(false);
    var done = S._done;
    S._done = null;
    if (done) done();
  };
  window.__termEv = onTermEv;

  function interrupt() {
    if (S.job) {
      try { window.Native.termKill(S.job) } catch (e) { }
      add('dimx', '已请求中断（SIGKILL 进程组）');
      flush();
      return;
    }
    if (S.mode === 'py' && S.more) {
      S.more = false;
      S.pyBuf = [];
      add('dimx', '已取消未完成的 Python 输入');
      syncChrome();
      flush();
      return;
    }
    if (S.busy) {
      UI.toast('Python 调用进行中，无法中断');
      return;
    }
    if (ta.value) { ta.value = ''; caretEnd(); }
  }

  /* ---------------- Python ---------------- */
  function pyReady() { return !!(hasPy && S.pyOK); }

  function pySubmit(line) {
    if (!pyReady()) {
      add('err', S.pyChecked ? PY_MSG : 'Python 正在启动，请稍候…');
      return Promise.resolve();
    }
    if (!line.trim() && !S.more) return Promise.resolve();
    S.pyBuf.push(line);
    /* 交互输入：块以空行结束，编译器才能判断结束 */
    var code = S.pyBuf.join('\n') + '\n';
    setBusy(true);
    return Promise.resolve().then(function () { return window.Py.repl(code, S.cwd) }).then(function (r) {
      setBusy(false);
      if (r && r.ok) {
        if (r.more) {
          S.more = true;
          syncChrome();
          return;
        }
        S.more = false;
        S.pyBuf = [];
        if (r.out) add('o', String(r.out).replace(/\n+$/, ''));
        if (r.err) add('err', String(r.err).replace(/\n+$/, ''));
        if (r.exit) leaveMode('已退出 Python 交互（exit）');
      } else {
        S.more = false;
        S.pyBuf = [];
        add('err', 'Python 调用失败：' + ((r && r.err) || '未知错误'));
      }
      syncChrome();
    }, function (e) {
      setBusy(false);
      add('err', 'Python 调用失败：' + firstLine(e));
    });
  }

  function pyRunFile(path, args) {
    var st = callJSON('termStat', [path, S.cwd]);
    if (!st || !st.ok) { add('err', '无法访问：' + path); return Promise.resolve(); }
    if (!st.exists) { add('err', '文件不存在: ' + path); return Promise.resolve(); }
    if (st.dir) { add('err', '这是目录，不是 .py 文件: ' + path); return Promise.resolve(); }
    setBusy(true);
    return Promise.resolve().then(function () {
      return window.Py.execFile(st.abs, args || [], S.cwd);
    }).then(function (r) {
      setBusy(false);
      if (!r || !r.ok) { add('err', '执行失败：' + ((r && r.err) || '未知')); return; }
      if (r.out) add('o', String(r.out).replace(/\n+$/, ''));
      if (r.err) add('err', String(r.err).replace(/\n+$/, ''));
      if (r.code) add('dimx', '[退出码 ' + r.code + ']');
      else add('dimx', '[执行完成 · ' + (r.file || path) + ']');
    }, function (e) {
      setBusy(false);
      add('err', '执行失败：' + firstLine(e));
    });
  }

  function pyRunCode(code, args) {
    setBusy(true);
    return Promise.resolve().then(function () {
      return window.Py.execCode(code, args || [], S.cwd);
    }).then(function (r) {
      setBusy(false);
      if (!r || !r.ok) { add('err', '执行失败：' + ((r && r.err) || '未知')); return; }
      if (r.out) add('o', String(r.out).replace(/\n+$/, ''));
      if (r.err) add('err', String(r.err).replace(/\n+$/, ''));
      if (r.code) add('dimx', '[退出码 ' + r.code + ']');
    }, function (e) {
      setBusy(false);
      add('err', '执行失败：' + firstLine(e));
    });
  }

  /* ---------------- 模式切换 ---------------- */
  function enterMode(next) {
    if (next === S.mode) return;
    if (next === 'py') {
      if (!hasPy) { add('err', PY_MSG + '：当前包没有内置解释器。'); return }
      if (!S.pyChecked) { UI.toast('Python 正在启动，请稍候…'); return }
      if (!S.pyOK) { add('err', PY_MSG + '：可执行 Native.pyInfo() 查看原因。'); return }
      S.mode = 'py';
      S.more = false;
      S.pyBuf = [];
      add('dimx', 'Python ' + (pyVer() || '3.x') + ' 交互解释器（exit() / Ctrl+D 返回 shell，cwd 跟随终端）');
    } else if (next === 'js') {
      S.mode = 'js';
      add('dimx', 'JS 控制台：页面上下文，可直接用 App / UI / DB / Net / Py（exit 返回 shell）');
    } else {
      S.mode = 'sh';
      add('dimx', 'shell：' + (hasTerm ? 'mksh · cwd ' + shortCwd() : '无 Java 桥，命令不可用'));
    }
    syncChrome();
    KEEP.mode = S.mode;
    flush();
    caretEnd();
  }
  function leaveMode(msg) {
    S.mode = 'sh';
    KEEP.mode = 'sh';
    S.more = false;
    S.pyBuf = [];
    if (msg) add('dimx', msg);
    syncChrome();
    flush();
    caretEnd();
  }
  function showModes() {
    var rows = [
      ['sh', 'Shell', hasTerm ? 'Android shell（mksh）· 工作目录 ' + shortCwd() : '无 Java 桥，不可用'],
      ['py', 'Python', hasPy ? (S.pyOK ? 'CPython ' + (pyVer() || '3.x') + ' 交互解释器' : PY_MSG) : PY_MSG],
      ['js', 'JavaScript', 'WebView 页面上下文，可直接操作 App']
    ];
    UI.sheet('<div class="st-grp">终端模式</div>' + rows.map(function (r) {
      return '<div class="row tap" data-m="' + r[0] + '"><div class="t"><div class="nm">' +
        esc(r[1]) + (S.mode === r[0] ? ' <span class="tag">当前</span>' : '') + '</div>' +
        '<div class="ds">' + esc(r[2]) + '</div></div><div class="arw">›</div></div>';
    }).join('') +
      '<div class="st-note">工作目录：<span class="mono">' + esc(S.cwd) + '</span><br>' +
      'HOME 是 App 私有目录（卸载即删），不是设备根目录；/sdcard 需要存储权限。</div>', {
      onOpen: function (pb) {
        $$('[data-m]', pb).forEach(function (el) {
          el.onclick = function () {
            UI.closeSheet();
            enterMode(el.dataset.m);
          };
        });
      }
    });
  }

  /* ---------------- 内置命令 ---------------- */
  var BUILTINS = {
    help: helpCmd, '?': helpCmd,
    clear: clearCmd, cls: clearCmd,
    cd: cdCmd, pwd: pwdCmd,
    export: exportCmd, unset: unsetCmd, env: envCmd,
    exit: exitCmd, quit: exitCmd, logout: exitCmd,
    python: pythonCmd, python3: pythonCmd, py: pythonCmd,
    js: jsCmd, node: jsCmd,
    rou: rouCmd, pip: pipCmd,
    pyinfo: pyInfoCmd, run: runCmd, curl: curlCmd,
    caps: capsCmd, ability: capsCmd,
    files: filesCmd, update: updateCmd, upd: updateCmd,
    cmds: cmdsCmd, fav: cmdsCmd,
    history: histCmd, hist: histCmd,
    reset: resetCmd, vars: varsCmd
  };
  var BUILTIN_NAMES = Object.keys(BUILTINS);

  function filesCmd() { openPanel(); }
  function cmdsCmd() { openCommands(); }

  /* 能力边界：把“能干什么 / 不能干什么”直接放在终端里，避免“真终端”的误解 */
  function capsCmd() {
    add('hint', '这个终端能做什么 / 不能做什么');
    add('dimx', '— 是（真实进程，不是前端模拟）—');
    add('o', '  Android shell：mksh + toybox（ls/cat/grep/find/sed/ps/df/tar…）');
    add('o', '  cwd / 环境变量 / 管道 / 重定向 / && / $VAR / 通配符 / sh 脚本');
    add('o', '  进程组中断（Ctrl+C）、Tab 补全、历史、常用命令、文件面板');
    add('o', '  Python ' + (S.pyOK ? (S.info.version || '内置') : '未内置') + '（REPL + 跑脚本）、JS 控制台');
    add('o', '  rou：走 App 网络栈抓页、跑解析器、打开页面');
    add('dimx', '— 不是（这里没有 Linux 发行版）—');
    add('o', '  没有 bash（是 mksh）、没有 apt/dpkg、没有 rootfs/glibc 用户空间');
    add('o', '  没有 root、没有 systemd、没有 GUI');
    add('o', '  没有 PTY：vi / nano / top / less 等全屏程序不能正常用');
    add('o', '  装不了 Ubuntu（数据目录在真机不可执行 + 无 rootfs，见 docs/17）');
    add('dimx', '— 还能自己扩展 —');
    add('o', '  静态二进制放 files/bin/ 再 chmod +x（能否执行取决于机型/targetSdk）');
    add('o', '  pip install <纯 Python 包>（运行时已接入，落 files/py/site）');
    add('o', '  纯 Python 模块也可以手动放文件里加 sys.path');
    add('o', '  要完整 Linux：Termux + proot-distro，和本 App 并存');
    var ti = S.termInfo || {};
    if (hasTerm) {
      add('dimx', '当前 shell：' + (ti.sh || '/system/bin/sh') + ' · ' + (ti.abi || '?') +
        ' · ' + (S.pyOK ? 'CPython ' + (pyVer() || '3.x') : 'Python 未内置'));
    }
  }

  function splitWords(s) {
    var out = [], cur = '', q = null;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) {
        if (c === q) q = null;
        else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s.charAt(++i);
        else cur += c;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '\\' && i + 1 < s.length) cur += s.charAt(++i);
      else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } }
      else cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }

  function helpCmd() {
    add('hint', '界析终端 · Android shell（mksh）+ Python + JS');
    add('o', '  工作目录 ' + S.cwd);
    add('o', '  HOME     ' + S.home + '（cd ~ 回家）');
    add('dimx', '— shell（默认模式，其余命令都交给 /system/bin/sh）—');
    add('o', '  ls -l / cat f / echo hi > f / mkdir d / rm -r d / df / ps');
    add('o', '  cat a.txt | grep x       管道、重定向、&&、$VAR、通配符都可用');
    add('o', '  sh script.sh            跑脚本（也可 ./script.sh）');
    add('o', '  cd <dir> / cd .. / cd ~ / cd -   切换目录（立即生效）');
    add('o', '  pwd / export A=1 / unset A / env 目录与环境变量');
    add('o', '  Ctrl+C 中断当前命令（杀掉整个进程组）');
    add('dimx', '— 解释器 —');
    add('o', '  python / python3 / py    进入 Python 交互（exit() / Ctrl+D 返回）');
    add('o', '  python t.py arg1         运行脚本（sys.argv 正确）');
    add('o', '  python -c "print(1)"     直接执行');
    add('o', '  js                       进入 JS 控制台（exit 返回）');
    add('o', '  js -e "App.TABS" / js a.js  单次执行 / 跑文件');
    add('dimx', '— 和 App 直连（rou）—');
    add('o', '  rou env                  运行环境（cwd / PATH / ABI / 版本）');
    add('o', '  rou sites                站点清单');
    add('o', '  rou get <url> [-n 800] [-o f]  用 App 网络栈抓取（DoH/代理生效）');
    add('o', '  rou parse <站点id> <url> 跑解析器，打印 JSON');
    add('o', '  rou open <页面>          打开 App 页面（home/browse/fav/mine/settings…）');
    add('o', '  rou py <代码> / rou js <代码>  一次性执行');
    add('o', '  rou ver                  版本 / 设备 / ABI');
    add('dimx', '— 文件面板 —');
    add('o', '  files                    打开右侧文件面板（也可点顶栏 ▤）');
    add('o', '  面板里：目录点进去 · 文件点预览 · 长按有菜单');
    add('o', '    .sh / .py / .js 长按 → 在当前终端执行');
    add('o', '    还能：编辑、复制路径、重命名、删除、新建文件/文件夹');
    add('o', '    软链接显示为「↗ 名字 → 目标」，点进去跟随目标');
    add('o', '    快速跳转：~ / / /system /data/local/tmp / cache');
    add('o', '  系统目录可浏览（只读）；写操作受 App 沙箱限制，会如实报错');
    add('dimx', '— 其它 —');
    add('o', '  clear / help / history / vars / reset / exit');
    add('o', '  pyinfo                     Python 版本 / ABI / userDir');
    add('o', '  pip install/list/uninstall 运行时纯 Python 包（pip help 看用法）');
    add('o', '  caps                       这个终端能做什么 / 不能做什么');
    add('o', '  update                    重新检测运行时（版本随 APK）');
    add('o', '  run <站点id> <url>         等价 rou parse');
    add('o', '  curl <url>                等价 rou get');
    add('dimx', '— 按键 / 手势 —');
    add('o', '  手机：输入时下方按键条 Ctrl / Shift / Alt / Fn / Tab / ^C / ^D / ^L / ↑↓ / ←→ / ⇤⇥ / ⏎');
    add('o', '  Shift：配合 ←→ 选择、Home/End 选区、Tab 插入制表符；Alt：←→ 按词移动、Enter 换行');
    add('o', '  Fn：展开 F1–F12，F1 帮助 · F2 清屏 · F3 历史 · F4 文件 · F5 刷新 · F6 Python · F7 JS · F8 字符表 · F9 更新 · F10 帮助');
    add('o', '  Ctrl 粘滞键：点 Ctrl（高亮）后再按 C/D/L/P/N/U（软件键盘或外接键盘都行）');
    add('o', '  外接键盘：Ctrl+C 中断 · Ctrl+D 退出模式 · Ctrl+L 清屏 · Ctrl+P/N 历史');
    add('o', '  双击终端：常用命令列表（点一下执行，长按编辑/删除，可手动新增）');
    add('o', '  长按输出行：复制 / 加入常用命令 / 填入输入框 / 直接执行');
    add('o', '  Enter 运行 · Shift+Enter 换行 · ↑↓ 历史 · Tab 补全');
    if (!hasTerm) add('err', '注意：当前包没有 Java 桥，shell 与 Python 不可用，只有 JS。');
    else if (!S.pyChecked) add('dimx', 'Python 运行时仍在检测中…');
    else if (!S.pyOK) add('dimx', 'Python 未内置（安装 -WithPython 包后 python 命令可用）。');
  }

  function clearCmd() {
    S.lines.length = 0;
    S.dropped = 0;
    KEEP.dropped = 0;
    S.expanded = false;
    add('dimx', '已清屏（会话状态保留）');
    flush();
  }

  function cdCmd(words) {
    var target = words[1] || '~';
    if (target === '-') target = S.prevCwd || S.home;
    var r = callJSON('termStat', [target, S.cwd]);
    if (!r || !r.ok) {
      add('err', 'cd: 无法访问 ' + target + (r && r.err ? '（' + r.err + '）' : ''));
      return;
    }
    if (!r.exists) { add('err', 'cd: 没有这个目录: ' + target); return; }
    if (!r.dir) { add('err', 'cd: 不是目录: ' + target); return; }
    S.prevCwd = S.cwd;
    S.cwd = r.abs;
    syncChrome();
    if (FP.open) loadPanel(S.cwd);
  }

  function pwdCmd() { add('o', S.cwd); }

  function exportCmd(words) {
    if (words.length < 2) {
      Object.keys(S.env).sort().forEach(function (k) { add('o', 'export ' + k + '=' + S.env[k]) });
      if (!Object.keys(S.env).length) add('dimx', '（没有通过 export 设置的变量）');
      return;
    }
    words.slice(1).forEach(function (w) {
      var i = w.indexOf('=');
      if (i > 0) S.env[w.slice(0, i)] = w.slice(i + 1);
      else if (S.env[w] == null) S.env[w] = '';
    });
  }

  function unsetCmd(words) {
    words.slice(1).forEach(function (k) { delete S.env[k] });
  }

  function envCmd() {
    add('o', 'PWD=' + S.cwd);
    add('o', 'HOME=' + S.home);
    var ti = S.termInfo || {};
    add('o', 'PATH=' + ((ti.path || []).join(':')));
    add('o', 'SHELL=' + (ti.sh || '/system/bin/sh'));
    add('o', 'TERM=xterm-256color');
    Object.keys(S.env).sort().forEach(function (k) { add('o', k + '=' + S.env[k]) });
  }

  function exitCmd() {
    if (S.mode !== 'sh') { leaveMode('已退出，回到 shell'); return; }
    exitTerminal();
  }

  function pythonCmd(words) {
    if (!hasPy) {
      add('err', PY_MSG + '：当前包没有内置解释器。');
      add('dimx', '安装 build.ps1 -WithPython 出的包后，python 命令才会出现在这里。');
      return;
    }
    if (!S.pyChecked) { add('hint', 'Python 正在启动，请稍候…'); return; }
    if (!S.pyOK) { add('err', PY_MSG + '：Py.info() 报告运行时不可用。'); return; }
    if (words[1] === '-V' || words[1] === '--version') { add('o', 'Python ' + (S.info.version || '?')); return; }
    if (words[1] === '-c') {
      var code = words.slice(2).join(' ');
      if (!code) { add('err', '用法：python -c "<代码>"'); return; }
      return pyRunCode(code, []);
    }
    if (words[1] && words[1].charAt(0) !== '-') return pyRunFile(words[1], words.slice(2));
    if (words[1] === '-m') {
      add('err', '不支持 -m：可以 pip install 纯 Python 包，或用 python -c "import runpy; runpy.run_module(\'模块\')"。');
      return;
    }
    if (words.length > 1) { add('err', '未知参数：' + words.slice(1).join(' ')); return; }
    enterMode('py');
  }

  function jsCmd(words) {
    if (words[1] === '-e') {
      var code = words.slice(2).join(' ');
      if (!code) { add('err', '用法：js -e "<代码>"'); return; }
      return runJS(code);
    }
    if (words[1]) {
      var r = callJSON('termRead', [words[1], S.cwd, 512 * 1024]);
      if (!r || !r.ok) { add('err', '读取失败：' + ((r && r.err) || '未知')); return; }
      add('dimx', '运行 ' + r.abs + '（' + r.size + ' B' + (r.truncated ? '，已截断' : '') + '）');
      return runJS(r.text);
    }
    enterMode('js');
  }

  var pipJob = null, pipPct = -1;

  function pipEvent(e) {
    if (!alive || !e || e.j !== pipJob) return;
    if (e.t === 'log') {
      add('o', String(e.m || ''));
      return;
    }
    if (e.t === 'prog') {
      var pct = e.total > 0 ? Math.floor(e.got * 100 / e.total) : -1;
      if (pct >= 0 && Math.floor(pct / 10) !== Math.floor(pipPct / 10)) {
        pipPct = pct;
        add('dimx', '下载 ' + pct + '%（' + fmtSize(e.got) + (e.total > 0 ? ' / ' + fmtSize(e.total) : '') + '）');
      }
      return;
    }
    if (e.t !== 'done') return;
    pipJob = null;
    setBusy(false);
    if (e.ok) {
      add('ok', '✓ 已安装 ' + (e.pkg || '') + (e.version ? ' ' + e.version : ''));
      if (e.path) add('dimx', '  ' + e.path);
      if (e.installed && e.installed.length) add('dimx', '  依赖：' + e.installed.join(', '));
      add('hint', '现在可以直接 import（同一解释器）；pip list 查看');
    } else {
      add('err', '安装失败：' + (e.error || '未知错误'));
      if (e.guide) {
        String(e.guide).split('\n').forEach(function (l) { add('dimx', '  ' + l) });
      }
    }
    flush();
  }
  window.__pipEv = pipEvent;

  function pipHelp() {
    add('hint', 'pip（运行时纯 Python / Android 预编译 wheel 管理器）');
    add('o', '  pip install <包名>[==版本] [--no-deps] [--index URL]');
    add('o', '  pip list');
    add('o', '  pip uninstall <包名>');
    add('o', '  pip index [URL]      查看/设置索引（默认 pypi.org）');
    add('dimx', '预编译模块（Android wheel / 我的商店）只能在「模块商店」安装，命令不支持直链。');
    add('dimx', '纯 Python 包可在这里装；需要编译且没有 Android 轮子时会给说明。');
    add('dimx', '安装位置：filesDir/py/site/<包>-<版本>/，装好后 import 立即可用；重启后自动挂回。');
  }

  function pipCmd(words) {
    var sub = (words[1] || '').toLowerCase();
    var rest = words.slice(2);
    if (!hasPy) {
      add('err', PY_MSG + '：pip 需要内置 Python 运行时（-WithPython 包）。');
      return;
    }
    if (!S.pyChecked) { add('hint', 'Python 正在启动，请稍候…'); return; }
    if (!S.pyOK) {
      add('err', 'Python 不可用：' + ((S.info && S.info.err) || PY_MSG));
      return;
    }
    if (!sub || sub === 'help' || sub === '?') { pipHelp(); return; }

    if (sub === 'list') {
      var r = callJSON('pipList', []);
      if (!r || !r.ok) {
        add('err', 'pip list 失败：' + ((r && r.err) || '未知'));
        return;
      }
      add('hint', '已安装（' + (r.packages || []).length + '）· index ' + (r.index || '?'));
      if (!r.packages || !r.packages.length) {
        add('dimx', '（空）pip install <包名> 安装纯 Python 包');
        return;
      }
      r.packages.forEach(function (p) {
        add('o', '  ' + p.pkg + ' ' + p.version + '  [' + p.level + ']' +
          (p.exists ? '' : '（目录丢失）'));
      });
      return;
    }

    if (sub === 'index') {
      var u = rest[0] || '';
      var r2 = callJSON('pipIndex', [u]);
      if (!r2 || !r2.ok) {
        add('err', '设置索引失败：' + ((r2 && r2.err) || '未知'));
        return;
      }
      add('o', 'pip index = ' + r2.index);
      add('dimx', '例：pip index https://pypi.org/pypi/');
      return;
    }

    if (sub === 'uninstall' || sub === 'remove' || sub === 'rm') {
      var pkg = rest[0];
      if (!pkg) { add('err', '用法：pip uninstall <包名>'); return; }
      var r3 = callJSON('pipRemove', [pkg]);
      if (!r3 || !r3.ok) {
        add('err', '卸载失败：' + ((r3 && r3.err) || '未知'));
        return;
      }
      add('ok', '已卸载 ' + pkg);
      return;
    }

    if (sub === 'install') {
      if (S.busy) { UI.toast('上一条还在运行，等它结束'); return; }
      var args = rest.slice();
      var opts = { deps: true, index: '' };
      var spec = '';
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a === '--no-deps') { opts.deps = false; continue; }
        if (a === '--index' || a === '-i') { opts.index = args[++i] || ''; continue; }
        if (a.charAt(0) === '-') { add('err', '未知选项：' + a); return; }
        if (!spec) spec = a;
      }
      if (!spec) {
        add('err', '用法：pip install <包名>[==版本] [--no-deps] [--index URL]');
        return;
      }
      pipPct = -1;
      var job = 'pip' + Date.now().toString(36);
      var start = callJSON('pipInstall', [job, spec, JSON.stringify(opts)]);
      if (!start || !start.ok) {
        add('err', '启动安装失败：' + ((start && start.err) || '未知'));
        return;
      }
      pipJob = job;
      setBusy(true);
      add('hint', 'pip install ' + spec + (opts.deps ? '' : '（--no-deps）'));
      add('dimx', '索引：' + (start.index || '?') + ' · 纯 Python / Android 预编译 wheel');
      flush();
      return;
    }

    add('err', 'pip 只支持 install / list / uninstall / index');
    pipHelp();
  }

  function histCmd() { showHist(); }

  /* 兼容旧终端命令（docs/07 与脚本页仍可能带这两个） */
  function pyInfoCmd() {
    if (!hasPy) { add('err', PY_MSG); return; }
    if (!S.pyChecked) { add('hint', 'Python 正在启动，请稍候…'); return; }
    if (!S.pyOK) {
      add('err', 'Python 不可用：' + ((S.info && S.info.err) || PY_MSG));
      add('dimx', '没有伪造版本号；请检查 -WithPython 包与 Chaquopy 初始化日志。');
      return;
    }
    add('hint', 'Python 运行时（Py.info）');
    add('o', '  version  ' + (S.info.version || '?'));
    add('o', '  abi      ' + (S.info.abi || '?'));
    add('o', '  userDir  ' + (S.info.userDir || '?'));
    add('o', '  cwd      ' + S.cwd);
  }
  function runCmd(words) {
    if (!words[1] || !words[2]) { add('err', '用法：run <站点id> <url>'); return; }
    return rouCmd(['rou', 'parse', words[1], words[2]]);
  }
  function curlCmd(words) {
    if (!words[1]) { add('err', '用法：curl <url>（等价 rou get）'); return; }
    return rouCmd(['rou', 'get', words[1]]);
  }

  function resetCmd() {
    UI.dialog({
      title: '重置终端会话',
      msg: '清空 Python 交互命名空间、JS 变量与环境变量，工作目录回到 home。已保存的站点/配置不受影响。',
      okText: '重置', cancelText: '取消', danger: true,
      onOk: function () {
        S.env = {};
        S.jsScope = Object.create(null);
        S.pyBuf = [];
        S.more = false;
        S.cwd = S.home;
        if (hasPy && S.pyOK && window.Py) {
          window.Py.reset().then(function () {
            add('dimx', '会话已重置（Python 命名空间 / JS 变量 / 环境变量 / 工作目录）');
            syncChrome();
            flush();
          });
        } else {
          add('dimx', '会话已重置（JS 变量 / 环境变量 / 工作目录）');
          syncChrome();
          flush();
        }
      }
    });
  }

  function varsCmd() {
    if (S.mode === 'py' && pyReady()) {
      window.Py.vars().then(function (r) {
        var list = (r && r.ok && r.vars) || [];
        UI.sheet('<div class="st-grp">Python 交互变量（' + list.length + ' 个）</div>' +
          (list.length ? list.map(function (v) {
            return '<div class="row"><div class="t"><div class="nm mono">' + esc(v.n) + '</div>' +
              '<div class="ds mono lines2">' + esc(v.t + ' · ' + v.r) + '</div></div></div>';
          }).join('') : '<div class="st-note">还没有变量。直接赋值（<span class="mono">x = 1</span>）会保留到会话结束。</div>') +
          '<div class="st-note">Python 变量与 JS 变量是两套：切到 JS 模式才能看到 JS 的。</div>');
      });
      return;
    }
    showJsVars();
  }

  function showJsVars() {
    var keys = Object.keys(S.jsScope).filter(function (k) { return k !== '_' });
    var rows = keys.map(function (k) {
      var v = S.jsScope[k];
      var t = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
      var val = fmtVal(v);
      if (val.length > 64) val = val.slice(0, 64) + '…';
      return '<div class="row"><div class="t"><div class="nm mono">' + esc(k) + '</div>' +
        '<div class="ds">' + esc(t + ' · ' + val) + '</div></div></div>';
    }).join('');
    UI.sheet('<div class="st-grp">JS 会话变量（' + keys.length + ' 个）</div>' +
      (keys.length ? rows : '<div class="st-note">还没有变量。直接赋值（<span class="mono">x = 1</span>）会保留到会话结束；' +
        '<span class="mono">let / const</span> 只在本次运行有效。</div>') +
      '<div class="st-note">可读全局：App / UI / DB / Net / Engine / Py / Native、esc / fmtSize / sleep、log / print</div>');
  }

  function showHist() {
    var list = S.hist.slice().reverse();
    UI.sheet('<div class="st-grp">命令历史（最多 ' + HIST_MAX + ' 条 · 本机持久化）</div>' +
      (list.length ? list.map(function (h, i) {
        return '<div class="row tap" data-h="' + i + '"><div class="t"><div class="nm mono lines2">' +
          esc(h) + '</div></div><div class="arw">↩</div></div>';
      }).join('') : '<div class="st-note">还没有历史命令。</div>') +
      (list.length ? '<div class="row tap danger" data-h="__clear"><div class="t"><div class="nm">清空历史</div></div></div>' : ''), {
      onOpen: function (pb) {
        $$('[data-h]', pb).forEach(function (el) {
          el.onclick = function () {
            var v = el.dataset.h;
            if (v === '__clear') {
              S.hist = []; DB._set(HIST_KEY, []); S.hi = -1;
              UI.closeSheet(); UI.toast('已清空历史');
              return;
            }
            ta.value = list[+v];
            UI.closeSheet();
            caretEnd();
          };
        });
      }
    });
  }

  /* ---------------- rou：和 App 直连 ---------------- */
  function rouHelp() {
    add('hint', 'rou —— 把 App 的能力搬进终端');
    add('o', '  rou env                    运行环境（cwd / PATH / ABI / 版本）');
    add('o', '  rou sites                  站点清单（DB.sites）');
    add('o', '  rou get <url> [-n 800] [-o 文件]  走 App 网络栈抓取（DoH / 代理生效）');
    add('o', '  rou parse <站点id> <url>   跑解析器，打印 JSON');
    add('o', '  rou open <页面> [k=v…]    打开 App 页面（home/browse/fav/mine/settings…）');
    add('o', '  rou py <代码>              一次性执行 Python');
    add('o', '  rou js <代码>              一次性执行 JS');
    add('o', '  rou ver                    版本 / 设备 / ABI');
    add('dimx', '例：rou get https://example.com -n 300 · rou open detail url=https://…');
  }

  function rouCmd(words) {
    var sub = (words[1] || '').toLowerCase();
    var rest = words.slice(2);
    if (!sub || sub === 'help' || sub === '?') return rouHelp();

    if (sub === 'env') {
      var ti = S.termInfo || {};
      add('hint', '环境');
      add('o', '  cwd      ' + S.cwd);
      add('o', '  home     ' + S.home);
      add('o', '  sh       ' + (ti.sh || '?') + (ti.setsid ? ' + setsid' : ''));
      add('o', '  abi      ' + (ti.abi || '?') + '  sdk ' + (ti.sdk || '?') + '  uid ' + (ti.uid || '?'));
      add('o', '  path     ' + ((ti.path || []).join(':')));
      add('o', '  python   ' + (S.pyOK ? 'CPython ' + (pyVer() || '?') : (S.pyChecked ? '未内置' : '检测中')));
      var ua = navigator.userAgent || '';
      var cm = ua.match(/Chrome\/[\d.]+/);
      add('o', '  js       WebView ' + (cm ? cm[0] : ua.slice(0, 40)));
      return;
    }
    if (sub === 'ver') {
      var ni = window.__nativeInfo || {};
      add('o', '界析 ' + (ni.v || '?') + ' · ' + (ni.brand || '') + ' ' + (ni.model || '') +
        ' · Android ' + (ni.sdk || '?') + ' · ' + (S.termInfo && S.termInfo.abi || '?'));
      return;
    }
    if (sub === 'sites') {
      var sites = DB.sites() || [];
      if (!sites.length) { add('dimx', '还没有站点。'); return; }
      add('hint', '站点（' + sites.length + '）');
      sites.forEach(function (s) {
        add('o', '  ' + (s.enabled === false ? '○' : '●') + ' ' + s.id + '  ' +
          esc(s.name || '') + '  ' + esc(String(s.site || '').replace(/^https?:\/\//, '')) +
          '  [' + (s.type || 'js') + ']');
      });
      return;
    }
    if (sub === 'get') {
      var url = rest[0];
      var max = 400, outFile = '';
      for (var i = 1; i < rest.length; i++) {
        if (rest[i] === '-n') { max = parseInt(rest[++i], 10) || 400; }
        else if (rest[i] === '-o') { outFile = rest[++i] || ''; }
      }
      if (!url || !/^https?:\/\//i.test(url)) { add('err', '用法：rou get <http(s)://url> [-n 400] [-o 文件]'); return; }
      add('hint', 'GET ' + url);
      setBusy(true);
      return Net.request('GET', url).then(function (r) {
        setBusy(false);
        var txt = r.txt != null ? r.txt : '';
        add('ok', 'HTTP ' + r.status + ' · ' + txt.length + ' 字符 · ' + r.ms + 'ms');
        if (outFile) {
          var w = callJSON('termWrite', [outFile, txt, S.cwd]);
          if (w && w.ok) add('ok', '已写入 ' + w.path + '（' + w.bytes + ' B）');
          else add('err', '写文件失败：' + ((w && w.err) || '未知'));
        }
        var head = txt.slice(0, max);
        if (head) add('o', head);
        if (txt.length > max) add('dimx', '… 其余 ' + (txt.length - max) + ' 字符未显示');
      }, function (e) {
        setBusy(false);
        add('err', '抓取失败：' + firstLine(e));
      });
    }
    if (sub === 'parse') {
      var site = rest[0], u = rest[1];
      if (!site || !u) { add('err', '用法：rou parse <站点id> <url>'); return; }
      add('hint', 'Engine.run(' + site + ', ' + u + ')');
      setBusy(true);
      return Engine.run(site, u).then(function (res) {
        setBusy(false);
        if (res && res.ok) {
          add('ok', '解析成功 · ' + (res.ms || 0) + 'ms');
          var txt = fmtVal(res.data);
          add('o', txt.slice(0, 6000));
          if (txt.length > 6000) add('dimx', '… JSON 共 ' + txt.length + ' 字符，已截断');
        } else {
          add('err', '解析失败：' + ((res && res.error) || '未知错误'));
        }
      }, function (e) {
        setBusy(false);
        add('err', '解析失败：' + firstLine(e));
      });
    }
    if (sub === 'open') {
      var page = rest[0];
      if (!page) { add('err', '用法：rou open <页面>（home/browse/fav/mine/settings…）'); return; }
      var ps = {};
      rest.slice(1).forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) ps[kv.slice(0, i)] = kv.slice(i + 1);
      });
      if (page === 'home' || page === 'browse' || page === 'fav' || page === 'mine') App.setTab(page);
      else if (App.pages[page]) App.go(page, ps);
      else { add('err', '没有这个页面: ' + page); add('dimx', '可用：' + Object.keys(App.pages).join(', ')); return; }
      add('ok', '已打开 ' + page + (Object.keys(ps).length ? ' ' + JSON.stringify(ps) : ''));
      return;
    }
    if (sub === 'py') {
      var pcode = rest.join(' ');
      if (!pcode) { add('err', '用法：rou py <Python 代码>'); return; }
      if (!pyReady()) { add('err', PY_MSG); return; }
      return pyRunCode(pcode, []);
    }
    if (sub === 'js') {
      var jcode = rest.join(' ');
      if (!jcode) { add('err', '用法：rou js <JS 代码>'); return; }
      return runJS(jcode);
    }
    add('err', '未知子命令：rou ' + sub);
    rouHelp();
  }

  /* ---------------- Tab 补全 ---------------- */
  function commonPrefix(list) {
    if (!list.length) return '';
    var p = list[0];
    for (var i = 1; i < list.length; i++) {
      var s = list[i], j = 0;
      while (j < p.length && j < s.length && p.charAt(j) === s.charAt(j)) j++;
      p = p.slice(0, j);
    }
    return p;
  }
  function printCands(title, cands) {
    add('dimx', title);
    var w = 0;
    cands.forEach(function (c) { if (c.length > w) w = c.length; });
    w = Math.min(24, w + 2);
    var cols = Math.max(1, Math.min(4, Math.floor(46 / w)));
    var line = '';
    cands.forEach(function (c, i) {
      var pad = c;
      while (pad.length < w) pad += ' ';
      line += pad;
      if ((i + 1) % cols === 0) { add('o', line.replace(/\s+$/, '')); line = ''; }
    });
    if (line.trim()) add('o', line.replace(/\s+$/, ''));
    flush();
  }
  function complete() {
    if (S.mode !== 'sh') { UI.toast('补全只在 shell 模式可用'); return; }
    var v = ta.value;
    if (v.indexOf('\n') >= 0 || ta.selectionStart !== v.length) return;
    if (!hasTerm) return;
    var m = /(\S*)$/.exec(v);
    var token = m ? m[1] : '';
    var before = v.slice(0, v.length - token.length);
    var allowCmd = !/\S/.test(before);
    var r = callJSON('termComplete', [token, S.cwd, allowCmd]);
    if (!r || !r.ok) return;
    if (r.kind === 'cmd') {
      var seen = {}, cands = [];
      r.items.forEach(function (n) { if (!seen[n]) { seen[n] = 1; cands.push(n); } });
      BUILTIN_NAMES.forEach(function (n) {
        if (n.indexOf(token) === 0 && !seen[n]) { seen[n] = 1; cands.push(n); }
      });
      cands = cands.filter(function (n) { return n.indexOf(token) === 0 }).sort();
      if (!cands.length) { add('dimx', '没有匹配的命令'); flush(); return; }
      if (cands.length === 1) {
        ta.value = before + cands[0] + ' ';
        caretEnd();
        return;
      }
      var cp = commonPrefix(cands);
      if (cp.length > token.length) { ta.value = before + cp; caretEnd(); }
      printCands('命令（' + cands.length + '）', cands);
      return;
    }
    var items = r.items || [];
    if (!items.length) { add('dimx', '没有匹配的文件或目录'); flush(); return; }
    var names = items.map(function (it) { return it.n });
    var slash2 = token.lastIndexOf('/');
    var dirPrefix = slash2 >= 0 ? token.slice(0, slash2 + 1) : '';
    var baseToken = slash2 >= 0 ? token.slice(slash2 + 1) : token;
    if (names.length === 1) {
      ta.value = before + dirPrefix + names[0];
      caretEnd();
      return;
    }
    var cp2 = commonPrefix(names);
    if (cp2.length > baseToken.length) { ta.value = before + dirPrefix + cp2; caretEnd(); }
    printCands('路径（' + names.length + '）', names);
  }

  /* ---------------- 提交 ---------------- */
  function submit() {
    if (S.busy) { UI.toast('上一条还在运行（Ctrl+C 可中断）'); return; }
    var src = ta.value.replace(/\r/g, '');
    var trimmed = src.replace(/\s+$/, '');
    if (!trimmed && !(S.mode === 'py' && S.more)) return;
    var psNow = promptText();
    ta.value = '';
    echo(trimmed, psNow);
    if (trimmed) pushHist(trimmed);
    var p;
    if (S.mode === 'py') p = pySubmit(trimmed);
    else if (S.mode === 'js') {
      if (/^\s*(exit|quit)\s*;?\s*$/.test(trimmed)) { leaveMode('已退出 JS 控制台'); p = Promise.resolve(); }
      else p = Promise.resolve(runJS(trimmed)).then(function (keep) {
        if (keep) { ta.value = trimmed; caretEnd(); }
      });
    } else p = dispatchShell(trimmed);
    return Promise.resolve(p).then(function () { flush() }, function (e) {
      add('err', '执行失败：' + firstLine(e));
      flush();
    });
  }

  function dispatchShell(src) {
    if (!src) return Promise.resolve();
    /* 多行 / 复合命令（管道、重定向、变量、通配符）直接交给 shell；
       但引号里的 () $ 等不算——否则 python -c "print(1)" 会被误判 */
    if (src.indexOf('\n') < 0) {
      var words = splitWords(src);
      var name = (words[0] || '').toLowerCase();
      if (name === 'rou' && words.length > 2 && (words[1] === 'py' || words[1] === 'js')) {
        return Promise.resolve(BUILTINS.rou(words, src));
      }
      if (BUILTINS[name] && words[0] === name) {
        if (!hasShellMeta(src)) return Promise.resolve(BUILTINS[name](words, src));
        if (name === 'cd' || name === 'export' || name === 'unset') {
          add('err', '内置的 ' + name + ' 不支持管道 / 重定向 / 变量展开（它改的是终端自己的状态）。');
          add('dimx', '需要这些语法时请用 sh -c "…" 或写进脚本。');
          return Promise.resolve();
        }
      }
    }
    return runShell(src);
  }

  /* 引号外的 shell 元字符才算复合命令 */
  function hasShellMeta(s) {
    var q = null;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) {
        if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") { q = c; continue; }
      if ('|&;<>()`$*?'.indexOf(c) >= 0) return true;
    }
    return false;
  }

  /* ---------------- 输入事件 ---------------- */
  function onKey(e) {
    var k = e.key;
    if ((e.ctrlKey || e.metaKey) && (k === 'l' || k === 'L')) { e.preventDefault(); clearCmd(); return }
    if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'C')) {
      if (window.getSelection && String(window.getSelection())) return;   // 有选中文本时保留复制
      e.preventDefault(); interrupt(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (k === 'd' || k === 'D')) {
      e.preventDefault();
      ctrlD();
      return;
    }
    if (k === 'Escape') {
      e.preventDefault();
      if (S.more) { S.more = false; S.pyBuf = []; syncChrome(); }
      ta.value = '';
      return;
    }
    if (k === 'Tab') { e.preventDefault(); complete(); return }
    if ((e.ctrlKey || e.metaKey) && k === 'Enter') { e.preventDefault(); submit(); return }
    if (k === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      var single = ta.value.indexOf('\n') < 0;
      var atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
      var atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
      if (single || (k === 'ArrowUp' ? atStart : atEnd)) {
        e.preventDefault();
        navHist(k === 'ArrowUp' ? -1 : 1);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (k === 'p' || k === 'P')) { e.preventDefault(); navHist(-1); return }
    if ((e.ctrlKey || e.metaKey) && (k === 'n' || k === 'N')) { e.preventDefault(); navHist(1); return }
  }
  ta.addEventListener('keydown', onKey);

  /* ---------------- 手机按键条 / 快捷胶囊 / 更多菜单 ---------------- */
  function chromeVer() {
    var ua = navigator.userAgent || '';
    var m = ua.match(/Chrome\/[\d.]+/);
    return m ? m[0] : 'WebView';
  }

  function ctrlD() {
    if (S.mode !== 'sh') {
      leaveMode(S.mode === 'py' ? '已退出 Python 交互（^D）' : '已退出 JS 控制台（^D）');
    } else if (!ta.value) {
      exitTerminal();
    }
  }

  /* 退出终端页：先挡住紧随 pointerup 的 click，避免“点 ^D 却点到了下面刚出现的 Tab 栏” */
  function guardTapThrough() {
    if (window.__tmGuard) return;
    var h = function (e) {
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (x) { }
    };
    window.__tmGuard = h;
    document.addEventListener('click', h, true);
    setTimeout(function () {
      try {
        document.removeEventListener('click', h, true);
      } catch (e) { }
      window.__tmGuard = null;
    }, 450);
  }
  function exitTerminal() {
    guardTapThrough();
    App.back();
  }

  /* ---------------- Ctrl 粘滞键 ---------------- */
  var ctrlArmed = false;
  var ctrlTimer = null;
  var shiftArmed = false;
  var altArmed = false;
  var shiftTimer = null;
  var altTimer = null;
  function ctrlEl() { return $('[data-key=ctrl]', keys); }
  function armShift(on) {
    shiftArmed = !!on;
    if (shiftTimer) { clearTimeout(shiftTimer); shiftTimer = null; }
    var el = $('[data-key=shift]', keys);
    if (el) el.classList.toggle('on', shiftArmed);
    if (shiftArmed) { shiftTimer = setTimeout(function () { armShift(false); }, 6000); UI.toast('Shift 已按下：配合方向键 / Home / End / Tab', 1600); }
  }
  function armAlt(on) {
    altArmed = !!on;
    if (altTimer) { clearTimeout(altTimer); altTimer = null; }
    var el = $('[data-key=alt]', keys);
    if (el) el.classList.toggle('on', altArmed);
    if (altArmed) { altTimer = setTimeout(function () { armAlt(false); }, 6000); UI.toast('Alt 已按下：配合 ←/→ 按词移动', 1600); }
  }
  function showFn(on) {
    fnRow.classList.toggle('on', !!on);
    var el = $('[data-key=fn]', keys);
    if (el) el.classList.toggle('on', !!on);
  }
  function armCtrl(on) {
    ctrlArmed = !!on;
    if (ctrlTimer) { clearTimeout(ctrlTimer); ctrlTimer = null; }
    var el = ctrlEl();
    if (el) el.classList.toggle('on', ctrlArmed);
    if (ctrlArmed) {
      ctrlTimer = setTimeout(function () { armCtrl(false); }, 6000);
      UI.toast('Ctrl 已按下：再按 C / D / L / P / N / U', 1600);
    }
  }
  function ctrlAction(ch) {
    if (ch === 'c') return interrupt();
    if (ch === 'd') return ctrlD();
    if (ch === 'l') return clearCmd();
    if (ch === 'p') return navHist(-1);
    if (ch === 'n') return navHist(1);
    if (ch === 'u') { ta.value = ''; syncChrome(); caretEnd(); return; }
    UI.toast('Ctrl+' + String(ch).toUpperCase() + ' 暂不支持');
  }
  function ctrlInsert(e) {
    var d = e.data || '';
    if (e.inputType && e.inputType !== 'insertText') { armCtrl(false); return false; }
    if (d.length === 1 && /[a-zA-Z]/.test(d)) {
      armCtrl(false);
      ctrlAction(d.toLowerCase());
      return true;
    }
    armCtrl(false);
    return false;
  }
  /* 软件键盘：优先 beforeinput 拦截；不支持的输入法退回 input 里删掉刚插入的字符 */
  ta.addEventListener('beforeinput', function (e) {
    if (!ctrlArmed) return;
    if (ctrlInsert(e)) e.preventDefault();
  });
  ta.addEventListener('input', function (e) {
    if (!ctrlArmed) return;
    var d = e.data || '';
    if (d.length === 1 && /[a-zA-Z]/.test(d)) {
      var v = ta.value, pos = ta.selectionStart;
      if (v.slice(pos - 1, pos) === d) {
        ta.value = v.slice(0, pos - 1) + v.slice(pos);
        try { ta.setSelectionRange(pos - 1, pos - 1) } catch (x) { }
      }
      armCtrl(false);
      ctrlAction(d.toLowerCase());
    } else {
      armCtrl(false);
    }
  });

  function sendKey(kind) {
    if (kind === 'ctrl') return armCtrl(!ctrlArmed);
    if (kind === 'shift') return armShift(!shiftArmed);
    if (kind === 'alt') return armAlt(!altArmed);
    if (kind === 'fn') return showFn(!fnRow.classList.contains('on'));
    if (ctrlArmed) armCtrl(false);
    var shift = shiftArmed, alt = altArmed;
    if (shift) armShift(false);
    if (alt) armAlt(false);
    if (kind === 'tab') {
      if (shift) { ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end'); syncChrome(); caretEnd(); return; }
      return complete();
    }
    if (kind === 'esc') {
      if (S.mode === 'py' && S.more) { S.more = false; S.pyBuf = []; add('dimx', '已取消未完成的 Python 输入'); }
      ta.value = '';
      syncChrome();
      caretEnd();
      return;
    }
    if (kind === 'cc') return interrupt();
    if (kind === 'cd') return ctrlD();
    if (kind === 'cl') return clearCmd();
    if (kind === 'up') return navHist(-1);
    if (kind === 'down') return navHist(1);
    if (kind === 'enter') {
      if (alt) { ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end'); syncChrome(); caretEnd(); return; }
      return submit();
    }
    var v = ta.value, a = ta.selectionStart, b = ta.selectionEnd, pos = a;
    if (kind === 'left') {
      pos = Math.max(0, a - 1);
      if (alt) { while (pos > 0 && /\s/.test(v.charAt(pos - 1))) pos--; while (pos > 0 && !/\s/.test(v.charAt(pos - 1))) pos--; }
    } else if (kind === 'right') {
      pos = Math.min(v.length, b + 1);
      if (alt) { while (pos < v.length && /\s/.test(v.charAt(pos))) pos++; while (pos < v.length && !/\s/.test(v.charAt(pos))) pos++; }
    } else if (kind === 'home') pos = v.lastIndexOf('\n', a - 1) + 1;
    else if (kind === 'end') {
      var le = v.indexOf('\n', b);
      pos = le < 0 ? v.length : le;
    } else return;
    try {
      ta.focus();
      if (shift) ta.setSelectionRange(a, pos); else ta.setSelectionRange(pos, pos);
    } catch (e) { }
  }

  /* 按键条 / 胶囊用「按下-抬起」触发：pointerdown 里 preventDefault 保住 textarea 焦点，
     避免点一下按钮输入法就收起；同时用位移阈值区分点击与横向滚动 */
  function onPress(el, fn) {
    var sx = 0, sy = 0, moved = false, down = false;
    el.addEventListener('pointerdown', function (e) {
      down = true;
      moved = false;
      sx = e.clientX; sy = e.clientY;
      if (e.preventDefault) e.preventDefault();
    });
    el.addEventListener('pointermove', function (e) {
      if (!down) return;
      if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) moved = true;
    });
    el.addEventListener('pointercancel', function () { down = false; });
    el.addEventListener('pointerup', function () {
      if (!down) return;
      down = false;
      if (!moved) fn();
    });
  }

  $$('[data-key]', keys).forEach(function (b) {
    onPress(b, function () { sendKey(b.dataset.key); });
  });
  $$('[data-fk]', fnRow).forEach(function (b) {
    onPress(b, function () { fnAction(+b.dataset.fk); });
  });

  function fnAction(n) {
    showFn(false);
    if (n === 1) return helpCmd();
    if (n === 2) return clearCmd();
    if (n === 3) { UI.sheet('<div class="sheet-hd">历史命令</div>' + ((S.hist || []).slice(-30).reverse().map(function (x) { return '<div class="row tap" data-h="' + esc(x) + '"><div class="t"><div class="nm mono">' + esc(x) + '</div></div></div>'; }).join('') || '<div class="d1-note" style="padding:12px">暂无历史</div>'), { onOpen: function (pb) { $$('[data-h]', pb).forEach(function (r) { r.onclick = function () { UI.closeSheet(); ta.value = r.dataset.h; caretEnd(); }; }); } }); return; }
    if (n === 4) return openPanel();
    if (n === 5) { flush(); return; }
    if (n === 6) return enterMode('py');
    if (n === 7) return enterMode('js');
    if (n === 8) return capsCmd();
    if (n === 9) return updateCmd();
    if (n === 10) return helpCmd();
    UI.toast('F' + n + ' 暂无绑定');
  }

  function runCommandLine(line) {
    if (S.busy) { UI.toast('上一条还在运行（^C 可中断）'); return; }
    if (FP.open) closePanel();
    if (S.mode !== 'sh') leaveMode();
    ta.value = line;
    submit();
  }

  function chipAction(k) {
    if (k === 'files') { openPanel(); return; }
    if (k === 'upd') { updateCmd(); return; }
    if (k === 'py') { enterMode('py'); return; }
    if (k === 'js') { enterMode('js'); return; }
    if (k === 'help') { helpCmd(); flush(); return; }
    if (k === 'caps') { capsCmd(); flush(); return; }
    if (k === 'ls') { runCommandLine('ls -l'); return; }
    if (k === 'rou') { rouHelp(); flush(); return; }
  }
  $$('[data-chip]', chips).forEach(function (b) {
    onPress(b, function () { chipAction(b.dataset.chip); });
  });

  if (goBtn) {
    onPress(goBtn, function () { submit(); });
  }

  function showMore() {
    var rows = [
      ['vars', 'ƒ 变量', S.mode === 'py' ? 'Python 交互变量' : 'JS 会话变量'],
      ['hist', '历史命令', '最近 ' + S.hist.length + ' 条'],
      ['cmds', '常用命令', '双击终端也能打开，可手动新增'],
      ['caps', '能力说明', '这个终端能做什么 / 不是 Linux 发行版'],
      ['reset', '重置会话', '命名空间 / 环境变量 / 回 home'],
      ['files', '文件面板', '浏览 / 重命名 / 删除 / 执行'],
      ['help', '帮助', '全部命令与快捷键'],
      ['keys', '手机按键说明', 'Tab / ^C / ^D / ^L / 方向键']
    ];
    UI.sheet('<div class="st-grp">终端</div>' + rows.map(function (r) {
      return '<div class="row tap" data-mx="' + r[0] + '"><div class="t"><div class="nm">' +
        esc(r[1]) + '</div><div class="ds">' + esc(r[2]) + '</div></div><div class="arw">›</div></div>';
    }).join('') +
      '<div class="st-note">输入时输入框下方会出现按键条（Tab / ^C / ^D / ^L / 方向键 / ⏎）；' +
      '外接键盘可直接用 Ctrl+… 组合键。当前工作目录：<span class="mono">' + esc(S.cwd) + '</span></div>', {
      onOpen: function (pb) {
        $$('[data-mx]', pb).forEach(function (el) {
          el.onclick = function () {
            UI.closeSheet();
            var k = el.dataset.mx;
            if (k === 'vars') varsCmd();
            else if (k === 'hist') showHist();
            else if (k === 'cmds') openCommands();
            else if (k === 'caps') { capsCmd(); flush(); }
            else if (k === 'reset') resetCmd();
            else if (k === 'files') openPanel();
            else if (k === 'help') { helpCmd(); flush(); }
            else if (k === 'keys') showKeyHelp();
          };
        });
      }
    });
  }

  function showKeyHelp() {
    UI.sheet('<div class="st-grp">手机按键与快捷键</div>' +
      '<div class="st-note">输入框获得焦点时，下方出现按键条：</div>' +
      '<div class="st-note mono">Tab 补全 · ^C 中断 · ^D 退出模式 · ^L 清屏 · ↑↓ 历史 · ←→ 移动 · ⇤⇥ 行首行尾 · ⏎ 运行</div>' +
      '<div class="st-note">外接键盘：Ctrl+C/D/L/P/N，Ctrl+Enter 运行，Shift+Enter 换行，Tab 补全。</div>', {});
  }

  /* ---------------- 右侧文件面板 ---------------- */
  function parentOf(p) {
    var i = String(p).lastIndexOf('/');
    return i <= 0 ? '/' : String(p).slice(0, i);
  }

  function openPanel() {
    FP.open = true;
    panel.classList.add('on');
    if (!FP.path) FP.path = S.cwd;
    loadPanel(FP.path);
  }
  function closePanel() {
    FP.open = false;
    panel.classList.remove('on');
  }

  /* 系统返回键：文件面板打开时先关面板（boot.js 的 __back 会调用这个钩子） */
  window.__termBack = function () {
    if (FP.open) {
      closePanel();
      return true;
    }
    return false;
  };

  function renderPathBar(abs) {
    var barEl = $('.tm-fpath', panel);
    var segs = String(abs).split('/').filter(function (x) { return !!x });
    var h = '<b data-fp="/" class="seg">/</b>';
    var acc = '';
    segs.forEach(function (s) {
      acc += '/' + s;
      h += '<b data-fp="' + esc(acc) + '" class="seg">' + esc(s) + '</b>';
    });
    barEl.innerHTML = h;
    $$('[data-fp]', barEl).forEach(function (b) {
      b.onclick = function () { loadPanel(b.dataset.fp); };
    });
  }

  function bindLongPress(el, fn) {
    var timer = null, sx = 0, sy = 0;
    function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
    el.addEventListener('pointerdown', function (e) {
      sx = e.clientX; sy = e.clientY;
      cancel();
      timer = setTimeout(function () {
        timer = null;
        el._lpAt = Date.now();      // 供 click 判断“刚才是长按，不要再触发点击动作”
        fn();
      }, 550);
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointermove', function (e) {
      if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel();
    });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); cancel(); fn(); });
  }

  function loadPanel(p) {
    var listEl = $('.tm-flist', panel);
    listEl.innerHTML = '<div class="tm-fempty">读取中…</div>';
    var r = callJSON('termList', [p, S.cwd]);
    if (!r || !r.ok) {
      FP.path = (r && r.abs) || p || S.cwd;
      renderPathBar(FP.path);
      listEl.innerHTML = '<div class="tm-fempty">' + esc((r && r.err) || '读取失败') + '</div>';
      return;
    }
    FP.path = r.abs;
    renderPathBar(r.abs);
    var items = (r.entries || []).slice().sort(function (a, b) {
      if (a.d !== b.d) return a.d ? -1 : 1;
      return String(a.n).localeCompare(String(b.n));
    });
    var map = {};
    items.forEach(function (it) { map[it.p] = it; });
    if (!items.length) {
      listEl.innerHTML = '<div class="tm-fempty">空目录</div>';
      return;
    }
    listEl.innerHTML = items.map(function (it) {
      var icon = it.d ? '▸' : (it.link ? '↗' : '·');
      var meta;
      if (it.link) meta = '→ ' + (it.to || '?') + (it.d ? '（目录）' : '');
      else if (it.d) meta = '';
      else meta = fmtSize(it.size || 0);
      return '<div class="tm-frow' + (it.link ? ' lnk' : '') + '" data-p="' + esc(it.p) + '">' +
        '<span class="fi">' + icon + '</span>' +
        '<span class="fn">' + esc(it.n) + '</span>' +
        '<span class="fm">' + esc(meta) + '</span></div>';
    }).join('') +
      '<div class="tm-fempty">' + items.length + ' 项 · 长按文件有菜单</div>';
    $$('.tm-frow', listEl).forEach(function (el) {
      var it = map[el.dataset.p];
      if (!it) return;
      bindLongPress(el, function () {
        el._lpAt = Date.now();
        showFileMenu(it);
      });
      el.onclick = function () {
        if (el._lpAt && Date.now() - el._lpAt < 800) return;   // 刚长按出菜单，别又触发预览
        if (it.d) loadPanel(it.p);
        else previewFile(it);
      };
    });
  }

  function showFileMenu(it) {
    var ext = String(it.n).toLowerCase().split('.').pop();
    var runnable = !it.d && (ext === 'sh' || ext === 'py' || ext === 'js');
    var acts = [];
    if (it.d) acts.push(['cd', '在终端 cd 到这里']);
    if (runnable) acts.push(['run', '在当前终端执行']);
    if (!it.d) acts.push(['view', '预览（文本）']);
    if (!it.d) acts.push(['edit', '编辑']);
    if (it.link && it.to) acts.push(['goto', '跳到软链接目标']);
    acts.push(['copy', '复制路径']);
    acts.push(['rename', '重命名']);
    acts.push(['del', '删除']);
    UI.sheet('<div class="st-grp">' + esc(it.n) + '</div>' + acts.map(function (a) {
      return '<div class="row tap' + (a[0] === 'del' ? ' danger' : '') + '" data-fm="' + a[0] + '">' +
        '<div class="t"><div class="nm">' + esc(a[1]) + '</div></div><div class="arw">›</div></div>';
    }).join('') + '<div class="st-note mono">' + esc(it.p) + (it.link ? ' → ' + esc(it.to || '?') : '') +
      (it.d ? '' : ' · ' + fmtSize(it.size || 0)) + '</div>', {
      onOpen: function (pb) {
        $$('[data-fm]', pb).forEach(function (el) {
          el.onclick = function () {
            UI.closeSheet();
            doFileAction(el.dataset.fm, it);
          };
        });
      }
    });
  }

  function doFileAction(k, it) {
    if (k === 'cd') {
      closePanel();
      S.cwd = it.p;
      syncChrome();
      add('dimx', 'cwd → ' + shortCwd());
      flush();
      return;
    }
    if (k === 'run') { execInTerm(it); return; }
    if (k === 'view') { previewFile(it); return; }
    if (k === 'edit') { editFile(it); return; }
    if (k === 'goto') { loadPanel(it.to); return; }
    if (k === 'copy') { copyText(it.p); return; }
    if (k === 'rename') {
      promptSheet('重命名', it.n, '新名字（不含 /）', function (name) {
        var r = callJSON('termRename', [it.p, name, S.cwd]);
        if (r && r.ok) { UI.toast('已重命名'); loadPanel(FP.path); }
        else UI.toast('失败：' + ((r && r.err) || '未知'));
      });
      return;
    }
    if (k === 'del') {
      UI.dialog({
        title: '删除 ' + it.n,
        msg: (it.d ? '目录会递归删除，' : '') + '删除后不可恢复。确定吗？',
        okText: '删除', danger: true,
        onOk: function () {
          var r = callJSON('termDelete', [it.p, S.cwd]);
          if (r && r.ok) {
            UI.toast('已删除');
            if (FP.path === it.p || FP.path.indexOf(it.p + '/') === 0) FP.path = parentOf(it.p);
            loadPanel(FP.path);
          } else UI.toast('失败：' + ((r && r.err) || '未知'));
        }
      });
    }
  }

  function execInTerm(it) {
    var dir = parentOf(it.p);
    var ext = String(it.n).toLowerCase().split('.').pop();
    closePanel();
    if (dir !== S.cwd) {
      S.cwd = dir;
      KEEP.cwd = dir;
      S.mode = 'sh';
      KEEP.mode = 'sh';
      syncChrome();
    }
    add('hint', '▶ ' + it.p);
    if (ext === 'py') {
      if (!pyReady()) add('err', PY_MSG);
      else pyRunFile(it.p, []);
    } else if (ext === 'js') {
      var rr = callJSON('termRead', [it.p, S.cwd, 512 * 1024]);
      if (rr && rr.ok) runJS(rr.text);
      else add('err', '读取失败：' + ((rr && rr.err) || '未知'));
    } else {
      runShell('sh ' + shellQuotePath(it.p));
    }
    flush();
  }

  function shellQuotePath(p) {
    return "'" + String(p).replace(/'/g, "'\\''") + "'";
  }

  function previewFile(it) {
    var r = callJSON('termRead', [it.p, S.cwd, 256 * 1024]);
    if (!r || !r.ok) { UI.toast('读取失败：' + ((r && r.err) || '未知')); return; }
    if (String(r.text).indexOf('\u0000') >= 0) {
      UI.toast('二进制文件（' + fmtSize(it.size || 0) + '），不做文本预览');
      return;
    }
    UI.sheet('<div class="st-grp">' + esc(it.n) + ' · ' + fmtSize(r.size || 0) +
      (r.truncated ? ' · 已截断' : '') + '</div><pre class="tm-prev">' +
      esc(String(r.text).slice(0, 50000)) + '</pre>', {});
  }

  function editFile(it) {
    var r = callJSON('termRead', [it.p, S.cwd, 512 * 1024]);
    if (!r || !r.ok) { UI.toast('读取失败：' + ((r && r.err) || '未知')); return; }
    if (String(r.text).indexOf('\u0000') >= 0) { UI.toast('二进制文件不能编辑'); return; }
    UI.sheet('<div class="st-grp">编辑 ' + esc(it.n) + '</div>' +
      '<textarea class="tm-edit" spellcheck="false" autocapitalize="off" autocorrect="off"></textarea>' +
      '<div class="tm-facts"><button class="btn ghost" data-c>取消</button>' +
      '<button class="btn pri" data-s>保存</button></div>', {
      onOpen: function (pb) {
        var ed = $('.tm-edit', pb);
        ed.value = String(r.text);
        $('[data-c]', pb).onclick = function () { UI.closeSheet(); };
        $('[data-s]', pb).onclick = function () {
          var w = callJSON('termWrite', [it.p, ed.value, S.cwd]);
          if (w && w.ok) {
            UI.closeSheet();
            UI.toast('已保存 ' + w.bytes + ' B');
            if (FP.open) loadPanel(FP.path);
          } else UI.toast('保存失败：' + ((w && w.err) || '未知'));
        };
      }
    });
  }

  function promptSheet(title, value, placeholder, onOk) {
    UI.sheet('<div class="st-grp">' + esc(title) + '</div>' +
      '<input class="input tm-pin" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '">' +
      '<div class="tm-facts"><button class="btn ghost" data-c>取消</button>' +
      '<button class="btn pri" data-o>确定</button></div>', {
      onOpen: function (pb) {
        var inp = $('.tm-pin', pb);
        setTimeout(function () { try { inp.focus() } catch (e) { } }, 60);
        $('[data-c]', pb).onclick = function () { UI.closeSheet(); };
        $('[data-o]', pb).onclick = function () {
          var v = String(inp.value || '').trim();
          if (!v) { UI.toast('不能为空'); return; }
          if (v.indexOf('/') >= 0) { UI.toast('名字不能包含 /'); return; }
          UI.closeSheet();
          onOk(v);
        };
      }
    });
  }

  function newEntry(kind) {
    promptSheet(kind === 'dir' ? '新建文件夹' : '新建文件', '',
      kind === 'dir' ? '文件夹名' : '文件名（如 test.sh / t.py / a.js）', function (name) {
        var p = (FP.path === '/' ? '' : FP.path) + '/' + name;
        var r = kind === 'dir'
          ? callJSON('termMkdir', [p, S.cwd])
          : callJSON('termWrite', [p, '', S.cwd]);
        if (r && r.ok) {
          UI.toast('已创建');
          loadPanel(FP.path);
        } else UI.toast('失败：' + ((r && r.err) || '未知'));
      });
  }

  function newSheet() {
    UI.sheet('<div class="st-grp">新建</div>' +
      '<div class="row tap" data-nf="file"><div class="t"><div class="nm">新建文件</div>' +
      '<div class="ds">空文本，建好后可长按编辑</div></div><div class="arw">›</div></div>' +
      '<div class="row tap" data-nf="dir"><div class="t"><div class="nm">新建文件夹</div>' +
      '<div class="ds">在当前面板目录下创建</div></div><div class="arw">›</div></div>', {
      onOpen: function (pb) {
        $$('[data-nf]', pb).forEach(function (el) {
          el.onclick = function () {
            UI.closeSheet();
            newEntry(el.dataset.nf);
          };
        });
      }
    });
  }

  $$('[data-fx]', panel).forEach(function (b) {
    var k = b.dataset.fx;
    b.onclick = function () {
      if (k === 'close') closePanel();
      else if (k === 'refresh') loadPanel(FP.path);
      else if (k === 'new') newSheet();
      else if (k === 'jump') {
        promptSheet('跳转到路径', FP.path || S.cwd, '/system 或 /data/local/tmp', function (p) { loadPanel(p); });
      }
    };
  });
  $$('[data-fq]', panel).forEach(function (b) {
    b.onclick = function () {
      var k = b.dataset.fq;
      if (k === 'home') loadPanel(S.home || '/');
      else if (k === 'root') loadPanel('/');
      else if (k === 'system') loadPanel('/system');
      else if (k === 'tmp') loadPanel('/data/local/tmp');
      else if (k === 'cache') loadPanel((S.termInfo && S.termInfo.cache) || '/data/local/tmp');
    };
  });

  /* ---------------- 运行时刷新 ---------------- */
  function updateCmd() {
    add('hint', '刷新运行时状态（版本随 APK）');
    var ni = window.__nativeInfo || {};
    add('o', '  界析      ' + (ni.v || '?') + (ni.pkg ? ' · ' + ni.pkg : ''));
    add('o', '  shell     ' + ((S.termInfo && S.termInfo.sh) || '/system/bin/sh') + ' · toybox');
    add('o', '  JS        ' + chromeVer());
    if (hasPy) {
      var r = null;
      try { r = window.Py.info(true) } catch (e) { r = { ok: false, err: firstLine(e) } }
      S.info = r;
      S.pyChecked = true;
      S.pyOK = !!(r && r.ok);
      add('o', '  Python    ' + (S.pyOK ? (r.version || '?') : '不可用：' + ((r && r.err) || '?')));
    } else {
      add('o', '  Python    当前包含没有内置解释器');
    }
    add('dimx', '运行时随 APK 更新：升级 CPython / 界面请安装新版 APK（应用内检查更新还没接入）。');
    syncChrome();
    flush();
    if (FP.open) loadPanel(FP.path);
  }

  /* ---------------- 常用命令（双击终端打开 / 长按输出加入） ---------------- */
  function getCmds() {
    var list = null;
    try { list = DB._get(CMD_KEY, null) } catch (e) { list = null; }
    if (!list || !Array.isArray(list)) {
      list = [
        { id: 'd1', n: '看目录', c: 'ls -l' },
        { id: 'd2', n: 'Python', c: 'python' },
        { id: 'd3', n: 'JS', c: 'js' },
        { id: 'd4', n: '站点', c: 'rou sites' },
        { id: 'd5', n: '帮助', c: 'help' }
      ];
      saveCmds(list);
    }
    return list;
  }
  function saveCmds(list) {
    try { DB._set(CMD_KEY, list) } catch (e) { }
  }

  function openCommands() {
    var list = getCmds();
    var html = '<div class="st-grp">常用命令 · 点一下执行，长按编辑/删除</div>';
    html += list.map(function (it) {
      return '<div class="row tap" data-cid="' + esc(it.id) + '"><div class="t">' +
        '<div class="nm mono">' + esc(it.n || it.c) + '</div>' +
        '<div class="ds mono lines2">' + esc(it.c) + '</div></div><div class="arw">▶</div></div>';
    }).join('');
    html += '<div class="row tap" data-cm="add"><div class="t"><div class="nm">＋ 新增常用命令</div>' +
      '<div class="ds">手动填写名称和命令</div></div><div class="arw">›</div></div>';
    html += '<div class="st-note">双击终端任意位置可打开这个列表；长按输出行 →「加入常用命令」也能收录。</div>';
    UI.sheet(html, {
      onOpen: function (pb) {
        $$('[data-cid]', pb).forEach(function (el) {
          var it = null;
          list.forEach(function (x) { if (x.id === el.dataset.cid) it = x; });
          if (!it) return;
          bindLongPress(el, function () {
            UI.closeSheet();
            commandEditSheet(it);
          });
          el.onclick = function () {
            if (el._lpAt && Date.now() - el._lpAt < 800) return;
            UI.closeSheet();
            runCommandLine(it.c);
          };
        });
        var add = $('[data-cm=add]', pb);
        if (add) add.onclick = function () {
          UI.closeSheet();
          commandEditSheet(null);
        };
      }
    });
  }

  function commandEditSheet(it, prefill) {
    var isNew = !it;
    var n0 = isNew ? ((prefill && prefill.n) || '') : (it.n || '');
    var c0 = isNew ? ((prefill && prefill.c) || '') : it.c;
    UI.sheet('<div class="st-grp">' + (isNew ? '新增常用命令' : '编辑常用命令') + '</div>' +
      '<input class="input tm-pin" data-f="n" placeholder="名称（可空）" value="' + esc(n0) + '">' +
      '<input class="input tm-pin" data-f="c" placeholder="命令，例如 ls -l" value="' + esc(c0) + '">' +
      '<div class="tm-facts"><button class="btn ghost" data-c>取消</button>' +
      (isNew ? '' : '<button class="btn ghost" data-d>删除</button>') +
      '<button class="btn pri" data-s>保存</button></div>', {
      onOpen: function (pb) {
        var nInp = $('[data-f=n]', pb), cInp = $('[data-f=c]', pb);
        setTimeout(function () { try { cInp.focus() } catch (e) { } }, 60);
        $('[data-c]', pb).onclick = function () { UI.closeSheet() };
        if (!isNew) {
          $('[data-d]', pb).onclick = function () {
            saveCmds(getCmds().filter(function (x) { return x.id !== it.id }));
            UI.closeSheet();
            UI.toast('已删除');
            openCommands();
          };
        }
        $('[data-s]', pb).onclick = function () {
          var cmd = String(cInp.value || '').trim();
          if (!cmd) { UI.toast('命令不能为空'); return; }
          var name = String(nInp.value || '').trim();
          var list = getCmds();
          var target = null;
          if (!isNew) {
            for (var i = 0; i < list.length; i++) {
              if (list[i].id === it.id) { target = list[i]; break; }
            }
          }
          if (target) {
            target.n = name;
            target.c = cmd;
          } else {
            list.push({ id: 'c' + Date.now().toString(36), n: name, c: cmd });
          }
          saveCmds(list);
          UI.closeSheet();
          UI.toast('已保存');
          if (!isNew) openCommands();
        };
      }
    });
  }

  function showLineMenu(lineText) {
    var sel = '';
    try { sel = String(window.getSelection() || '').trim(); } catch (e) { }
    var text = (sel || String(lineText || '')).trim();
    if (!text) return;
    UI.sheet('<div class="st-grp">输出 · 长按菜单</div>' +
      '<pre class="tm-prev">' + esc(text.slice(0, 4000)) + '</pre>' +
      '<div class="row tap" data-lm="copy"><div class="t"><div class="nm">复制</div></div></div>' +
      '<div class="row tap" data-lm="add"><div class="t"><div class="nm">加入常用命令</div>' +
      '<div class="ds">把这段文字存成一键命令</div></div></div>' +
      '<div class="row tap" data-lm="fill"><div class="t"><div class="nm">填入输入框</div></div></div>' +
      '<div class="row tap" data-lm="run"><div class="t"><div class="nm">直接执行这一行</div></div></div>' +
      '<div class="st-note">' + (sel ? '使用了当前选中的文字' : '没有选中文字，使用点中的那一行') + '</div>', {
      onOpen: function (pb) {
        $$('[data-lm]', pb).forEach(function (el) {
          el.onclick = function () {
            var k = el.dataset.lm;
            UI.closeSheet();
            if (k === 'copy') copyText(text);
            else if (k === 'add') commandEditSheet(null, { n: '', c: text });
            else if (k === 'fill') { ta.value = text; caretEnd(); }
            else if (k === 'run') runCommandLine(text);
          };
        });
      }
    });
  }

  /* ---------------- 长按输出行菜单 / 双击打开常用命令 ---------------- */
  function copyText(txt) {
    var text = String(txt == null ? '' : txt);
    var ok = function () { UI.toast('已复制') };
    var fallback = function () {
      try {
        var t = document.createElement('textarea');
        t.value = text; t.setAttribute('readonly', 'readonly');
        t.style.position = 'fixed'; t.style.left = '-9999px'; t.style.top = '0'; t.style.opacity = '0';
        document.body.appendChild(t);
        t.select(); t.setSelectionRange(0, text.length);
        var r = document.execCommand('copy');
        document.body.removeChild(t);
        if (r) { ok(); return }
      } catch (e) { }
      UI.toast('复制失败');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, fallback);
    } else fallback();
  }
  (function bindGestures() {
    var timer = null, sx = 0, sy = 0, lpAt = 0;
    var cancel = function () { clearTimeout(timer); timer = null };
    term.addEventListener('pointerdown', function (e) {
      var line = e.target && e.target.closest ? e.target.closest('.tm-line') : null;
      if (!line) return;
      sx = e.clientX; sy = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        lpAt = Date.now();
        showLineMenu(line.textContent);
      }, 550);
    });
    term.addEventListener('pointerup', cancel);
    term.addEventListener('pointercancel', cancel);
    term.addEventListener('touchmove', cancel, { passive: true });
    term.addEventListener('pointermove', function (e) {
      if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel();
    });

    /* 双击终端 → 常用命令列表（长按刚触发过菜单时不误判） */
    var lastT = 0, lx = 0, ly = 0;
    term.addEventListener('pointerup', function (e) {
      if (Date.now() - lpAt < 600) return;
      if (e.target && e.target.closest && e.target.closest('.tm-fold')) return;
      var now = Date.now();
      if (now - lastT < 330 && Math.abs(e.clientX - lx) < 26 && Math.abs(e.clientY - ly) < 26) {
        lastT = 0;
        openCommands();
        return;
      }
      lastT = now; lx = e.clientX; ly = e.clientY;
    });
  })();

  /* ---------------- 启动 ---------------- */
  // 先把骨架画出来，再异步探测 Python 与 shell 环境
  render();
  syncChrome();

  var prefillLines = 0;
  if (params.prefill) {
    ta.value = String(params.prefill);
    prefillLines = ta.value.split('\n').length;
  }

  function banner() {
    var ni = window.__nativeInfo || {};
    if (S.lines.length) {
      add('dimx', '— 回到终端 · 输出与会话（cwd / 环境变量 / 解释器）都还在 —');
      return;
    }
    add('hint', '界析终端' + (ni.v ? ' ' + ni.v : '') + ' · ' +
      (hasTerm ? 'Android shell（mksh）' : 'JS 控制台（无 Java 桥）'));
    add('o', '  工作目录  ' + S.cwd);
    if (hasTerm) {
      /* 第一屏就把“能/不能”讲清楚，省得被“真终端”误导 */
      add('o', '  ✓ 真实进程：ls / cat / grep / 管道 / 重定向 / sh 脚本 / 文件面板');
      add('o', '  ' + (S.pyOK ? ('✓ 内置 Python ' + (S.info.version || '') + '（REPL、跑脚本）') : (S.pyChecked ? 'Python 未内置' : 'Python 检测中')) + ' · JS 控制台 · rou 调用 App');
      add('hint', '  ⚠ 不是 Linux 发行版：没有 apt/bash/root/PTY，装不了 Ubuntu');
      add('dimx', '    输入 caps 看完整能力清单 · help 看全部命令 · 双击终端=常用命令');
      add('dimx', '    HOME 是 App 私有目录；cd ~ 回家，📁 打开右侧文件面板');
    } else {
      add('dimx', '  当前只有 js 可用：输入 1+1 试试。');
    }
    if (prefillLines) {
      add('hint', '已从脚本页带入 ' + prefillLines + ' 行，确认后按 Enter 执行');
    }
  }

  function startProbe() {
    var ti = callJSON('termInfo', []);
    if (ti && ti.ok) {
      S.termInfo = ti;
      S.home = ti.home || '/';
      if (!S.cwd || S.cwd === '/') S.cwd = S.home;
    } else if (!hasTerm) {
      S.home = '/';
      S.cwd = '/';
    }
    if (!hasPy) {
      S.pyChecked = true;
      S.pyOK = false;
      syncChrome();
      return;
    }
    /* Py.info() 首启会初始化解释器（2–5s），不能挡住首屏 */
    setTimeout(function () {
      if (!alive) return;
      try {
        S.info = window.Py.info();
        S.pyChecked = true;
        S.pyOK = !!(S.info && S.info.ok);
      } catch (e) {
        S.pyChecked = true;
        S.pyOK = false;
        S.info = { ok: false, err: firstLine(e) };
      }
      syncChrome();
      if (S.pyOK) {
        if (!KEEP.probed) add('dimx', 'Python ' + (pyVer() || '3.x') + ' 就绪：输入 python 进入交互解释器');
        if (KEEP.mode === 'py' && S.mode === 'sh') {
          S.mode = 'py';
          S.more = false;
          S.pyBuf = [];
          KEEP.mode = 'py';
          syncChrome();
        }
      } else {
        if (!KEEP.probed) add('dimx', 'Python 未内置（安装 -WithPython 包后可用）。');
      }
      KEEP.probed = true;
      flush();
    }, 0);
  }

  /* ---------------- 输入法 / 可视区域 ---------------- */
  /* 手机弹出输入法时：收起高度、显示按键条、把输出滚到底，输入框不会被挡住 */
  var vv = window.visualViewport || null;
  var vvResize = null, vvScroll = null;
  function scrollOutEnd() {
    if (term) term.scrollTop = term.scrollHeight;
  }
  function syncViewport() {
    if (!alive) return;
    var kb = 0;
    if (vv) kb = Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0));
    if (kb > 80 && vv) {
      keys.classList.add('on');
      root.style.height = vv.height + 'px';
    } else {
      root.style.height = '';
      if (document.activeElement === ta) keys.classList.add('on');
    }
    setTimeout(scrollOutEnd, 30);
  }
  if (vv) {
    vvResize = function () { syncViewport(); };
    vvScroll = function () { syncViewport(); };
    try {
      vv.addEventListener('resize', vvResize);
      vv.addEventListener('scroll', vvScroll);
    } catch (e) { }
  }
  function showKeys() { keys.classList.add('on'); }
  ta.addEventListener('focus', function () {
    showKeys();
    setTimeout(scrollOutEnd, 60);
  });
  ta.addEventListener('pointerdown', showKeys);
  ta.addEventListener('click', showKeys);
  ta.addEventListener('input', showKeys);
  ta.addEventListener('blur', function () {
    setTimeout(function () {
      if (document.activeElement !== ta) keys.classList.remove('on');
    }, 250);
  });
  root.addEventListener('pointerdown', function (e) {
    var t = e.target;
    if (!t || t === ta) return;
    if (t.closest && (t.closest('.tm-keys') || t.closest('.tm-chips') || t.closest('.tm-input'))) return;
    keys.classList.remove('on');
  });

  startProbe();
  banner();
  if (S.job) {
    setBusy(true);
    add('dimx', '上一条命令仍在后台运行（输出会继续出现在这里）');
  }
  flush();
  setTimeout(function () { if (alive) caretEnd() }, 120);

  /* 离开页面：停任务、清事件、取消待渲染帧；状态留在 KEEP 里供下次挂载恢复 */
  if (st) st.cleanup = function () {
    alive = false;
    KEEP.cwd = S.cwd;
    KEEP.mode = S.mode;
    KEEP.dropped = S.dropped;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    try { if (vv && vvResize) { vv.removeEventListener('resize', vvResize); vv.removeEventListener('scroll', vvScroll); } } catch (e) { }
    try { root.style.height = ''; } catch (e) { }
    FP.open = false;
    try { if (window.__termEv === onTermEv) window.__termEv = null; } catch (e) { }
    try { if (window.__pipEv === pipEvent) window.__pipEv = null; } catch (e) { }
    pipJob = null;
    try { window.__termBack = null; } catch (e) { }
    try { if (hasTerm && window.Native.termKillAll) window.Native.termKillAll(); } catch (e) { }
    S.job = null;
    KEEP.job = null;
    S._done = null;
  };

  return Promise.resolve();
};
