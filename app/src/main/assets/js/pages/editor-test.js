/* editor-test.js — CodeEditor 自测页（可选，不随 index.html 默认加载）
 *
 * 启用方式：
 *   1) index.html 里先加载 <script src="js/editor.js"></script>（放在 scripts.js 之前）
 *   2) 再加载 <script src="js/pages/editor-test.js"></script>
 *   3) 打开 App 后访问 #go=editortest
 *
 * 页面放 JavaScript / Python / JSON 三份示例，方便真机或截图核对：
 * 着色、行号对齐、光标行高亮、滚动同步、只读模式、2000 行降级。
 */
(function () {
  if (typeof App === 'undefined' || !App.pages) return;

  var JS_SAMPLE = [
    '/* 示例：JavaScript 脚本（P-05 的 js 站点） */',
    'const SITE = "https://example.com";',
    'const UA = `RouParser/${1 + 1}`;',
    '',
    '// 拉列表：支持模板串、正则、数字与函数调用',
    'function abs(url, base) {',
    '  if (!url) return "";',
    '  if (/^https?:\\/\\//.test(url)) return url;',
    '  const tpl = `${base}/search?q=${encodeURIComponent(url)}`;',
    '  return tpl.replace(/\\/+/g, "/");',
    '}',
    '',
    'async function parse(html, page) {',
    '  const doc = new DOMParser().parseFromString(html, "text/html");',
    '  const items = Array.from(doc.querySelectorAll(".item"));',
    '  const list = items.map(function (el, i) {',
    '    return { id: i + 1, title: el.textContent.trim() };',
    '  });',
    '  return { home: { page: page || 1, list: list } };',
    '}'
  ].join('\n');

  var PY_SAMPLE = [
    '# 示例：Python 脚本（本期只能编辑 / 保存，不能执行）',
    'import json',
    'from urllib.parse import quote',
    '',
    '@app.route("/search", methods=["GET"])',
    'def search(keyword: str = "默认", page: int = 1) -> dict:',
    '    """三引号文档串',
    '    第二行：这里应该整段按字符串着色"""',
    '    if not keyword:',
    '        return {"list": []}',
    '    url = f"https://example.com/search?q={quote(keyword)}&page={page}"',
    '    n = 0x1F + 1_000 + 3.14',
    '    return {"url": url, "count": n}'
  ].join('\n');

  var JSON_SAMPLE = [
    '{',
    '  "id": "demo_rule",',
    '  "name": "示例规则站点",',
    '  "type": "rule",',
    '  "enabled": true,',
    '  "page": { "start": 1, "step": 1 },',
    '  "list": {',
    '    "container": ".post-list",',
    '    "item": "li",',
    '    "title": "h3",',
    '    "url": "a"',
    '  },',
    '  "detail": { "title": "h1", "playRe": "m3u8\\\\?url=([^&]+)" },',
    '  "encoding": "utf-8"',
    '}'
  ].join('\n');

  App.pages['editortest'] = function (root) {
    root.innerHTML = '';
    if (typeof window.CodeEditor !== 'function') {
      root.innerHTML = '<div class="empty"><div class="e-tt">editor.js 未加载</div>' +
        '<div class="e-ds">请先在 index.html 引入 js/editor.js</div></div>';
      return Promise.resolve();
    }

    var page = document.createElement('div');
    page.className = 'd1-edpage';
    root.appendChild(page);
    page.appendChild(UI.topbar({ title: '代码编辑器自测', sub: 'CodeEditor · 高亮 / 行号 / 滚动' }));

    var body = document.createElement('div');
    body.className = 'd1-form';
    page.appendChild(body);

    var bar = document.createElement('div');
    bar.className = 'd1-acts';
    var stat = document.createElement('div');
    stat.className = 'd1-note';
    stat.style.flex = '1';
    stat.style.padding = '0';

    var editors = {};

    function section(title, lang, text, ro) {
      var h = document.createElement('div');
      h.className = 'd1-note';
      h.textContent = title;
      body.appendChild(h);
      var host = document.createElement('div');
      host.style.cssText = 'height:230px;display:flex;flex-direction:column;overflow:hidden;' +
        'margin:0 var(--s4) var(--s3);border:1px solid var(--line);border-radius:var(--r-m)';
      body.appendChild(host);
      editors[lang] = window.CodeEditor(host, {
        value: text,
        lang: lang,
        readOnly: !!ro,
        onChange: function () { refreshStat(); }
      });
    }

    function refreshStat() {
      var ed = editors.js;
      if (!ed) return;
      var txt = ed.getValue();
      stat.textContent = 'JS 行数 ' + (txt.split('\n').length) +
        ' · 字符 ' + txt.length +
        ' · 高亮模式 ' + (ed.isLite() ? '已降级' : '正常') +
        ' · 只读 ' + (ed.textarea.readOnly ? '是' : '否');
    }

    section('JavaScript · 可编辑（Tab / Enter / Ctrl+/ 试试）', 'js', JS_SAMPLE, false);
    section('Python · 可编辑（行尾冒号 Enter 自动缩进）', 'py', PY_SAMPLE, false);
    section('JSON · 只读（rule 站点源码预览）', 'json', JSON_SAMPLE, true);

    var acts = document.createElement('div');
    acts.className = 'd1-acts';
    acts.style.flexWrap = 'wrap';

    var bRo = document.createElement('button');
    bRo.className = 'btn ghost';
    bRo.textContent = '切换 JS 只读';
    bRo.onclick = function () {
      var ed = editors.js;
      ed.setReadOnly(!ed.textarea.readOnly);
      refreshStat();
      UI.toast(ed.textarea.readOnly ? '已只读' : '可编辑');
    };

    var bBig = document.createElement('button');
    bBig.className = 'btn ghost';
    bBig.textContent = '灌入 2100 行（降级）';
    bBig.onclick = function () {
      var lines = [];
      for (var i = 0; i < 2100; i++) lines.push('  const row' + i + ' = { id: ' + i + ', name: "测试' + i + '" };');
      editors.js.setValue(lines.join('\n'));
      refreshStat();
      UI.toast('超过 2000 行：已关闭高亮，只保留行号');
    };

    var bReset = document.createElement('button');
    bReset.className = 'btn ghost';
    bReset.textContent = '恢复 JS 示例';
    bReset.onclick = function () {
      editors.js.setValue(JS_SAMPLE);
      refreshStat();
    };

    acts.appendChild(bRo);
    acts.appendChild(bBig);
    acts.appendChild(bReset);
    bar.appendChild(stat);
    body.appendChild(bar);
    body.appendChild(acts);

    refreshStat();
    return Promise.resolve();
  };
})();
