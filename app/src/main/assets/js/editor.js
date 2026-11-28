/* editor.js — RouParser 脚本编辑器：自包含语法高亮组件 window.CodeEditor
 *
 * 设计要点（不要改坏）：
 *   1. 高亮层是 <pre><code>，输入层是透明文字的 <textarea>，两层字体 / 字号 /
 *      行高 / padding / white-space 必须完全一致；JS 会读取计算样式做兜底。
 *   2. 滚动时 textarea 是唯一滚动容器；pre 里的 code 用 transform 反向位移，
 *      行号栏同步 scrollTop，避免长文本下重排。
 *   3. 分词器自己实现，不引外部库；所有 token 文本都经过 HTML 转义。
 *   4. 超过 2000 行自动降级：隐藏高亮层，textarea 恢复可见文字，底部给出提示。
 *
 * 用法：
 *   var ed = window.CodeEditor(container, {
 *     value: 'const a = 1;',
 *     lang: 'js',                    // js | py | json | plain
 *     readOnly: false,
 *     onChange: function (v) { ... }
 *   });
 *   ed.setValue(v); ed.getValue(); ed.setLang('py'); ed.setReadOnly(true);
 *   ed.focus(); ed.destroy();
 *
 * 样式：css/extra-d1.css 中 .ce-* 段落；颜色由 --ce-* 组件变量提供。
 * 兼容：ES2019（无 ?. / ?? / .at()），无 import/export。
 */
(function (root) {
  'use strict';

  /* ============================== 常量 ============================== */

  var MAX_LINES = 2000;   // 超过该行数降级为纯文本
  var THROTTLE_MS = 30;   // 输入 / 粘贴后的高亮节流
  var TAB = '    ';       // Tab 一律插入 4 个空格
  var WINDOW_BUF = 40;    // 虚拟渲染：视口上下各多渲染的行数

  /* 关键字表：用空格串生成查表对象，避免每次分词都做数组 indexOf */
  function setOf(str) {
    var o = {}, arr = str.split(' ');
    for (var i = 0; i < arr.length; i++) if (arr[i]) o[arr[i]] = 1;
    return o;
  }

  var JS_KW = setOf(
    'as async await break case catch class const continue debugger default delete do else ' +
    'export extends false finally for from function get if import in instanceof let new null ' +
    'of return set static super switch this throw true try typeof undefined var void while with ' +
    'yield NaN Infinity'
  );
  /* 这些关键字后面的 / 更可能是正则字面量，而不是除号 */
  var REGEX_KW = setOf('return typeof instanceof in of new delete void case do else yield await');

  var PY_KW = setOf(
    'False None True and as assert async await break class continue def del elif else except ' +
    'finally for from global if import in is lambda nonlocal not or pass raise return try ' +
    'while with yield match case'
  );

  var JSON_KW = setOf('true false null');

  /* 多字符运算符（长在前，最长匹配）；单字符标点另用集合 */
  var JS_PUNCT = [
    '>>>=', '===', '!==', '>>>', '**=', '&&=', '||=', '??=', '<<=', '>>=',
    '...', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '**', '++', '--',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '->'
  ];
  var PY_PUNCT = [
    '**=', '//=', '>>=', '<<=', '...', ':=', '->', '==', '!=', '<=', '>=',
    '**', '//', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>'
  ];
  var SINGLE_PUNCT = {};
  (function () {
    var chars = '{}[]().,;:?+-*/%&|^!~=<>#@';
    for (var i = 0; i < chars.length; i++) SINGLE_PUNCT[chars.charAt(i)] = 1;
  })();

  var NUM_JS = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)[nN]?/;
  var NUM_PY = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?)[jJ]?/;
  var NUM_JSON = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
  var PY_PREFIX = /^(?:[rRbBuUfF]{1,2})?('''|"""|'|")/;

  /* token 类型 -> CSS 类；'plain' / 'id' 不包 span（保持最少 DOM） */
  var LANGS = {};

  var TOKEN_CLASS = {
    kw: 'ce-kw',
    str: 'ce-str',
    num: 'ce-num',
    com: 'ce-com',
    fn: 'ce-fn',
    punct: 'ce-punct',
    key: 'ce-key',
    dec: 'ce-dec',
    type: 'ce-type',
    const: 'ce-const',
    builtin: 'ce-bi'
  };

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /* ============================== 基础工具 ============================== */

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  function isDigit(c) {
    return c >= '0' && c <= '9';
  }

  function isIdStart(c) {
    if (!c) return false;
    var k = c.charCodeAt(0);
    return (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 95 || k === 36;
  }

  function isIdPart(c) {
    if (!c) return false;
    var k = c.charCodeAt(0);
    return (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || (k >= 48 && k <= 57) || k === 95 || k === 36;
  }

  function isSpace(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
  }

  /* 从 start 起匹配多字符/单字符标点，失败返回 '' */
  function matchPunct(src, start, multi, single) {
    var c = src.charAt(start);
    for (var i = 0; i < multi.length; i++) {
      var p = multi[i];
      if (p.charAt(0) === c && src.substr(start, p.length) === p) return p;
    }
    return single[c] ? c : '';
  }

  /* ============================== 分词器：JavaScript ============================== */

  /* 单/双引号字符串；遇到未闭合的换行就止损，避免整篇变色 */
  function scanQuoted(src, start, quote) {
    var n = src.length, j = start + 1;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (c === quote) return j + 1;
      if (c === '\n') return j;
      j++;
    }
    return n;
  }

  /* 模板串：内嵌 ${ ... } 里的内容也一并按字符串着色（够用且快） */
  function scanTemplate(src, start) {
    var n = src.length, j = start + 1, depth = 0;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (depth === 0 && c === '`') return j + 1;
      if (c === '$' && src.charAt(j + 1) === '{') { depth++; j += 2; continue; }
      if (depth > 0 && c === '}') { depth--; j++; continue; }
      j++;
    }
    return n;
  }

  /* 正则字面量：支持转义与 [...] 字符类；不是合法正则则返回 start+1 */
  function scanRegex(src, start) {
    var n = src.length, j = start + 1, inClass = false;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') return start + 1;
      if (inClass) {
        if (c === ']') inClass = false;
      } else if (c === '[') {
        inClass = true;
      } else if (c === '/') {
        j++;
        while (j < n && /[a-zA-Z]/.test(src.charAt(j))) j++;
        return j;
      }
      j++;
    }
    return start + 1;
  }

  function tokenizeJS(src) {
    var out = [], plain = '', i = 0, n = src.length;
    var prevKind = '', prevVal = '';

    function flush() {
      if (plain) { out.push({ t: 'plain', v: plain }); plain = ''; }
    }
    function emit(t, v, track) {
      flush();
      out.push({ t: t, v: v });
      if (track !== false) { prevKind = t; prevVal = v; }
    }
    function regexAllowed() {
      if (!prevKind) return true;
      if (prevKind === 'punct') return /^[([{,;:!&|?=+\-*%<>^~]$/.test(prevVal);
      if (prevKind === 'kw') return !!REGEX_KW[prevVal];
      return false;
    }

    while (i < n) {
      var c = src.charAt(i);

      if (isSpace(c)) { plain += c; i++; continue; }

      /* 行注释 / 块注释 */
      if (c === '/' && src.charAt(i + 1) === '/') {
        var e1 = src.indexOf('\n', i);
        if (e1 < 0) e1 = n;
        emit('com', src.slice(i, e1), false);
        i = e1;
        continue;
      }
      if (c === '/' && src.charAt(i + 1) === '*') {
        var e2 = src.indexOf('*/', i + 2);
        e2 = e2 < 0 ? n : e2 + 2;
        emit('com', src.slice(i, e2), false);
        i = e2;
        continue;
      }
      /* 正则字面量（放在注释之后，避免 / 被当成除号） */
      if (c === '/' && regexAllowed()) {
        var re = scanRegex(src, i);
        if (re > i + 1) {
          emit('str', src.slice(i, re));
          i = re;
          continue;
        }
      }

      if (c === '"' || c === "'") {
        var q = scanQuoted(src, i, c);
        emit('str', src.slice(i, q));
        i = q;
        continue;
      }
      if (c === '`') {
        var tpl = scanTemplate(src, i);
        emit('str', src.slice(i, tpl));
        i = tpl;
        continue;
      }

      if (isDigit(c) || (c === '.' && isDigit(src.charAt(i + 1)))) {
        var mn = NUM_JS.exec(src.slice(i));
        var nlen = mn ? mn[0].length : 1;
        emit('num', src.slice(i, i + nlen));
        i += nlen;
        continue;
      }

      if (isIdStart(c)) {
        var j = i + 1;
        while (j < n && isIdPart(src.charAt(j))) j++;
        var word = src.slice(i, j);
        if (JS_KW[word]) {
          emit('kw', word);
        } else {
          var k = j;
          while (k < n && isSpace(src.charAt(k))) k++;
          emit(src.charAt(k) === '(' ? 'fn' : 'id', word);
        }
        i = j;
        continue;
      }

      var p = matchPunct(src, i, JS_PUNCT, SINGLE_PUNCT);
      if (p) { emit('punct', p); i += p.length; continue; }

      plain += c;
      i++;
    }
    flush();
    return out;
  }

  /* ============================== 分词器：Python ============================== */

  function pyStringStart(src, i) {
    if (i > 0 && isIdPart(src.charAt(i - 1))) return false;
    return PY_PREFIX.test(src.slice(i, i + 5));
  }

  function scanPyString(src, start) {
    var m = PY_PREFIX.exec(src.slice(start));
    if (!m) return start + 1;
    var quote = m[1], j = start + m[0].length, n = src.length;
    if (quote.length === 3) {
      while (j < n) {
        if (src.charAt(j) === '\\') { j += 2; continue; }
        if (src.substr(j, 3) === quote) return j + 3;
        j++;
      }
      return n;
    }
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (c === quote) return j + 1;
      if (c === '\n') return j;
      j++;
    }
    return n;
  }

  function tokenizePy(src) {
    var out = [], plain = '', i = 0, n = src.length;

    function flush() {
      if (plain) { out.push({ t: 'plain', v: plain }); plain = ''; }
    }
    function emit(t, v) {
      flush();
      out.push({ t: t, v: v });
    }

    while (i < n) {
      var c = src.charAt(i);

      if (isSpace(c)) { plain += c; i++; continue; }

      if (c === '#') {
        var e = src.indexOf('\n', i);
        if (e < 0) e = n;
        emit('com', src.slice(i, e));
        i = e;
        continue;
      }

      /* r'' / b"" / f'''...''' / 三引号 */
      if (c === "'" || c === '"' || /[rRbBuUfF]/.test(c)) {
        if (pyStringStart(src, i)) {
          var se = scanPyString(src, i);
          emit('str', src.slice(i, se));
          i = se;
          continue;
        }
        if (c === "'" || c === '"') {
          var q = scanQuoted(src, i, c);
          emit('str', src.slice(i, q));
          i = q;
          continue;
        }
      }

      /* 装饰器 @app.route(...) */
      if (c === '@' && isIdStart(src.charAt(i + 1))) {
        var dj = i + 1;
        while (dj < n && (isIdPart(src.charAt(dj)) || src.charAt(dj) === '.')) dj++;
        emit('dec', src.slice(i, dj));
        i = dj;
        continue;
      }

      if (isDigit(c) || (c === '.' && isDigit(src.charAt(i + 1)))) {
        var mn = NUM_PY.exec(src.slice(i));
        var nlen = mn ? mn[0].length : 1;
        emit('num', src.slice(i, i + nlen));
        i += nlen;
        continue;
      }

      if (isIdStart(c)) {
        var j = i + 1;
        while (j < n && isIdPart(src.charAt(j))) j++;
        var word = src.slice(i, j);
        if (PY_KW[word]) {
          emit('kw', word);
        } else {
          var k = j;
          while (k < n && isSpace(src.charAt(k))) k++;
          emit(src.charAt(k) === '(' ? 'fn' : 'id', word);
        }
        i = j;
        continue;
      }

      /* Python 没有正则字面量；/ 一律是运算符 */
      if (c === '/' && src.charAt(i + 1) === '/') {
        emit('punct', '//');
        i += 2;
        continue;
      }
      var p = matchPunct(src, i, PY_PUNCT, SINGLE_PUNCT);
      if (p) { emit('punct', p); i += p.length; continue; }

      plain += c;
      i++;
    }
    flush();
    return out;
  }

  /* ============================== 分词器：JSON ============================== */

  function scanJSONString(src, start) {
    var n = src.length, j = start + 1;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (c === '"') return j + 1;
      j++;
    }
    return n;
  }

  function tokenizeJSON(src) {
    var out = [], plain = '', i = 0, n = src.length;

    function flush() {
      if (plain) { out.push({ t: 'plain', v: plain }); plain = ''; }
    }
    function emit(t, v) {
      flush();
      out.push({ t: t, v: v });
    }

    while (i < n) {
      var c = src.charAt(i);

      if (isSpace(c)) { plain += c; i++; continue; }

      /* 字符串：后面（跳过空白）是冒号就是键 */
      if (c === '"') {
        var e = scanJSONString(src, i);
        var word = src.slice(i, e);
        var k = e;
        while (k < n && isSpace(src.charAt(k))) k++;
        emit(src.charAt(k) === ':' ? 'key' : 'str', word);
        i = e;
        continue;
      }

      if (c === '-' || isDigit(c)) {
        var mn = NUM_JSON.exec(src.slice(i));
        if (mn && mn[0].length) {
          emit('num', mn[0]);
          i += mn[0].length;
          continue;
        }
      }

      /* true / false / null，要求词边界 */
      if (isIdStart(c)) {
        var j = i + 1;
        while (j < n && isIdPart(src.charAt(j))) j++;
        var w = src.slice(i, j);
        emit(JSON_KW[w] ? 'kw' : 'plain', w);
        i = j;
        continue;
      }

      if (SINGLE_PUNCT[c]) {
        emit('punct', c);
        i++;
        continue;
      }

      plain += c;
      i++;
    }
    flush();
    return out;
  }

  /* 通用语言高亮：插件通过 CodeEditor.registerLanguage(name, profile) 注册 */
  function tokenizeGeneric(src, p) {
    var out = [], buf = '', i = 0, n = src.length;
    var kw = {}, list = p.keywords || [];
    for (var k = 0; k < list.length; k++) kw[list[k]] = 1;
    var types = {}, consts = {}, fns = {};
    (p.types || []).forEach(function (x) { types[x] = 1 });
    (p.constants || []).forEach(function (x) { consts[x] = 1 });
    (p.functions || []).forEach(function (x) { fns[x] = 1 });
    var qs = p.quotes || ['"', "'"];
    function flush() { if (buf) { out.push({ t: 'plain', v: buf }); buf = '' } }
    function push(t, v) { flush(); out.push({ t: t, v: v }); }
    while (i < n) {
      var c = src[i], c2 = src.substr(i, 2), c3 = src.substr(i, 3);
      if (p.blockComment && c2 === p.blockComment[0]) {
        var e = src.indexOf(p.blockComment[1], i + 2);
        if (e < 0) e = n; else e += p.blockComment[1].length;
        push('com', src.slice(i, e)); i = e; continue;
      }
      if (p.lineComment && src.substr(i, p.lineComment.length) === p.lineComment) {
        var le = src.indexOf('\n', i); if (le < 0) le = n;
        push('com', src.slice(i, le)); i = le; continue;
      }
      if (qs.indexOf(c) >= 0) {
        var j = i + 1, esc = false;
        while (j < n) { var d = src[j]; if (esc) { esc = false; j++; continue; } if (d === '\\') { esc = true; j++; continue; } if (d === c) { j++; break; } j++; }
        push('str', src.slice(i, j)); i = j; continue;
      }
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
        var st = i; i++; while (i < n && (isDigit(src[i]) || src[i] === '.' || src[i] === 'x' || /[a-fA-F]/.test(src[i]))) i++;
        push('num', src.slice(st, i)); continue;
      }
      if (isIdStart(c)) {
        var st2 = i; i++; while (i < n && (isIdStart(src[i]) || isDigit(src[i]))) i++;
        var word = src.slice(st2, i);
        if (kw[word]) push('kw', word);
        else if (types[word]) push('type', word);
        else if (consts[word]) push('const', word);
        else if (fns[word] || (p.functions && src[i] === '(')) push('fn', word);
        else buf += word;
        continue;
      }
      if ('{}[]()<>=+-*/%!&|:;,.'.indexOf(c) >= 0) { push('punct', c); i++; continue; }
      buf += c; i++;
    }
    flush();
    return out;
  }

  function tokenize(src, lang) {
    if (LANGS[lang]) return tokenizeGeneric(src, LANGS[lang]);
    if (lang === 'py') return tokenizePy(src);
    if (lang === 'json') return tokenizeJSON(src);
    if (lang === 'plain') return [{ t: 'plain', v: src }];
    return tokenizeJS(src);
  }

  function renderHTML(tokens) {
    var parts = new Array(tokens.length);
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i], cls = TOKEN_CLASS[tk.t];
      parts[i] = cls ? '<span class="' + cls + '">' + escHtml(tk.v) + '</span>' : escHtml(tk.v);
    }
    return parts.join('');
  }

  /* 虚拟渲染：只把 [start, end] 行拼成 HTML，前面用换行占位保持纵向坐标。
     这样 1000 行文件每次输入也只创建一屏左右的 span，而不是上万个。 */
  function renderWindowHTML(tokens, start, end, total, value) {
    var count = end - start + 1;
    var out = new Array(count);
    for (var k = 0; k < count; k++) out[k] = '';
    var line = 0;

    for (var i = 0; i < tokens.length && line <= end; i++) {
      var tk = tokens[i], cls = TOKEN_CLASS[tk.t], text = tk.v;
      if (text.indexOf('\n') === -1) {
        if (line >= start) {
          out[line - start] += cls ? '<span class="' + cls + '">' + escHtml(text) + '</span>' : escHtml(text);
        }
        continue;
      }
      var segs = text.split('\n');
      for (var s = 0; s < segs.length; s++) {
        if (s > 0) line++;
        if (line > end) break;
        if (line >= start && segs[s]) {
          out[line - start] += cls ? '<span class="' + cls + '">' + escHtml(segs[s]) + '</span>' : escHtml(segs[s]);
        }
      }
    }

    var html = start > 0 ? new Array(start + 1).join('\n') : '';
    for (var j = 0; j < count; j++) {
      html += out[j];
      if (start + j < end) html += '\n';
    }
    if (!html) html = '\n';
    /* 末尾换行时，lines 里已包含最后那个空行，不需要再补 */
    return html;
  }

  function normLang(lang) {
    var s = String(lang == null ? '' : lang).toLowerCase();
    if (LANGS[s]) return s;
    if (s === 'py' || s === 'python') return 'py';
    if (s === 'json') return 'json';
    if (s === 'plain' || s === 'text' || s === 'txt') return 'plain';
    return 'js';
  }

  /* ============================== 组件 ============================== */

  function CodeEditor(container, opts) {
    if (!container) throw new Error('CodeEditor: 容器不能为空');
    opts = opts || {};

    var doc = container.ownerDocument || document;
    var win = doc.defaultView || window;

    /* 同一容器重复创建时，先销毁旧实例，避免监听器泄漏 */
    if (container.__codeEditor && container.__codeEditor.destroy) {
      try { container.__codeEditor.destroy(); } catch (e) { }
    }

    var state = {
      lang: normLang(opts.lang || 'js'),
      lite: false,
      lineCount: -1,
      timer: 0,
      lh: 19,          // 行高（px）：从计算样式读取
      padY: 12,        // 上下 padding（px）
      ro: !!opts.readOnly,
      destroyed: false,
      composing: false,
      /* 高亮缓存：token 只随内容 / 语言变化重算，滚动时只重拼窗口 */
      tokens: null,
      tokensValue: null,
      tokensLang: '',
      viewStart: -1,
      viewEnd: -1,
      /* 撤销 / 重做：整值快照（120 步），输入、Tab、注释、符号插入都记账 */
      hist: [],
      hpos: -1,
      applying: false,
      onChange: typeof opts.onChange === 'function' ? opts.onChange : null
    };

    /* ---------- DOM 骨架 ---------- */
    container.innerHTML = '';
    var el = doc.createElement('div');
    el.className = 'ce';
    el.innerHTML =
      '<div class="ce-gutter"><div class="ce-curg"></div><span class="ce-gln">1</span></div>' +
      '<div class="ce-wrap">' +
        '<div class="ce-cur"></div>' +
        '<pre class="ce-hl" aria-hidden="true"><code></code></pre>' +
        '<textarea class="ce-ta" spellcheck="false" autocapitalize="off" autocorrect="off" wrap="off"></textarea>' +
      '</div>' +
      '<div class="ce-note" aria-live="polite"></div>';
    container.appendChild(el);

    var gut = el.querySelector('.ce-gutter');
    var gln = el.querySelector('.ce-gln');
    var curg = el.querySelector('.ce-curg');
    var code = el.querySelector('code');
    var note = el.querySelector('.ce-note');
    var ta = el.querySelector('.ce-ta');
    var cur = el.querySelector('.ce-cur');

    if (opts.placeholder) ta.placeholder = String(opts.placeholder);
    ta.setAttribute('aria-label', opts.label ? String(opts.label) : '代码编辑器');

    /* ---------- 度量：保证行号 / 高亮层 / textarea 同步 ---------- */
    function readMetrics() {
      if (!win.getComputedStyle) return;
      var cs = win.getComputedStyle(ta);
      var lh = parseFloat(cs.lineHeight);
      var pt = parseFloat(cs.paddingTop);
      if (lh > 0) state.lh = lh;
      if (!isNaN(pt)) state.padY = pt;
      cur.style.height = state.lh + 'px';
      curg.style.height = state.lh + 'px';
    }

    /* ---------- 行号 ---------- */
    function countLines(v) {
      var n = 1, idx = -1;
      while ((idx = v.indexOf('\n', idx + 1)) !== -1) n++;
      return n;
    }

    function updateGutter(n) {
      if (n === state.lineCount) return;
      state.lineCount = n;
      var buf = '';
      for (var i = 1; i <= n; i++) {
        buf += i;
        if (i < n) buf += '\n';
      }
      gln.textContent = buf;
      var digits = Math.max(3, String(n).length);
      gut.style.width = 'calc(' + digits + 'ch + 18px)';
    }

    /* ---------- 滚动同步 ---------- */
    function syncScroll() {
      if (state.destroyed) return;
      var sl = ta.scrollLeft, st = ta.scrollTop;
      code.style.transform = 'translate(' + (-sl) + 'px,' + (-st) + 'px)';
      gut.scrollTop = st;
      ensureWindow();
      updateCurrent();
    }

    /* 虚拟渲染：可视窗口变化到缓冲区边缘时，重拼高亮层 */
    function ensureWindow() {
      if (state.destroyed || state.lite || !state.tokens) return;
      if (state.tokensValue !== ta.value) return; // 等节流后的 render 统一处理
      var first = Math.floor(ta.scrollTop / state.lh);
      var vis = Math.max(1, Math.ceil((ta.clientHeight || state.lh * 10) / state.lh) + 1);
      if (state.viewStart < 0 || first < state.viewStart + 2 || first + vis > state.viewEnd - 2) {
        paintWindow();
      }
    }

    /* 按当前 scrollTop 计算窗口并渲染；行号用换行占位保证纵向坐标不变 */
    function paintWindow() {
      if (state.destroyed || state.lite || !state.tokens) return;
      var total = state.lineCount;
      if (total < 1) total = 1;
      var first = Math.floor(ta.scrollTop / state.lh);
      var vis = Math.max(1, Math.ceil((ta.clientHeight || state.lh * 10) / state.lh) + 1);
      var start = Math.max(0, first - WINDOW_BUF);
      var end = Math.min(total - 1, first + vis + WINDOW_BUF);
      if (start > end) start = end;
      state.viewStart = start;
      state.viewEnd = end;
      code.innerHTML = renderWindowHTML(state.tokens, start, end, total, ta.value);
    }

    function caretLine() {
      var v = ta.value, pos = ta.selectionStart, line = 0;
      var idx = v.indexOf('\n');
      while (idx !== -1 && idx < pos) {
        line++;
        idx = v.indexOf('\n', idx + 1);
      }
      return line;
    }

    /* ---------- 光标行高亮 ---------- */
    function updateCurrent() {
      if (state.destroyed) return;
      if (state.lite) {
        cur.style.display = 'none';
        curg.style.display = 'none';
        return;
      }
      var line = caretLine();
      cur.style.display = 'block';
      curg.style.display = 'block';
      cur.style.top = (state.padY + line * state.lh - ta.scrollTop) + 'px';
      /* 行号栏是独立滚动容器，标记用内容坐标即可跟着滚 */
      curg.style.top = (state.padY + line * state.lh) + 'px';
    }

    /* ---------- 渲染（分词 + 着色） ---------- */
    function render() {
      if (state.destroyed) return;
      var v = ta.value;
      var lines = countLines(v);
      updateGutter(lines);

      var lite = lines > MAX_LINES;
      if (lite !== state.lite) {
        state.lite = lite;
        el.classList.toggle('ce-lite', lite);
      }
      if (lite) {
        code.textContent = '';
        state.tokens = null;
        state.viewStart = state.viewEnd = -1;
        note.textContent = '已超过 ' + MAX_LINES + ' 行（当前 ' + lines + ' 行），已关闭语法高亮，仅保留行号';
        updateCurrent();
        return;
      }

      if (!state.tokens || state.tokensValue !== v || state.tokensLang !== state.lang) {
        state.tokens = tokenize(v, state.lang);
        state.tokensValue = v;
        state.tokensLang = state.lang;
      }
      state.viewStart = state.viewEnd = -1;
      paintWindow();
      syncScroll();
    }

    function schedule() {
      if (state.timer) return;
      state.timer = setTimeout(function () {
        state.timer = 0;
        render();
      }, THROTTLE_MS);
    }

    /* ---------- 变更通知 ---------- */
    function emitChange() {
      if (!state.onChange) return;
      try {
        state.onChange(ta.value, api);
      } catch (err) {
        if (win.console && win.console.error) win.console.error('[CodeEditor] onChange:', err);
      }
    }

    function notifyEdit() {
      /* 自定义编辑（Tab / Enter / 注释）也派发 input，宿主原有监听仍能收到 */
      try {
        ta.dispatchEvent(new win.Event('input', { bubbles: true }));
      } catch (e) {
        onInput();
      }
    }

    /* ---------- textarea 事件 ---------- */
    function onInput() {
      if (state.destroyed) return;
      record();
      schedule();
      emitChange();
      updateCurrent();
    }

    /* ---------- 撤销 / 重做 ---------- */
    var HIST_MAX = 120;
    function record() {
      if (state.applying) return;
      var snap = { v: ta.value, a: ta.selectionStart, b: ta.selectionEnd };
      var cur = state.hist[state.hpos];
      if (cur && cur.v === snap.v) {
        cur.a = snap.a;
        cur.b = snap.b;
        return;
      }
      state.hist = state.hist.slice(0, state.hpos + 1);
      state.hist.push(snap);
      if (state.hist.length > HIST_MAX) state.hist.shift();
      state.hpos = state.hist.length - 1;
    }

    function applySnap(snap) {
      state.applying = true;
      ta.value = snap.v;
      ta.selectionStart = Math.min(snap.a, snap.v.length);
      ta.selectionEnd = Math.min(snap.b, snap.v.length);
      state.lineCount = -1;
      render();
      state.applying = false;
      emitChange();
      scrollCaretIntoView();
    }

    function undo() {
      if (state.hpos <= 0) return false;
      state.hpos--;
      applySnap(state.hist[state.hpos]);
      return true;
    }

    function redo() {
      if (state.hpos >= state.hist.length - 1) return false;
      state.hpos++;
      applySnap(state.hist[state.hpos]);
      return true;
    }

    function onKeyDown(e) {
      if (state.destroyed || state.ro) return;
      if (e.isComposing || e.keyCode === 229) return;

      var key = e.key || '';
      var codeKey = e.keyCode || 0;

      if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'Z' || key === 'y' || key === 'Y')) {
        e.preventDefault();
        if ((key === 'z' || key === 'Z') && !e.shiftKey) undo();
        else redo();
        return;
      }
      if (key === 'Tab' || codeKey === 9) {
        e.preventDefault();
        doTab(!!e.shiftKey);
        return;
      }
      if (key === 'Enter' || codeKey === 13) {
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return; // Ctrl+Enter 等交给宿主
        e.preventDefault();
        doEnter();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (key === '/' || key === '?' || e.code === 'Slash' || codeKey === 191)) {
        e.preventDefault();
        doComment();
      }
    }

    function onScroll() {
      syncScroll();
    }

    function onSelection() {
      updateCurrent();
    }

    function onCompositionStart() {
      state.composing = true;
    }

    function onCompositionEnd() {
      state.composing = false;
      schedule();
      emitChange();
      updateCurrent();
    }

    /* 容器尺寸变化（旋转 / 分屏 / 切模式）时重算窗口；用 ResizeObserver
       而不是 window.resize，避免页面销毁后监听器泄漏。 */
    var ro = null;
    if (win.ResizeObserver) {
      try {
        ro = new win.ResizeObserver(function () {
          if (state.destroyed) return;
          readMetrics();
          if (state.tokens && state.tokensValue === ta.value) paintWindow();
          syncScroll();
        });
        ro.observe(el);
      } catch (e) {
        ro = null;
      }
    }

    /* ---------- 编辑操作 ---------- */
    /* 计算一次编辑影响的整行区间：[start, end] */
    function lineRange(v, a, b) {
      var endPos = (b > a && v.charAt(b - 1) === '\n') ? b - 1 : b;
      var start = v.lastIndexOf('\n', a - 1) + 1;
      var end = v.indexOf('\n', endPos);
      if (end < 0) end = v.length;
      return { start: start, end: end };
    }

    /* 对整行区间逐行做变换，返回替换文本与新选区（近似） */
    function editLines(fn) {
      var v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
      var r = lineRange(v, a, b);
      var lines = v.slice(r.start, r.end).split('\n');
      var out = [], deltaFirst = 0, deltaAll = 0;
      for (var i = 0; i < lines.length; i++) {
        var nl = fn(lines[i]);
        var d = nl.length - lines[i].length;
        if (i === 0) deltaFirst = d;
        deltaAll += d;
        out.push(nl);
      }
      var selStart = Math.max(r.start, a + deltaFirst);
      var selEnd = a === b ? selStart : Math.max(selStart, b + deltaAll);
      return { start: r.start, end: r.end, text: out.join('\n'), selStart: selStart, selEnd: selEnd };
    }

    function applyEdit(r) {
      ta.setRangeText(r.text, r.start, r.end, 'end');
      var len = ta.value.length;
      ta.selectionStart = Math.min(r.selStart, len);
      ta.selectionEnd = Math.min(Math.max(r.selEnd, ta.selectionStart), len);
      notifyEdit();
      scrollCaretIntoView();
    }

    function insertText(txt) {
      var a = ta.selectionStart, b = ta.selectionEnd;
      ta.setRangeText(txt, a, b, 'end');
      notifyEdit();
      scrollCaretIntoView();
    }

    function doTab(shift) {
      var v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
      var multi = v.slice(a, b).indexOf('\n') !== -1;
      if (!shift && !multi) {
        insertText(TAB);
        return;
      }
      var r = editLines(function (line) {
        if (!shift) return TAB + line;
        var m = /^(\t| {1,4})/.exec(line);
        return m ? line.slice(m[0].length) : line;
      });
      if (r.text === v.slice(r.start, r.end)) return;
      applyEdit(r);
    }

    function doEnter() {
      var v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
      var ls = v.lastIndexOf('\n', a - 1) + 1;
      var le = v.indexOf('\n', a);
      if (le < 0) le = v.length;
      var lineText = v.slice(ls, le);
      var m = /^[ \t]*/.exec(lineText);
      var indent = m ? m[0] : '';
      var extra = '';
      if (state.lang === 'py') {
        /* 行尾冒号（去掉注释后）再缩进一级 */
        var codePart = lineText.replace(/#.*$/, '').replace(/[ \t]+$/, '');
        if (/:\s*$/.test(codePart)) extra = TAB;
      }
      var text = '\n' + indent + extra;
      ta.setRangeText(text, a, b, 'end');
      ta.selectionStart = ta.selectionEnd = a + text.length;
      notifyEdit();
      scrollCaretIntoView();
    }

    function commentToken() {
      if (state.lang === 'py') return '#';
      if (state.lang === 'json') return ''; // JSON 不支持注释
      return '//';
    }

    function doComment() {
      var tok = commentToken();
      if (!tok) return;
      var v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
      var r = lineRange(v, a, b);
      var lines = v.slice(r.start, r.end).split('\n');
      var nonBlank = [];
      for (var i = 0; i < lines.length; i++) if (lines[i].trim()) nonBlank.push(lines[i]);
      if (!nonBlank.length) return;

      var allCommented = true;
      for (var j = 0; j < nonBlank.length; j++) {
        var stripped = nonBlank[j].replace(/^[ \t]*/, '');
        if (stripped.indexOf(tok) !== 0) { allCommented = false; break; }
      }

      var edit = editLines(function (line) {
        if (!line.trim()) return line;
        var lead = /^[ \t]*/.exec(line)[0];
        var rest = line.slice(lead.length);
        if (allCommented) {
          if (rest.indexOf(tok) !== 0) return line;
          rest = rest.slice(tok.length);
          if (rest.charAt(0) === ' ') rest = rest.slice(1);
          return lead + rest;
        }
        return lead + tok + ' ' + rest;
      });
      if (edit.text === v.slice(edit.start, edit.end)) return;
      applyEdit(edit);
    }

    /* 编辑后把光标行滚进可视区 */
    function scrollCaretIntoView() {
      var line = caretLine();
      var top = state.padY + line * state.lh;
      var viewH = ta.clientHeight;
      if (viewH > 0) {
        if (top < ta.scrollTop + state.padY) {
          ta.scrollTop = Math.max(0, top - state.padY);
        } else if (top + state.lh > ta.scrollTop + viewH) {
          ta.scrollTop = top + state.lh - viewH;
        }
      }
      syncScroll();
    }

    /* ---------- 对外 API ---------- */
    var api = {
      /* 设置内容：统一换行，重置滚动；不会触发 onChange */
      setValue: function (v) {
        var s = v == null ? '' : String(v);
        s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        ta.value = s;
        ta.scrollTop = 0;
        ta.scrollLeft = 0;
        ta.selectionStart = ta.selectionEnd = 0;
        state.lineCount = -1;
        state.hist = [{ v: s, a: 0, b: 0 }];
        state.hpos = 0;
        render();
        return api;
      },
      getValue: function () { return ta.value; },
      setLang: function (lang) {
        state.lang = normLang(lang);
        state.lineCount = -1; // 强制重绘行号宽度之外的高亮
        render();
        return api;
      },
      getLang: function () { return state.lang; },
      focus: function () { ta.focus(); return api; },
      setReadOnly: function (flag) {
        state.ro = !!flag;
        ta.readOnly = state.ro;
        el.classList.toggle('ce-ro', state.ro);
        return api;
      },
      /* 注册变更回调；传 null 取消 */
      onChange: function (fn) {
        state.onChange = typeof fn === 'function' ? fn : null;
        return api;
      },
      /* 撤销 / 重做（也支持 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y） */
      undo: function () { return undo(); },
      redo: function () { return redo(); },
      canUndo: function () { return state.hpos > 0; },
      canRedo: function () { return state.hpos < state.hist.length - 1; },
      /* 在光标处插入文本（快捷符号条用） */
      insert: function (text, caretBack) {
        var a = ta.selectionStart, b = ta.selectionEnd;
        var t = String(text == null ? '' : text);
        ta.setRangeText(t, a, b, 'end');
        var pos = a + t.length - (caretBack || 0);
        ta.selectionStart = ta.selectionEnd = Math.max(0, Math.min(pos, ta.value.length));
        notifyEdit();
        scrollCaretIntoView();
        try { ta.focus() } catch (e) { }
        return api;
      },
      /* 用一对符号包住选区（没有选区时插到中间） */
      wrap: function (open, close) {
        var a = ta.selectionStart, b = ta.selectionEnd;
        var sel = ta.value.slice(a, b);
        ta.setRangeText(open + sel + close, a, b, 'end');
        if (b === a) {
          ta.selectionStart = ta.selectionEnd = a + open.length;
        } else {
          ta.selectionStart = a + open.length;
          ta.selectionEnd = a + open.length + sel.length;
        }
        notifyEdit();
        scrollCaretIntoView();
        try { ta.focus() } catch (e) { }
        return api;
      },
      /* 当前是否处于降级（纯文本）模式 */
      isLite: function () { return state.lite; },
      destroy: function () {
        if (state.destroyed) return;
        state.destroyed = true;
        if (state.timer) { clearTimeout(state.timer); state.timer = 0; }
        ta.removeEventListener('input', onInput);
        ta.removeEventListener('keydown', onKeyDown);
        ta.removeEventListener('scroll', onScroll);
        ta.removeEventListener('click', onSelection);
        ta.removeEventListener('keyup', onSelection);
        ta.removeEventListener('select', onSelection);
        ta.removeEventListener('compositionstart', onCompositionStart);
        ta.removeEventListener('compositionend', onCompositionEnd);
        if (ro) { ro.disconnect(); ro = null; }
        if (container.__codeEditor === api) container.__codeEditor = null;
        container.innerHTML = '';
      },
      /* 调试 / 自测用 */
      el: el,
      textarea: ta,
      highlight: code
    };

    ta.addEventListener('input', onInput);
    ta.addEventListener('keydown', onKeyDown);
    ta.addEventListener('scroll', onScroll);
    ta.addEventListener('click', onSelection);
    ta.addEventListener('keyup', onSelection);
    ta.addEventListener('select', onSelection);
    ta.addEventListener('compositionstart', onCompositionStart);
    ta.addEventListener('compositionend', onCompositionEnd);

    readMetrics();
    api.setValue(opts.value);
    api.setReadOnly(opts.readOnly);
    container.__codeEditor = api;
    return api;
  }

  /* 对外暴露 */
  root.CodeEditor = CodeEditor;

  /* 内部函数挂到构造器上：便于 node 单测 / 调试（不属于正式 API） */
  CodeEditor._tokenize = tokenize;
  CodeEditor._render = renderHTML;
  CodeEditor._esc = escHtml;
  CodeEditor._MAX_LINES = MAX_LINES;
  CodeEditor.registerLanguage = function (name, profile) {
    var n = String(name || '').toLowerCase();
    if (!n) return false;
    LANGS[n] = profile || {};
    return true;
  };
  CodeEditor.languages = function () { return Object.keys(LANGS); };
  CodeEditor.unregisterLanguage = function (name) { delete LANGS[String(name || '').toLowerCase()]; };

})(typeof window !== 'undefined' ? window : this);
