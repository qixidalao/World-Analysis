/* scripts.js — P-04 脚本列表 / P-05 脚本编辑 / P-06 脚本详情 / P-19 新建脚本向导
   数据：DB.sites()（localStorage，key 见 docs/06 §6.2）；执行：Engine（本期只接 JS 执行器）
   样式：css/extra-d1.css（agent-d1 负责；若 index.html 尚未补 <link>，ensureStyles 会兜底加载一次）
   约定：ES2019（不用 ?. / ?? / at()），注释中文，颜色间距字号一律取 var(--*)。
   诚实边界：
     - rule 类型保存 JSON 规则源码，由 engine.js 的 ruleParse（DOMParser + CSS 选择器）执行；
       P-05/P-19 的「测试」只做浏览器 CSS 选择器前端预览，界面上如实标注。
     - py 类型使用内置 CPython 3.14（with-python 包），支持语法检查、测试抓取与执行。 */

(function () {
  'use strict';

  /* ================= 共用小工具 ================= */

  const TYPE_NAME = { rule: 'RULE', js: 'JS', py: 'PY' };
  const TYPE_FULL = { rule: '硬解规则', js: 'JavaScript', py: 'Python' };
  const TYPE_ICON = { rule: '📋', js: '📜', py: '🐍' };
  const EMOJIS = ['🔥', '📚', '🖼', '🎬', '📺', '🐍', '🎧', '📖', '🌐', '🎵', '⭐', '🧩'];

  /* UA 预设：空值 = 不覆盖全局（Net.headersFor 会回退到设置里的 UA） */
  const UAS = [
    { label: '默认（跟随全局）', val: '' },
    { label: 'Android Chrome', val: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
    { label: 'iPhone Safari', val: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
    { label: '桌面 Chrome', val: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
  ];

  function typeOf(s) {
    if (!s) return 'js';
    if (s.type === 'rule') return 'rule';
    if (s.type === 'py') return 'py';
    return 'js';
  }
  function sourceOf(s) {
    if (!s) return '';
    if (s.script) return s.script;
    return (Engine.builtin && Engine.builtin[s.id]) || '';
  }
  function curStack() {
    const st = App.stacks[App.tab];
    return st && st.length ? st[st.length - 1] : null;
  }
  function shorten(s, n) {
    const v = String(s == null ? '' : s);
    return v.length > n ? v.slice(0, n) + '…' : v;
  }
  function siteDomain(u) {
    return String(u || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || '未填地址';
  }
  function absUrl(u, base) {
    const s = String(u == null ? '' : u).trim();
    if (!s) return '';
    try { return new URL(s, base).href } catch (e) { return s }
  }
  function normSite(v) {
    let s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    try {
      const u = new URL(s);
      if (!u.hostname) return '';
      return u.href.replace(/\/+$/, '');
    } catch (e) { return '' }
  }
  function uaOfPreset(label, custom) {
    if (label === '自定义') return String(custom == null ? '' : custom).trim();
    for (let i = 0; i < UAS.length; i++) if (UAS[i].label === label) return UAS[i].val;
    return '';
  }
  function presetOfUA(ua) {
    const v = String(ua == null ? '' : ua);
    if (!v) return '默认（跟随全局）';
    for (let i = 0; i < UAS.length; i++) if (UAS[i].val && UAS[i].val === v) return UAS[i].label;
    return '自定义';
  }

  /* 样式兜底：lead 在 index.html 里加了 <link> 就直接用；没加就补一次（避免整页无样式） */
  function ensureStyles() {
    try {
      const probe = document.createElement('div');
      probe.className = 'd1-probe';
      probe.style.cssText = 'position:absolute;left:-9999px;top:0';
      document.body.appendChild(probe);
      const loaded = getComputedStyle(probe).getPropertyValue('--d1-css') !== '';
      document.body.removeChild(probe);
      if (loaded) return;
      if (document.getElementById('d1-css')) return;
      const l = document.createElement('link');
      l.id = 'd1-css';
      l.rel = 'stylesheet';
      l.href = 'css/extra-d1.css';
      document.head.appendChild(l);
    } catch (e) { }
  }

  /* 复制：WebView 里 clipboard 可能被拒，退化到 execCommand，再失败就让用户手动复制（不假装成功） */
  function manualCopySheet(txt) {
    UI.toast('请手动复制');
    UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">手动复制</div>' +
      '<div class="d1-note">当前 WebView 不允许自动写剪贴板，请长按下面的文本手动复制。</div>' +
      '<textarea class="input d1-copybox" readonly spellcheck="false">' + esc(txt) + '</textarea></div>');
  }
  function copyText(txt, okMsg) {
    const s = String(txt == null ? '' : txt);
    if (!s) { UI.toast('没有可复制内容'); return Promise.resolve(false) }
    const done = function () { UI.toast(okMsg || '已复制'); return true };
    const legacy = function () {
      try {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        return navigator.clipboard.writeText(s).then(done, function () {
          return legacy() ? done() : (manualCopySheet(s), false);
        });
      } catch (e) { /* 落到 execCommand */ }
    }
    return Promise.resolve(legacy() ? done() : (manualCopySheet(s), false));
  }

  /* 长按：520ms 触发；触发后吞掉随后那一次 click，避免同时打开编辑器 */
  function bindLongPress(el, fn) {
    let timer = null;
    let fired = false;
    const clear = function () { if (timer) { clearTimeout(timer); timer = null } };
    const start = function () {
      fired = false;
      clear();
      timer = setTimeout(function () {
        timer = null;
        fired = true;
        setTimeout(function () { fired = false }, 650);
        fn();
      }, 520);
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', clear, { passive: true });
    el.addEventListener('touchend', clear, { passive: true });
    el.addEventListener('touchcancel', clear, { passive: true });
    el.addEventListener('mousedown', start);
    el.addEventListener('mouseup', clear);
    el.addEventListener('mouseleave', clear);
    el.addEventListener('click', function (e) {
      if (!fired) return;
      fired = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  /* ================= 规则 JSON ================= */
  function emptyRule() {
    let tpl = {};
    try { tpl = JSON.parse(Engine.template('rule')) || {} } catch (e) { tpl = {} }
    const l = tpl.list || {}, d = tpl.detail || {}, s = tpl.search || {}, p = tpl.page || {};
    return {
      list: { container: l.container || '', item: l.item || '', title: l.title || '', pic: l.pic || '', url: l.url || '', desc: l.desc || '' },
      detail: { title: d.title || '', pic: d.pic || '', playRe: d.playRe || '', playFrom: d.playFrom || 'html' },
      search: { template: s.template || '' },
      page: { param: p.param || 'page', start: p.start || 1 }
    };
  }
  /* 返回规则对象；解析失败返回 {error} */
  function ruleFromScript(src) {
    let o;
    try { o = JSON.parse(String(src || '')) } catch (e) { return { error: e.message } }
    if (!o || typeof o !== 'object' || Object.prototype.toString.call(o) === '[object Array]') return { error: '规则不是 JSON 对象' };
    const base = emptyRule();
    const out = Object.assign({}, o);
    out.list = Object.assign(base.list, o.list || {});
    out.detail = Object.assign(base.detail, o.detail || {});
    out.search = Object.assign(base.search, o.search || {});
    out.page = Object.assign(base.page, o.page || {});
    return out;
  }
  function getPath(o, p) {
    const ks = String(p).split('.');
    let v = o;
    for (let i = 0; i < ks.length; i++) {
      if (v == null) return '';
      v = v[ks[i]];
    }
    return v == null ? '' : v;
  }
  function setPath(o, p, val) {
    const ks = String(p).split('.');
    let t = o;
    for (let i = 0; i < ks.length - 1; i++) {
      if (!t[ks[i]] || typeof t[ks[i]] !== 'object') t[ks[i]] = {};
      t = t[ks[i]];
    }
    t[ks[ks.length - 1]] = val;
  }
  /* 等价表达式（给熟手看，docs/02 §1.5.1） */
  function exprOf(r) {
    const l = (r && r.list) || {};
    const parts = [];
    if (l.container) parts.push(l.container + '&&' + (l.item || ''));
    else if (l.item) parts.push(l.item);
    if (l.title) parts.push(l.title + '&&Text');
    if (l.pic) parts.push(l.pic + '&&src');
    if (l.url) parts.push(l.url + '&&href');
    if (l.desc) parts.push(l.desc + '&&Text');
    return parts.join(';');
  }

  /* 选择器预览解析（前端预览；不是 RuleEngine） */
  function pickIn(el, sel, attr) {
    if (!sel) return '';
    let n = null;
    try {
      if (el.matches && el.matches(sel)) n = el;
      else n = el.querySelector(sel);
    } catch (e) { return '' }
    if (!n) return '';
    if (attr) return n.getAttribute(attr) || '';
    return String(n.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function previewRule(r, html, base) {
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html') } catch (e) { return { error: 'HTML 解析失败：' + e.message } }
    const list = (r && r.list) || {};
    let scope = doc;
    if (list.container) {
      try { scope = doc.querySelector(list.container) } catch (e) { return { error: '列表容器选择器不合法：' + e.message } }
      if (!scope) return { error: '列表容器「' + list.container + '」没有匹配到元素' };
    }
    let items = [];
    try {
      items = list.item ? Array.prototype.slice.call(scope.querySelectorAll(list.item)) : [scope];
    } catch (e) { return { error: '「每一项」选择器不合法：' + e.message } }
    if (!items.length) return { error: '「每一项」选择器「' + (list.item || '(空)') + '」没有匹配到条目' };
    const cards = [];
    for (let i = 0; i < items.length && cards.length < 100; i++) {
      const it = items[i];
      const title = pickIn(it, list.title, '');
      const pic = absUrl(pickIn(it, list.pic, 'src'), base);
      const url = absUrl(pickIn(it, list.url, 'href'), base);
      const desc = pickIn(it, list.desc, '');
      if (!title && !url) continue;
      cards.push({ title: title, pic: pic, url: url, desc: desc });
    }
    if (!cards.length) return { error: '匹配到 ' + items.length + ' 个条目，但标题/链接都为空，请检查子选择器' };
    return { cards: cards };
  }

  /* ================= P-04 脚本列表 =================
     7 态：ready / empty / error 可用；数据来自同步 localStorage，无 loading/offline/invalid。 */
  App.pages['scripts'] = function (root) {
    ensureStyles();
    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '脚本管理' }));
    const body = document.createElement('div');
    root.appendChild(body);

    function addFoot(box) {
      const f = document.createElement('div');
      f.className = 'd1-foot';
      f.innerHTML = '脚本 = 一个站点。启用后出现在主页站点卡。<br>长按脚本可导出源码或删除。';
      box.appendChild(f);
    }

    function itemHTML(s) {
      const t = typeOf(s);
      const src = sourceOf(s);
      const lines = src ? src.split('\n').length : 0;
      const on = s.enabled !== false;
      return '<div class="d1-si" data-id="' + esc(s.id) + '">' +
        '<div class="d1-si-ico">' + esc(s.icon || TYPE_ICON[t]) + '</div>' +
        '<div class="d1-si-t">' +
        '<div class="d1-si-n">' + esc(s.name || s.id) + '</div>' +
        '<div class="d1-si-m">' + esc(siteDomain(s.site)) + ' · ' + lines + ' 行 · ' + TYPE_NAME[t] + (on ? '' : ' · 已停用') + '</div>' +
        '</div>' +
        '<div class="switch' + (on ? ' on' : '') + '" title="' + (on ? '点击停用' : '点击启用') + '"><i></i></div>' +
        '<div class="d1-si-arw" data-arw>›</div>' +
        '</div>';
    }

    function confirmDelete(id, name, after) {
      UI.dialog({
        title: '删除脚本',
        msg: '「' + name + '」和它的站点缓存会被删除，不可恢复。',
        danger: true,
        okText: '删除',
        onOk: function () {
          App.siteRemove(id);
          if (App.siteId === id) {
            const first = DB.sites()[0];
            App.siteId = first ? first.id : null;
            if (first) DB._set('lastSite', first.id);
          }
          UI.toast('已删除');
          if (after) after();
        }
      });
    }

    function openMenu(s) {
      const id = s.id;
      UI.sheet(
        '<div class="d1-sheet-h">' + esc(s.name || id) + '</div>' +
        '<div class="rows">' +
        '<div class="row tap" data-m="edit"><div class="t"><div class="nm">编辑脚本</div><div class="ds">打开完整编辑器</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-m="toggle"><div class="t"><div class="nm">' + (s.enabled === false ? '启用站点' : '停用站点') + '</div><div class="ds">停用后不出现在主页；配置保留</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-m="export"><div class="t"><div class="nm">导出脚本源码</div><div class="ds">复制到剪贴板</div></div><div class="arw">⤓</div></div>' +
        '<div class="row tap" data-m="detail"><div class="t"><div class="nm">脚本详情</div><div class="ds">请求头 / UA / 网络 / 缓存</div></div><div class="arw">›</div></div>' +
        '<div class="row tap danger" data-m="del"><div class="t"><div class="nm">删除脚本</div><div class="ds">连带清缓存，不可恢复</div></div><div class="arw">›</div></div>' +
        '</div>',
        {
          onOpen: function (pb) {
            $$('[data-m]', pb).forEach(function (el) {
              el.onclick = function () {
                const m = el.dataset.m;
                UI.closeSheet();
                if (m === 'edit') { App.go('scriptEdit', { id: id }); return }
                if (m === 'toggle') {
                  const on = s.enabled !== false;
                  App.siteSetEnabled(id, !on);
                  UI.toast(!on ? '已启用' : '已停用');
                  render();
                  return;
                }
                if (m === 'export') { copyText(sourceOf(s), '已复制'); return }
                if (m === 'detail') { App.go('scriptDetail', { id: id }); return }
                confirmDelete(id, s.name || id, render);
              };
            });
          }
        });
    }

    function render() {
      let list;
      try { list = DB.sites() || [] } catch (e) {
        UI.state(body, 'error', { msg: '读取脚本失败：' + e.message, retry: render });
        return;
      }
      body.innerHTML = '';

      const acts = document.createElement('div');
      acts.className = 'd1-acts';
      acts.innerHTML = '<button class="btn ghost" data-a="import">⤓ 导入</button>' +
        '<button class="btn pri" data-a="new">＋ 新建</button>';
      body.appendChild(acts);
      $('[data-a="import"]', acts).onclick = function () { App.go('newscript', { import: true }) };
      $('[data-a="new"]', acts).onclick = function () { App.go('newscript') };

      if (!list.length) {
        const em = document.createElement('div');
        em.innerHTML = '<div class="empty"><div class="e-ico">📜</div><div class="e-tt">还没有脚本</div>' +
          '<div class="e-ds">脚本 = 一个站点。新建一个，启用后出现在主页站点卡。</div>' +
          '<button class="btn pri" data-new>＋ 新建</button></div>';
        body.appendChild(em);
        $('[data-new]', em).onclick = function () { App.go('newscript') };
        addFoot(body);
        return;
      }

      const wrap = document.createElement('div');
      wrap.className = 'd1-list';
      let h = '';
      for (let i = 0; i < list.length; i++) h += itemHTML(list[i]);
      wrap.innerHTML = h;
      body.appendChild(wrap);

      $$('.d1-si', wrap).forEach(function (el) {
        const id = el.dataset.id;
        const s = DB.site(id);
        if (!s) return;
        bindLongPress(el, function () { openMenu(s) });
        el.onclick = function () { App.go('scriptEdit', { id: id }) };
        const sw = $('.switch', el);
        sw.onclick = function (e) {
          e.stopPropagation();
          App.siteToggle(id);
          const on = (DB.site(id) || {}).enabled !== false;
          sw.classList.toggle('on', on);
          UI.toast(on ? '已启用' : '已停用');
        };
        const arw = $('[data-arw]', el);
        arw.onclick = function (e) {
          e.stopPropagation();
          App.go('scriptDetail', { id: id });
        };
      });
      addFoot(body);
    }

    render();
    return Promise.resolve();
  };

  /* ================= P-05 脚本编辑（代码 / rule 表单） ================= */
  const RULE_FORM = [
    {
      g: '列表规则（CSS 选择器，&& 取子元素）',
      f: [
        ['list.container', '列表容器', '.post-list'],
        ['list.item', '每一项', 'li'],
        ['list.title', '标题', 'h3'],
        ['list.pic', '封面', 'img'],
        ['list.url', '链接', 'a'],
        ['list.desc', '时长/描述（可选）', '.meta']
      ]
    },
    {
      g: '详情与搜索',
      f: [
        ['detail.title', '详情标题', 'h1'],
        ['detail.playRe', '播放地址正则', 'm3u8\\?url=([^&]+)'],
        ['search.template', '搜索模板', 'https://example.com/search?q=**'],
        ['page.param', '分页参数', 'page'],
        ['page.start', '起始页', '1']
      ]
    }
  ];

  App.pages['scriptEdit'] = function (root, params) {
    ensureStyles();
    const id = params ? params.id : '';
    const draftSite = params && params.draftSite ? params.draftSite : null;
    const site = draftSite || DB.site(id);
    root.innerHTML = '';
    if (!site) {
      root.appendChild(UI.topbar({ title: '脚本编辑' }));
      const box = document.createElement('div');
      root.appendChild(box);
      UI.state(box, 'invalid', { msg: '脚本不存在或已删除' });
      return Promise.resolve();
    }

    const type = typeOf(site);
    let files = {}, entry = '', activeFile = '';
    let src = '';
    let rule = null;
    let mode = 'code';
    let initRuleError = '';
    if (type !== 'rule') {
      const ext = type === 'py' ? 'py' : 'js';
      if (site.files && Object.keys(site.files).length) {
        files = Object.assign({}, site.files);
        entry = (site.entry && files[site.entry]) ? site.entry : Object.keys(files)[0];
      } else {
        const nm = 'index.' + ext;
        files[nm] = sourceOf(site) || Engine.template(type);
        entry = nm;
      }
      activeFile = entry;
      src = files[activeFile];
    } else {
      src = sourceOf(site) || Engine.template('rule');
      const r = ruleFromScript(src);
      if (r.error) { mode = 'code'; initRuleError = '规则源码不是合法 JSON（' + r.error + '），已切到源码模式，修正后可切回表单。' }
      else { rule = r; mode = 'form'; src = JSON.stringify(r, null, 2) }
    }
    const dirtyFiles = {};

    let dirty = !!draftSite;
    let killed = false;
    let saveTimer = null;
    let autoSave = !!DB.cfg().editorAutoSave;
    let allowBack = false;
    let ceEd = null;

    const page = document.createElement('div');
    page.className = 'd1-edpage';
    root.appendChild(page);
    const bar = UI.topbar({ title: site.name || id, sub: TYPE_NAME[type] });
    page.appendChild(bar);
    const actions = document.createElement('div');
    actions.className = 'top-actions';
    actions.innerHTML = '<button class="btn pri top-save" data-save>保存</button>' +
      '<div class="ico" data-more>⋮</div>';
    bar.appendChild(actions);
    const saveBtn = $('[data-save]', actions);
    const subEl = $('.tt small', bar);
    $('[data-more]', actions).onclick = function () { openMore() };
    saveBtn.onclick = function () { save() };

    const strip = document.createElement('div');
    strip.className = 'file-strip';
    if (type !== 'rule') page.appendChild(strip);

    function fileLang(name) {
      if (window.Packs && Packs.langForFile) return Packs.langForFile(name);
      const ext = String(name || '').split('.').pop().toLowerCase();
      return ext === 'py' ? 'py' : (ext === 'json' ? 'json' : 'js');
    }
    function renderStrip() {
      if (type === 'rule') return;
      strip.innerHTML = Object.keys(files).map(function (n) {
        return '<div class="file-tab' + (n === activeFile ? ' on' : '') + '" data-f="' + esc(n) + '">' +
          (dirtyFiles[n] ? '<i class="dot"></i>' : '') +
          (n === entry ? '<span class="star">★</span>' : '') + esc(n) + '</div>';
      }).join('') + '<div class="file-add" data-add title="新建文件">＋</div>';
      $$('[data-f]', strip).forEach(function (el) {
        const n = el.dataset.f;
        el.onclick = function () { switchFile(n) };
        bindLongPress(el, function () { openFileMenu(n) });
      });
      $('[data-add]', strip).onclick = newFile;
    }
    function switchFile(n) {
      if (!files[n] || n === activeFile) return;
      if (ceEd) files[activeFile] = ceEd.getValue();
      activeFile = n; src = files[n]; renderStrip(); renderMode();
    }
    function fileNameOk(n) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,48}$/.test(n)) return false;
      const ext = n.split('.').pop().toLowerCase();
      if (/^(js|py|json|mjs|md|html|css|txt)$/.test(ext)) return true;
      return !!(window.Packs && Packs.languages && Packs.languages().indexOf(ext) >= 0);
    }
    function newFileTemplate(n) {
      const ext = String(n || '').split('.').pop().toLowerCase();
      if (n === 'config.json') {
        return JSON.stringify({
          config: [
            { key: 'cookie', label: 'Cookie', type: 'string', default: '', desc: '登录凭据' }
          ]
        }, null, 2) + '\n';
      }
      if (n === 'config.py') {
        return "# 站点参数：编辑器 ⋮ → 站点参数 会读取这里\nCONFIG = [\n    {'key': 'cookie', 'label': 'Cookie', 'type': 'string', 'default': ''}\n]\n";
      }
      if (n === 'config.js') {
        return "// 站点参数：编辑器 ⋮ → 站点参数 会读取这里\n" +
          "export const CONFIG = [\n" +
          "  { key: 'cookie', label: 'Cookie', type: 'string', default: '', desc: '登录凭据' }\n" +
          "];\n";
      }
      if (ext === 'json') return '{\n}\n';
      if (ext === 'py') return '# 新建文件\n';
      if (ext === 'md') return '# 新建文件\n';
      if (ext === 'html') return '<!doctype html>\n<html>\n<body>\n\n</body>\n</html>\n';
      if (ext === 'css') return '/* 新建文件 */\n';
      return '// 新建文件\n';
    }
    function newFile() {
      UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">新建文件</div>' +
        '<div class="d1-note">文件名带扩展名：.js / .py / .json。入口文件必须有 parse(url, html)。</div>' +
        '<input class="input" data-fn placeholder="例如 util.js">' +
        '<div class="d1-steprow"><button class="btn ghost" data-c>取消</button><button class="btn pri" data-ok>创建</button></div></div>', {
        onOpen: function (pb) {
          const inp = $('[data-fn]', pb); inp.focus();
          $('[data-c]', pb).onclick = function () { UI.closeSheet() };
          $('[data-ok]', pb).onclick = function () {
            const n = String(inp.value || '').trim();
            if (!fileNameOk(n)) { UI.toast('文件名不合法'); return }
            if (files[n]) { UI.toast('文件已存在'); return }
            files[n] = newFileTemplate(n);
            activeFile = n; src = files[n]; dirtyFiles[n] = true;
            UI.closeSheet(); renderStrip(); renderMode(); setDirty(true);
          };
        }
      });
    }
    function openFileMenu(n) {
      const isEntry = n === entry;
      const only = Object.keys(files).length <= 1;
      UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">' + esc(n) + '</div><div class="rows">' +
        '<div class="row tap" data-m="entry"><div class="t"><div class="nm">' + (isEntry ? '已是入口文件' : '设为入口文件') + '</div><div class="ds">运行和测试使用这个文件</div></div><div class="arw">★</div></div>' +
        '<div class="row tap" data-m="rename"><div class="t"><div class="nm">重命名</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-m="dup"><div class="t"><div class="nm">复制文件</div></div><div class="arw">⧉</div></div>' +
        '<div class="row tap danger" data-m="del"><div class="t"><div class="nm">删除文件</div><div class="ds">' + (only ? '至少保留一个文件' : '不可恢复') + '</div></div><div class="arw">›</div></div>' +
        '</div></div>', {
        onOpen: function (pb) {
          $$('[data-m]', pb).forEach(function (el) {
            el.onclick = function () {
              const m = el.dataset.m;
              UI.closeSheet();
              if (m === 'entry') { entry = n; renderStrip(); UI.toast('已设为入口'); return }
              if (m === 'del') {
                if (only) { UI.toast('至少保留一个文件'); return }
                delete files[n]; delete dirtyFiles[n];
                if (entry === n) entry = Object.keys(files)[0];
                if (activeFile === n) activeFile = entry;
                src = files[activeFile] || '';
                renderStrip(); renderMode(); setDirty(true);
                return;
              }
              if (m === 'dup') {
                let k = n.replace(/(\.[^.]+)$/, '_copy$1');
                let i = 2; while (files[k]) k = n.replace(/(\.[^.]+)$/, '_copy' + (i++) + '$1');
                files[k] = files[n]; activeFile = k; src = files[k]; dirtyFiles[k] = true;
                renderStrip(); renderMode(); setDirty(true); return;
              }
              if (m === 'rename') {
                UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">重命名</div>' +
                  '<input class="input" data-fn value="' + esc(n) + '">' +
                  '<div class="d1-steprow"><button class="btn ghost" data-c>取消</button><button class="btn pri" data-ok>确定</button></div></div>', {
                  onOpen: function (p2) {
                    $('[data-c]', p2).onclick = function () { UI.closeSheet() };
                    $('[data-ok]', p2).onclick = function () {
                      const nn = String($('[data-fn]', p2).value || '').trim();
                      if (!fileNameOk(nn)) { UI.toast('文件名不合法'); return }
                      if (files[nn]) { UI.toast('文件已存在'); return }
                      files[nn] = files[n]; delete files[n];
                      if (dirtyFiles[n]) { dirtyFiles[nn] = true; delete dirtyFiles[n]; }
                      if (entry === n) entry = nn;
                      if (activeFile === n) { activeFile = nn; src = files[nn]; }
                      UI.closeSheet(); renderStrip(); renderMode(); setDirty(true);
                    };
                  }
                });
              }
            };
          });
        }
      });
    }

    if (type === 'py' && !(window.Py && Py.available())) {
      const w = document.createElement('div');
      w.className = 'd1-warn';
      w.style.margin = '0 var(--pad) var(--s2)';
      w.textContent = '当前安装包没有内置 Python：只能编辑/保存，安装 with-python 包后可语法检查与运行。';
      page.appendChild(w);
    }

    let seg = null;
    if (type === 'rule') {
      seg = document.createElement('div');
      seg.className = 'd1-subseg';
      seg.innerHTML = '<div class="seg">' +
        '<b data-mode="form" class="' + (mode === 'form' ? 'on' : '') + '">表单</b>' +
        '<b data-mode="code" class="' + (mode === 'code' ? 'on' : '') + '">源码</b></div>';
      page.appendChild(seg);
    }

    const holder = document.createElement('div');
    holder.className = 'd1-holder';
    page.appendChild(holder);

    /* 编辑器快捷条：撤销 / 重做 / 常用符号（手机上省得切键盘） */
    const edTools = document.createElement('div');
    edTools.className = 'd1-edtools';
    edTools.innerHTML = '<b data-e="undo" aria-label="撤销">撤销</b>' +
      '<b data-e="redo" aria-label="重做">重做</b><i></i>' +
      [['{ }', '{}'], ['( )', '()'], ['[ ]', '[]'], ['" "', '""'], ["' '", "''"],
       [':', ':'], [';', ';'], ['=', '='], ['#', '#'], ['$', '$'], ['|', '|'],
       ['&&', '&&'], ['->', '->'], ['_', '_']]
        .map(function (x) {
          return '<b data-e="sym" data-s="' + esc(x[1]) + '">' + esc(x[0]) + '</b>';
        }).join('');
    page.insertBefore(edTools, holder);

    (function bindEdTools() {
      function edPress(el, fn) {
        var sx = 0, moved = false, down = false;
        el.addEventListener('pointerdown', function (e) {
          down = true; moved = false; sx = e.clientX;
          if (e.preventDefault) e.preventDefault();
        });
        el.addEventListener('pointermove', function (e) {
          if (down && Math.abs(e.clientX - sx) > 10) moved = true;
        });
        el.addEventListener('pointercancel', function () { down = false; });
        el.addEventListener('pointerup', function () {
          if (!down) return;
          down = false;
          if (!moved) fn();
        });
      }
      $$('[data-e]', edTools).forEach(function (b) {
        edPress(b, function () {
          if (!ceEd) { UI.toast('编辑器未就绪'); return; }
          var k = b.dataset.e;
          if (k === 'undo') { if (!ceEd.undo()) UI.toast('没有可撤销的编辑'); return; }
          if (k === 'redo') { if (!ceEd.redo()) UI.toast('没有可重做的编辑'); return; }
          var s = b.dataset.s || '';
          if (s === '{}' || s === '()' || s === '[]') { ceEd.wrap(s.charAt(0), s.charAt(1)); return; }
          if (s === '""') { ceEd.wrap('"', '"'); return; }
          if (s === "''") { ceEd.wrap("'", "'"); return; }
          ceEd.insert(s);
        });
      });
    })();
    const resBox = document.createElement('div');
    resBox.className = 'd1-reswrap';
    resBox.style.display = 'none';
    page.appendChild(resBox);
    const errBox = document.createElement('div');
    errBox.className = 'd1-err';
    errBox.style.display = 'none';
    page.appendChild(errBox);

    function setDirty(d) {
      dirty = d;
      const state = draftSite ? (dirty ? '草稿 · 未保存' : '草稿') : (dirty ? '未保存' : '已保存');
      if (subEl) subEl.textContent = TYPE_NAME[type] + ' · ' + state;
      if (saveBtn) {
        saveBtn.textContent = draftSite ? '保存并启用' : '保存';
        saveBtn.disabled = !dirty && !draftSite;
      }
      if (d && autoSave && !draftSite) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () { if (dirty && !killed) save(true); }, 1500);
      }
    }
    setDirty(dirty);

    function confirmUnsaved() {
      const isDraft = !!draftSite;
      let h = '<div class="d1-pad"><div class="d1-sheet-h">' +
        (isDraft ? '保存草稿？' : '保存修改？') + '</div>' +
        '<div class="d1-note">' +
        (isDraft ? '保存后会加入主页并启用；不保存则丢弃这次草稿。' : '当前修改还没保存。') +
        '</div><div class="d1-steprow">' +
        '<button class="btn ghost" data-u="cancel">取消</button>' +
        '<button class="btn ghost" data-u="drop">' + (isDraft ? '不保存' : '放弃修改') + '</button>' +
        '<button class="btn pri" data-u="save">' + (isDraft ? '保存草稿' : '保存') + '</button>' +
        '</div></div>';
      UI.sheet(h, {
        onOpen: function (pb) {
          $('[data-u="cancel"]', pb).onclick = function () { UI.closeSheet() };
          $('[data-u="drop"]', pb).onclick = function () {
            allowBack = true;
            UI.closeSheet();
            App.back();
          };
          $('[data-u="save"]', pb).onclick = function () {
            UI.closeSheet();
            if (isDraft) {
              allowBack = true;
              save();
            } else {
              save();
              setTimeout(function () {
                if (!dirty && !killed) { allowBack = true; App.back(); }
              }, 120);
            }
          };
        }
      });
    }

    window.__editGuard = function () {
      if (!dirty || allowBack) return false;
      confirmUnsaved();
      return true;
    };

    function openMore() {
      const rows = '<div class="rows">' +
        '<div class="row tap" data-m="check"><div class="t"><div class="nm">语法检查</div><div class="ds">不运行，只检查语法</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-m="run"><div class="t"><div class="nm">测试运行</div><div class="ds">抓取首页并执行脚本</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-m="blocks"><div class="t"><div class="nm">组件库</div><div class="ds">预设 UI 组件与参数</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-m="cfg"><div class="t"><div class="nm">站点参数</div><div class="ds">脚本 config/CONFIG 自动生成表单</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-m="term"><div class="t"><div class="nm">在终端里跑</div><div class="ds">打开 shell / Python REPL</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-m="auto"><div class="t"><div class="nm">自动保存</div>' +
        '<div class="ds">' + (autoSave ? '已开启：编辑后 1.5 秒自动保存（草稿除外）' : '关闭中') + '</div></div>' +
        '<div class="switch' + (autoSave ? ' on' : '') + '"><i></i></div></div>' +
        '<div class="row tap" data-m="save"><div class="t"><div class="nm">立即保存</div><div class="ds">保存当前脚本</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-m="drop"><div class="t"><div class="nm">放弃修改</div><div class="ds">回到上次保存</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-m="close"><div class="t"><div class="nm">关闭编辑器</div><div class="ds">未保存会先询问</div></div><div class="arw">›</div></div>' +
        '</div>';
      UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">编辑器</div>' + rows + '</div>', {
        onOpen: function (pb) {
          $$('[data-m]', pb).forEach(function (el) {
            el.onclick = function () {
              const m = el.dataset.m;
              UI.closeSheet();
              if (m === 'check') { check(); return }
              if (m === 'run') { run(); return }
              if (m === 'blocks') { openBlocks(); return }
              if (m === 'cfg') { openConfig(); return }
              if (m === 'term') { toTerminal(); return }
              if (m === 'auto') {
                autoSave = !autoSave;
                DB.setCfg({ editorAutoSave: autoSave });
                UI.toast(autoSave ? '已开启自动保存' : '已关闭自动保存');
                openMore();
                return;
              }
              if (m === 'save') { save(); return }
              if (m === 'drop') {
                setDirty(false);
                allowBack = true;
                App.back();
                return;
              }
              if (m === 'close') {
                if (dirty) confirmUnsaved();
                else { allowBack = true; App.back(); }
              }
            };
          });
        }
      });
    }

    function showErr(msg) {
      errBox.textContent = msg ? String(msg) : '';
      errBox.style.display = msg ? 'block' : 'none';
    }
    function setResult(html, open) {
      resBox.style.display = 'block';
      resBox.innerHTML = '<details class="d1-result"' + (open ? ' open' : '') + '><summary>测试结果</summary>' +
        '<div class="d1-result-body">' + html + '</div></details>';
    }
    function hideResult() {
      resBox.style.display = 'none';
      resBox.innerHTML = '';
    }
    function showRunError(msg) {
      setResult('<pre class="d1-pre d1-pre-err">' + esc(msg) + '</pre>', true);
    }
    function showJson(data, meta) {
      let txt;
      try { txt = JSON.stringify(data, null, 1) } catch (e) { txt = String(data) }
      const lines = String(txt).split('\n');
      const bodyTxt = lines.slice(0, 80).join('\n');
      const more = lines.length > 80 ? '\n… 共 ' + lines.length + ' 行，已截断（只显示前 80 行）' : '';
      setResult('<div class="d1-okline">✓ ' + esc(meta) + '</div>' +
        '<pre class="d1-pre">' + esc(bodyTxt + more) + '</pre>', true);
    }

    /* ---------- 编辑器 ---------- */
    function buildEditor() {
      /* 优先用语法高亮编辑器（js/editor.js）；不可用时退回纯 textarea + 行号 */
      if (window.CodeEditor) {
        if (ceEd) { try { ceEd.destroy() } catch (e) { } ceEd = null; }
        holder.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'd1-cewrap';
        holder.appendChild(wrap);
        const lang = type === 'rule' ? 'json' : fileLang(activeFile);
        try {
          ceEd = window.CodeEditor(wrap, {
            value: src,
            lang: lang,
            readOnly: false,
            onChange: function (v) {
              src = v; files[activeFile] = v; dirtyFiles[activeFile] = true; setDirty(true);
            }
          });
          return;
        } catch (e) {
          Log.err('编辑器初始化失败，退回基础模式: ' + e.message);
          holder.innerHTML = '';
        }
      }
      holder.innerHTML = '<div class="d1-edwrap">' +
        '<div class="d1-gutter"></div>' +
        '<textarea class="d1-ed" spellcheck="false" autocapitalize="off" autocorrect="off" wrap="off"></textarea>' +
        '</div>';
      const ta = $('.d1-ed', holder);
      const gut = $('.d1-gutter', holder);
      ta.value = src;
      const nums = function () {
        const n = ta.value.split('\n').length;
        let s = '';
        for (let i = 1; i <= n; i++) s += i + '\n';
        gut.textContent = s;
      };
      nums();
      ta.addEventListener('input', function () {
        src = ta.value; files[activeFile] = ta.value; dirtyFiles[activeFile] = true; nums(); setDirty(true);
      });
      ta.addEventListener('scroll', function () { gut.scrollTop = ta.scrollTop });
      ta.addEventListener('keydown', function (e) {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const a = ta.selectionStart, b = ta.selectionEnd;
        ta.setRangeText('    ', a, b, 'end');
        src = ta.value;
        nums();
        setDirty(true);
      });
    }

    /* ---------- rule 表单 ---------- */
    function buildRuleJSON() {
      const base = rule ? JSON.parse(JSON.stringify(rule)) : emptyRule();
      base.name = site.name || base.name || id;
      base.id = id;
      base.site = site.site || base.site || '';
      base.icon = site.icon || base.icon || '';
      base.group = site.group || base.group || '';
      if (!base.encoding) base.encoding = site.encoding || 'utf-8';
      base.page = base.page || {};
      base.page.start = parseInt(base.page.start, 10) || 1;
      return base;
    }
    function buildForm() {
      let h = '<div class="d1-form">';
      for (let i = 0; i < RULE_FORM.length; i++) {
        const grp = RULE_FORM[i];
        h += '<div class="rows"><div class="grp">' + grp.g + '</div>';
        for (let j = 0; j < grp.f.length; j++) {
          const f = grp.f[j];
          h += '<div class="d1-field"><div class="lb">' + f[1] + '</div>' +
            '<input data-p="' + f[0] + '" value="' + esc(getPath(rule, f[0])) + '" placeholder="' + esc(f[2]) + '" spellcheck="false" autocapitalize="off"></div>';
        }
        h += '</div>';
      }
      h += '<div class="d1-expr" id="expr">等价表达式：' + esc(exprOf(rule) || '（填完选择器后生成）') + '</div>';
      h += '<div class="d1-note">规则以 JSON 保存；rule 站点由 JS 规则执行器解析（DOMParser + CSS 选择器）：' +
        '「测试运行」只用浏览器 CSS 选择器做前端预览，结果仅供参考。</div>';
      h += '</div>';
      holder.innerHTML = h;
      $$('input[data-p]', holder).forEach(function (el) {
        el.addEventListener('input', function () {
          let v = el.value;
          if (el.dataset.p === 'page.start') v = parseInt(v, 10) || 1;
          setPath(rule, el.dataset.p, v);
          const ex = $('#expr', holder);
          if (ex) ex.textContent = '等价表达式：' + (exprOf(rule) || '（填完选择器后生成）');
          setDirty(true);
        });
      });
    }
    function renderMode() {
      if (seg) {
        $$('[data-mode]', seg).forEach(function (b) {
          b.classList.toggle('on', b.dataset.mode === mode);
        });
      }
      hideResult();
      if (mode === 'form') buildForm();
      else buildEditor();
    }
    if (seg) {
      $$('[data-mode]', seg).forEach(function (b) {
        b.onclick = function () {
          if (b.dataset.mode === mode) return;
          if (mode === 'form' && b.dataset.mode === 'code') {
            src = JSON.stringify(buildRuleJSON(), null, 2);
          }
          if (mode === 'code' && b.dataset.mode === 'form') {
            const r = ruleFromScript(src);
            if (r.error) { showErr('规则 JSON 解析失败：' + r.error); return }
            rule = r;
            mode = 'form';
            setDirty(true);
            renderMode();
            return;
          }
          mode = b.dataset.mode;
          setDirty(true);
          renderMode();
        };
      });
    }

    /* ---------- 四个动作 ---------- */
    function openConfig() {
      const s = DB.site(id) || draftSite;
      if (!s) { UI.toast('站点不存在'); return }
      let r;
      if (type === 'rule') r = { ok: true, config: [] };
      else if (type === 'py') r = (window.Py && Py.configFromSource) ? Py.configFromSource(files['config.py'] || src) : Engine.config(id);
      else r = Engine.configFromSource(src, files, entry);
      const schema = (r && r.ok === false) ? [] : ((r && r.config) || []);
      if (!schema.length) {
        const cfgName = type === 'py' ? 'config.py' : 'config.js';
        const has = !!files[cfgName];
        UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">站点参数</div>' +
          '<div class="d1-note">当前脚本没有读到参数声明。可以在 <span class="mono">' + cfgName + '</span> 里写参数' +
          (type === 'py' ? '（CONFIG）' : '（export const CONFIG）') + '，JS 也可以放 config.json；参数文件不需要被入口 import。</div>' +
          '<div class="d1-steprow"><button class="btn ghost" data-cc>取消</button>' +
          '<button class="btn pri" data-cg>' + (has ? '打开 ' + cfgName : '创建 ' + cfgName + ' 示例') + '</button></div></div>', {
          onOpen: function (pb) {
            $('[data-cc]', pb).onclick = function () { UI.closeSheet() };
            $('[data-cg]', pb).onclick = function () {
              if (!files[cfgName]) files[cfgName] = newFileTemplate(cfgName);
              activeFile = cfgName; src = files[activeFile];
              dirtyFiles[activeFile] = true;
              UI.closeSheet(); renderStrip(); renderMode(); setDirty(true);
              UI.toast('编辑 CONFIG 后保存，再点 ⚙');
            };
          }
        });
        return;
      }
      const val = Object.assign({}, s.config || {});
      const field = (f, i) => {
        const k = f.key || f.name;
        const type = f.type || 'string';
        const v = val[k] != null ? val[k] : (f.default != null ? f.default : '');
        let input;
        if (type === 'boolean') {
          input = '<div class="switch' + ((v === true || v === 'true') ? ' on' : '') + '" data-cfg="' + i + '" data-type="bool"><i></i></div>';
        } else if (type === 'select') {
          input = '<select class="input" data-cfg="' + i + '" data-type="select">' +
            (f.options || []).map(o => {
              const ov = typeof o === 'string' ? o : o.value;
              const ol = typeof o === 'string' ? o : (o.label || o.value);
              return '<option value="' + esc(ov) + '"' + (String(ov) === String(v) ? ' selected' : '') + '>' + esc(ol) + '</option>';
            }).join('') + '</select>';
        } else if (type === 'textarea') {
          input = '<textarea class="input" rows="3" data-cfg="' + i + '" data-type="string">' + esc(v) + '</textarea>';
        } else {
          input = '<input class="input" type="' + (type === 'password' ? 'password' : type === 'number' ? 'number' : 'text') +
            '" data-cfg="' + i + '" data-type="' + esc(type) + '" value="' + esc(v) + '">';
        }
        return '<div class="d1-cfg-row"><div class="d1-cfg-l"><b>' + esc(f.label || k) + '</b>' +
          (f.desc ? '<span>' + esc(f.desc) + '</span>' : '') + '</div>' + input + '</div>';
      };
      let h = '<div class="d1-pad"><div class="d1-sheet-h">站点参数 · ' + esc(s.name || id) + '</div>' +
        '<div class="d1-note">脚本里声明 config/CONFIG，App 自动生成表单；运行时 JS 读 CFG.key，Python 读 CFG["key"]。</div>' +
        schema.map(field).join('') +
        '<div class="d1-steprow"><button class="btn ghost" data-cfgc>取消</button>' +
        '<button class="btn pri" data-cfgs>保存参数</button></div></div>';
      UI.sheet(h, {
        onOpen: function (pb) {
          $$('[data-cfg][data-type="bool"]', pb).forEach(el => {
            el.onclick = function () { el.classList.toggle('on') };
          });
          $('[data-cfgc]', pb).onclick = function () { UI.closeSheet() };
          $('[data-cfgs]', pb).onclick = function () {
            const cfg = {};
            schema.forEach(function (f, i) {
              const k = f.key || f.name;
              const el = $('[data-cfg="' + i + '"]', pb);
              if (!el) return;
              if (el.dataset.type === 'bool') cfg[k] = el.classList.contains('on');
              else if (el.dataset.type === 'number') cfg[k] = el.value === '' ? '' : Number(el.value);
              else cfg[k] = el.value;
            });
            if (draftSite) {
              draftSite.config = cfg;
              UI.closeSheet();
              UI.toast('参数已保存到草稿');
              return;
            }
            try { DB.saveSite({ id: id, config: cfg }) } catch (e) { UI.toast('保存失败'); return }
            Engine.invalidate(id);
            UI.closeSheet();
            UI.toast('参数已保存');
          };
        }
      });
    }

    function openBlocks() {
      if (!ceEd) { UI.toast('编辑器未就绪'); return }
      const py = type === 'py';
      const qs = (s) => py ? ("'" + String(s).replace(/'/g, "\\'") + "'") : JSON.stringify(s);
      const lit = (v) => {
        if (Array.isArray(v)) return '[' + v.map(lit).join(', ') + ']';
        if (v && typeof v === 'object') {
          return '{' + Object.keys(v).map(k => qs(k) + ': ' + lit(v[k])).join(', ') + '}';
        }
        if (typeof v === 'string') return qs(v);
        if (typeof v === 'boolean') return py ? (v ? 'True' : 'False') : String(v);
        return String(v);
      };
      const pretty = (v, ind) => {
        ind = ind || 0;
        const pad = '  '.repeat(ind), pad2 = '  '.repeat(ind + 1);
        if (Array.isArray(v)) {
          if (!v.length) return '[]';
          return '[\n' + v.map(x => pad2 + pretty(x, ind + 1)).join(',\n') + '\n' + pad + ']';
        }
        if (v && typeof v === 'object') {
          const ks = Object.keys(v);
          if (!ks.length) return '{}';
          return '{\n' + ks.map(k => pad2 + qs(k) + ': ' + pretty(v[k], ind + 1)).join(',\n') + '\n' + pad + '}';
        }
        return lit(v);
      };
      const defs = [
        {
          name: '🖼 图片框', type: 'image',
          desc: '按宽高比展示图片，可选圆角、固定高度和底部图注。',
          req: [{ k: 'url', label: '图片地址', type: 'string', desc: 'http(s) 图片地址；空字符串会显示占位块' }],
          opt: [
            { k: 'ratio', label: '宽高比', type: 'number', def: '1.5', range: '0.3–4', desc: '宽/高；1 为正方形，1.78 接近 16:9' },
            { k: 'height', label: '固定高度', type: 'number', def: '自动', range: '20–600', desc: '设置后忽略 ratio，单位 px' },
            { k: 'minHeight', label: '最小高度', type: 'number', def: '无', range: '0–600', desc: 'px' },
            { k: 'maxHeight', label: '最大高度', type: 'number', def: '400', range: '20–800', desc: 'px，超出裁剪' },
            { k: 'fit', label: '填充方式', type: 'string', def: 'cover', range: 'cover/contain/fill/none/scale-down', desc: 'cover 铺满裁剪；contain 完整显示' },
            { k: 'position', label: '裁剪位置', type: 'string', def: 'center', range: 'center/top/bottom/left/right', desc: 'object-position' },
            { k: 'radius', label: '圆角', type: 'number', def: '12', range: '0–60', desc: 'px；0 直角' },
            { k: 'radiusTL/TR/BL/BR', label: '四角圆角', type: 'number', def: '跟随 radius', range: '0–60', desc: '分别设置左上/右上/左下/右下' },
            { k: 'border', label: '边框宽度', type: 'number', def: '0', range: '0–10', desc: 'px' },
            { k: 'borderColor', label: '边框颜色', type: 'string', def: '主题线色', range: '#hex/rgb()/var()', desc: '配合 border 使用' },
            { k: 'shadow', label: '阴影', type: 'string', def: 'none', range: 'none/sm/md/lg', desc: '预设三级阴影' },
            { k: 'bg', label: '背景色', type: 'string', def: '透明', range: '#hex/rgb()/var()', desc: '图片加载前的底色' },
            { k: 'caption', label: '图注', type: 'string', def: '无', desc: '图片说明文字' },
            { k: 'captionPos', label: '图注位置', type: 'string', def: 'overlay', range: 'overlay/below', desc: 'overlay 叠在底部；below 在图下方' },
            { k: 'captionColor', label: '图注颜色', type: 'string', def: '#fff/主题', range: '#hex', desc: 'overlay 默认白色，below 默认次要色' },
            { k: 'overlay', label: '底部渐变', type: 'boolean', def: 'false', desc: '为 true 时加黑色渐变，便于白字' },
            { k: 'link', label: '点击跳转', type: 'string', def: '无', desc: '点击图片打开的详情 URL' },
            { k: 'alt', label: '替代文本', type: 'string', def: '空', desc: '图片加载失败/无障碍' },
            { k: 'lazy', label: '懒加载', type: 'boolean', def: 'true', desc: 'false 时立即加载' },
            { k: 'width', label: '宽度', type: 'string', def: '100%', range: 'full/half/third', desc: '半宽/三分之一宽' },
            { k: 'mt/mb', label: '上下外边距', type: 'number', def: '0/10', range: '0–80', desc: 'px' },
            { k: 'padding', label: '内边距', type: 'number', def: '0', range: '0–40', desc: 'px' }
          ],
          min: { type: 'image', url: 'https://example.com/cover.jpg' },
          full: { type: 'image', url: 'https://example.com/cover.jpg', ratio: 1.6, radius: 12, fit: 'cover', position: 'center', border: 1, borderColor: '#333', shadow: 'md', caption: '封面', captionPos: 'below', overlay: true, link: 'https://example.com/detail/1', alt: '封面' },
          notes: ['ratio 与 height 同时存在时，height 优先。', '圆角上限 40px，超过按 40 处理。']
        },
        {
          name: '🔠 标题', type: 'title',
          desc: '详情/分区标题，按字号层级显示。',
          req: [{ k: 'text', label: '标题文字', type: 'string', desc: '必填，纯文本（不支持 HTML）' }],
          opt: [
            { k: 'size', label: '字号', type: 'string', def: 'lg', range: 'xl/lg/md/sm', desc: 'xl 最大，sm 最小' },
            { k: 'color', label: '颜色', type: 'string', def: '主题色', range: '#hex', desc: '例如 #FF5A3C；留空用主题文字色' }
          ],
          min: { type: 'title', text: '标题文字' },
          full: { type: 'title', text: '标题文字', size: 'xl', color: '#FF5A3C' },
          notes: ['text 中的换行会保留。']
        },
        {
          name: '📝 正文', type: 'text',
          desc: '多行正文，可弱化颜色或限制显示行数。',
          req: [{ k: 'text', label: '正文内容', type: 'string', desc: '必填，纯文本；换行用 \\n' }],
          opt: [
            { k: 'muted', label: '弱化', type: 'boolean', def: 'false', range: 'true/false', desc: 'true 使用次要文字颜色' },
            { k: 'lines', label: '最大行数', type: 'number', def: '3', range: '1–12', desc: '超出后省略号截断' }
          ],
          min: { type: 'text', text: '这里是一段简介' },
          full: { type: 'text', text: '这里是一段简介，可以换行。', muted: false, lines: 4 },
          notes: []
        },
        {
          name: '🏷 标签', type: 'chips',
          desc: '一组圆角小标签，适合分类/属性。',
          req: [{ k: 'items', label: '标签数组', type: 'array', desc: '必填；元素是字符串，或 {"text":"..."}' }],
          opt: [],
          min: { type: 'chips', items: ['标签1', '标签2'] },
          full: { type: 'chips', items: ['标签1', '标签2', '标签3'] },
          notes: ['items 最多建议 12 个，超出自动换行。']
        },
        {
          name: '▦ 两列网格', type: 'grid',
          desc: '把子组件按列排列，子项放在 items 数组里。',
          req: [{ k: 'items', label: '子组件', type: 'array', desc: '必填；每个元素也是组件对象（image/title/text/...）' }],
          opt: [
            { k: 'cols', label: '列数', type: 'number', def: '2', range: '1–6', desc: '手机竖屏建议 2–3' },
            { k: 'gap', label: '间距', type: 'number', def: '8', range: '0–40', desc: '子项之间的间距，单位 px' }
          ],
          min: { type: 'grid', cols: 2, items: [{ type: 'image', url: 'https://example.com/a.jpg' }, { type: 'image', url: 'https://example.com/b.jpg' }] },
          full: { type: 'grid', cols: 2, gap: 10, items: [
            { type: 'image', url: 'https://example.com/a.jpg', ratio: 1, radius: 20 },
            { type: 'title', text: '子标题' }
          ] },
          notes: ['items 里可以继续嵌套 row/grid。']
        },
        {
          name: '↔ 横排', type: 'row',
          desc: '子组件横向平均排列，适合封面+文字。',
          req: [{ k: 'items', label: '子组件', type: 'array', desc: '必填；横向排列的组件数组' }],
          opt: [{ k: 'gap', label: '间距', type: 'number', def: '8', range: '0–40', desc: '子项间距 px' }],
          min: { type: 'row', items: [{ type: 'image', url: 'https://example.com/a.jpg' }, { type: 'text', text: '说明' }] },
          full: { type: 'row', gap: 10, items: [{ type: 'image', url: 'https://example.com/a.jpg', ratio: 1 }, { type: 'text', text: '说明文字' }] },
          notes: ['子项平均分宽度；图片建议设 ratio=1。']
        },
        {
          name: '➖ 分隔线', type: 'divider',
          desc: '一条 1px 分隔线。',
          req: [], opt: [],
          min: { type: 'divider' }, full: { type: 'divider' },
          notes: ['上下自带间距，无需再写 spacer。']
        },
        {
          name: '⬍ 空白间距', type: 'spacer',
          desc: '插入一段固定高度的空白。',
          req: [],
          opt: [{ k: 'height', label: '高度', type: 'number', def: '12', range: '0–200', desc: '单位 px' }],
          min: { type: 'spacer' }, full: { type: 'spacer', height: 24 },
          notes: []
        },
        {
          name: '🏅 徽章', type: 'badge',
          desc: '小号胶囊标签，适合评分/年份/状态。',
          req: [{ k: 'text', label: '文字', type: 'string', desc: '必填' }],
          opt: [],
          min: { type: 'badge', text: '评分 9.0' }, full: { type: 'badge', text: '2026' },
          notes: []
        },
        {
          name: '▶ 按钮', type: 'button',
          desc: '主/次按钮；可触发播放，或跳转到详情地址。',
          req: [],
          opt: [
            { k: 'text', label: '按钮文字', type: 'string', def: '打开', desc: '显示在按钮上的文字' },
            { k: 'style', label: '样式', type: 'string', def: 'ghost', range: 'pri/ghost', desc: 'pri 主按钮（橙），ghost 次按钮' },
            { k: 'action', label: '动作', type: 'string', def: '无', range: 'play', desc: 'play 表示立即播放当前详情' },
            { k: 'url', label: '跳转地址', type: 'string', def: '无', desc: '非 play 时点击打开的详情 URL' }
          ],
          min: { type: 'button', text: '▶ 播放', style: 'pri', action: 'play' },
          full: { type: 'button', text: '打开链接', style: 'ghost', url: 'https://example.com/detail/1' },
          notes: ['action=play 时忽略 url。', 'url 是站内详情地址时按详情页打开。']
        },
        {
          name: '👤 头像', type: 'avatar',
          desc: '圆形/圆角头像，可带描边和点击跳转。',
          req: [],
          opt: [
            { k: 'url', label: '头像地址', type: 'string', def: '无', desc: '为空时显示 fallback 文字' },
            { k: 'size', label: '尺寸', type: 'number', def: '48', range: '20–120', desc: '宽高相等，px' },
            { k: 'radius', label: '圆角', type: 'number', def: '999', range: '0–60', desc: '999 为圆形' },
            { k: 'fallback', label: '占位文字', type: 'string', def: '?', desc: '最多显示 2 个字' },
            { k: 'ring', label: '描边', type: 'boolean', def: 'false', desc: '主题色 2px 外圈' },
            { k: 'link', label: '点击跳转', type: 'string', def: '无', desc: '详情 URL' }
          ],
          min: { type: 'avatar', url: 'https://example.com/avatar.jpg' },
          full: { type: 'avatar', url: 'https://example.com/avatar.jpg', size: 56, ring: true, fallback: '用', link: 'https://example.com/u/1' },
          notes: ['url 为空时显示 fallback 文字。']
        },
        {
          name: '🌄 头图', type: 'hero',
          desc: '大图 + 标题/简介的头部横幅，可点击。',
          req: [{ k: 'url', label: '图片地址', type: 'string', desc: '必填' }],
          opt: [
            { k: 'title', label: '标题', type: 'string', def: '无', desc: '图片上的大标题' },
            { k: 'desc', label: '简介', type: 'string', def: '无', desc: '最多两行' },
            { k: 'height', label: '高度', type: 'number', def: '200', range: '100–600', desc: 'px' },
            { k: 'link', label: '点击跳转', type: 'string', def: '无', desc: '详情 URL' }
          ],
          min: { type: 'hero', url: 'https://example.com/hero.jpg' },
          full: { type: 'hero', url: 'https://example.com/hero.jpg', title: '标题', desc: '简介文字', height: 220, link: 'https://example.com/detail/1' },
          notes: ['文字自动带底部渐变。']
        },
        {
          name: '📊 键值信息', type: 'meta',
          desc: '两列/多列“标签: 值”信息块。',
          req: [{ k: 'items', label: '信息数组', type: 'array', desc: '必填；[{label,value}]' }],
          opt: [{ k: 'cols', label: '列数', type: 'number', def: '2', range: '1–4', desc: '每行几个' }],
          min: { type: 'meta', items: [{ label: '作者', value: '未知' }, { label: '年份', value: '2026' }] },
          full: { type: 'meta', cols: 2, items: [{ label: '评分', value: '9.0' }, { label: '时长', value: '120 分钟' }, { label: '地区', value: '日本' }] },
          notes: []
        },
        {
          name: '📈 数据统计', type: 'stats',
          desc: '大数字 + 单位的统计卡片组。',
          req: [{ k: 'items', label: '统计数组', type: 'array', desc: '必填；[{label,value,unit}]' }],
          opt: [{ k: 'cols', label: '列数', type: 'number', def: '3', range: '1–4', desc: '每行几个' }],
          min: { type: 'stats', items: [{ label: '播放', value: 1234 }, { label: '收藏', value: 56 }] },
          full: { type: 'stats', cols: 3, items: [{ label: '播放', value: '12.3', unit: '万' }, { label: '评分', value: '9.0' }, { label: '集数', value: 14 }] },
          notes: []
        },
        {
          name: '▰ 进度条', type: 'progress',
          desc: '带标签和百分比的进度条。',
          req: [{ k: 'value', label: '当前值', type: 'number', desc: '必填' }],
          opt: [
            { k: 'max', label: '最大值', type: 'number', def: '100', desc: 'value/max 计算百分比' },
            { k: 'label', label: '标签', type: 'string', def: '无', desc: '左侧文字' },
            { k: 'color', label: '颜色', type: 'string', def: '主题橙', desc: '#hex/rgb()' },
            { k: 'height', label: '粗细', type: 'number', def: '6', range: '2–20', desc: 'px' },
            { k: 'showValue', label: '显示百分比', type: 'boolean', def: 'true', desc: '右侧数值' }
          ],
          min: { type: 'progress', value: 60 },
          full: { type: 'progress', value: 7, max: 14, label: '已看 7 集', color: '#FF5A3C', height: 8 },
          notes: []
        },
        {
          name: '⭐ 评分', type: 'rating',
          desc: '五星评分（支持自定义星数）。',
          req: [{ k: 'value', label: '评分', type: 'number', desc: '必填，0–max' }],
          opt: [
            { k: 'max', label: '星数', type: 'number', def: '5', range: '1–10', desc: '总星数' },
            { k: 'color', label: '颜色', type: 'string', def: '#f5a524', desc: '星星颜色' },
            { k: 'showValue', label: '显示数值', type: 'boolean', def: 'true', desc: '右侧数字' }
          ],
          min: { type: 'rating', value: 4.5 },
          full: { type: 'rating', value: 4.5, max: 5, color: '#f5a524' },
          notes: ['星星按四舍五入点亮。']
        },
        {
          name: '💡 提示条', type: 'notice',
          desc: 'info/warn/err/ok 四种状态的提示条。',
          req: [{ k: 'text', label: '文字', type: 'string', desc: '必填' }],
          opt: [
            { k: 'kind', label: '类型', type: 'string', def: 'info', range: 'info/warn/err/ok', desc: '颜色与语义' },
            { k: 'icon', label: '图标', type: 'string', def: '无', desc: 'emoji' }
          ],
          min: { type: 'notice', text: '这是一条提示' },
          full: { type: 'notice', text: '资源来自网络，仅供学习', kind: 'warn', icon: '⚠️' },
          notes: []
        },
        {
          name: '🔗 链接行', type: 'link',
          desc: '一行可点击链接，右侧箭头。',
          req: [{ k: 'url', label: '链接地址', type: 'string', desc: '必填' }],
          opt: [{ k: 'text', label: '显示文字', type: 'string', def: 'URL', desc: '为空时显示 URL' }, { k: 'icon', label: '图标', type: 'string', def: '↗', desc: 'emoji' }],
          min: { type: 'link', url: 'https://example.com' },
          full: { type: 'link', text: '打开原站', url: 'https://example.com', icon: '🌐' },
          notes: []
        },
        {
          name: '📃 列表', type: 'list',
          desc: '带封面/标题/描述的列表项。',
          req: [{ k: 'items', label: '列表项', type: 'array', desc: '必填；[{title,desc,pic,url}]' }],
          opt: [],
          min: { type: 'list', items: [{ title: '项目一', desc: '描述', url: 'https://example.com/1' }] },
          full: { type: 'list', items: [
            { title: '项目一', desc: '描述一', pic: 'https://example.com/1.jpg', url: 'https://example.com/1' },
            { title: '项目二', desc: '描述二', url: 'https://example.com/2' }
          ] },
          notes: ['有 url 的项可点击。']
        },
        {
          name: '🖼 图集', type: 'gallery',
          desc: '九宫格图片，可设置列数/间距/圆角。',
          req: [{ k: 'items', label: '图片数组', type: 'array', desc: '必填；字符串 URL 或 {url,link}' }],
          opt: [
            { k: 'cols', label: '列数', type: 'number', def: '3', range: '1–6', desc: '每行几张' },
            { k: 'gap', label: '间距', type: 'number', def: '6', range: '0–30', desc: 'px' },
            { k: 'radius', label: '圆角', type: 'number', def: '8', range: '0–40', desc: 'px' },
            { k: 'ratio', label: '单图比例', type: 'number', def: '1', range: '0.3–4', desc: '宽/高' }
          ],
          min: { type: 'gallery', items: ['https://example.com/1.jpg', 'https://example.com/2.jpg'] },
          full: { type: 'gallery', cols: 3, gap: 8, radius: 10, ratio: 1, items: ['https://example.com/1.jpg', 'https://example.com/2.jpg', 'https://example.com/3.jpg'] },
          notes: []
        },
        {
          name: '❝ 引用', type: 'quote',
          desc: '带左边线的引用块，可附作者。',
          req: [{ k: 'text', label: '引用文字', type: 'string', desc: '必填' }],
          opt: [{ k: 'author', label: '作者/来源', type: 'string', def: '无', desc: '显示在右下' }],
          min: { type: 'quote', text: '一句话引用' },
          full: { type: 'quote', text: '一句话引用', author: '来源' },
          notes: []
        },
        {
          name: '📚 分区', type: 'section',
          desc: '标题 + 子组件的分组容器。',
          req: [{ k: 'title', label: '分区标题', type: 'string', desc: '必填' }, { k: 'items', label: '子组件', type: 'array', desc: '必填' }],
          opt: [{ k: 'more', label: '右侧文字', type: 'string', def: '无', desc: '如“更多”' }],
          min: { type: 'section', title: '分区', items: [{ type: 'text', text: '内容' }] },
          full: { type: 'section', title: '推荐', more: '更多', items: [{ type: 'title', text: '子标题' }, { type: 'text', text: '内容' }] },
          notes: []
        }
      ];

      function showHelp(def) {
        const prow = (x, opt) => {
          const meta = [x.type];
          if (opt) meta.push('默认 ' + x.def);
          if (x.range) meta.push(x.range);
          return '<div class="row"><div class="t">' +
            '<div class="nm"><span class="mono">' + esc(x.k) + '</span> <span class="tag">' + esc(x.label) + '</span></div>' +
            '<div class="ds">' + esc(meta.join(' · ')) + '</div>' +
            '<div class="ds">' + esc(x.desc) + '</div></div></div>';
        };
        const min = pretty(def.min), full = pretty(def.full);
        let h = '<div class="d1-pad"><div class="d1-sheet-h">' + esc(def.name) + ' · ' + esc(def.type) + '</div>' +
          '<div class="d1-note">' + esc(def.desc) + '</div>' +
          '<div class="d1-note"><b>放在哪</b>：<span class="mono">detail.blocks</span> 数组中的一项；多个组件按数组顺序渲染。</div>' +
          '<div class="d1-note"><b>所有组件通用</b>：<span class="mono">mt mb padding bg border borderColor radius shadow width align</span>（宽度 full/half/third，对齐 left/center/right）。</div>' +
          '<div class="st-grp">必填参数</div>' +
          (def.req.length ? def.req.map(x => prow(x, false)).join('') : '<div class="ms-empty">无（全部可选）</div>') +
          '<div class="st-grp">可选参数 / 默认值</div>' +
          (def.opt.length ? def.opt.map(x => prow(x, true)).join('') : '<div class="ms-empty">无</div>') +
          (def.notes && def.notes.length ? '<div class="st-grp">说明</div>' +
            def.notes.map(n => '<div class="d1-note">· ' + esc(n) + '</div>').join('') : '') +
          '<div class="st-grp">最小示例（' + (py ? 'Python dict' : 'JS 对象') + '）</div>' +
          '<pre class="d1-codebox d1-codebox-pre">' + esc(min) + '</pre>' +
          '<div class="st-grp">完整示例</div>' +
          '<pre class="d1-codebox d1-codebox-pre">' + esc(full) + '</pre>' +
          '<div class="d1-steprow"><button class="btn ghost" data-hc>关闭</button>' +
          '<button class="btn pri" data-hi>插入完整示例</button></div></div>';
        UI.sheet(h, {
          onOpen: function (pb) {
            $('[data-hc]', pb).onclick = function () { UI.closeSheet() };
            $('[data-hi]', pb).onclick = function () {
              try { ceEd.insert('\n' + full + ','); } catch (e) { UI.toast('插入失败'); return }
              UI.closeSheet(); setDirty(true);
            };
          }
        });
      }

      let h = '<div class="d1-pad"><div class="d1-sheet-h">组件库（插入到 detail.blocks）</div>' +
        '<div class="d1-note">轻点插入完整示例；<b>长按</b>查看参数：必填、可选默认值、中文说明和最小/完整示例。JS 对象与 Python dict 字段一致。</div>' +
        '<div class="rows">';
      for (let i = 0; i < defs.length; i++) {
        h += '<div class="row tap" data-blk="' + i + '"><div class="t"><div class="nm">' + defs[i].name +
          '</div><div class="ds">' + esc(defs[i].desc) + '</div></div><div class="arw">＋</div></div>';
      }
      h += '</div></div>';
      UI.sheet(h, {
        onOpen: function (pb) {
          $$('[data-blk]', pb).forEach(function (el) {
            const def = defs[+el.dataset.blk];
            let timer = null, moved = false, down = false;
            const cancel = function () { if (timer) clearTimeout(timer); timer = null };
            el.addEventListener('pointerdown', function (e) {
              down = true; moved = false;
              el._sx = e.clientX; el._sy = e.clientY;
              if (e.preventDefault) e.preventDefault();
              timer = setTimeout(function () {
                timer = null; el._lpAt = Date.now(); showHelp(def);
              }, 550);
            });
            el.addEventListener('pointermove', function (e) {
              if (!down) return;
              if (Math.abs(e.clientX - el._sx) > 10 || Math.abs(e.clientY - el._sy) > 10) {
                moved = true; cancel();
              }
            });
            el.addEventListener('pointerup', function () { down = false; cancel() });
            el.addEventListener('pointercancel', function () { down = false; cancel() });
            el.onclick = function () {
              if (el._lpAt && Date.now() - el._lpAt < 900) return;
              try { ceEd.insert('\n' + pretty(def.full) + ','); } catch (e) { UI.toast('插入失败'); return }
              UI.closeSheet(); setDirty(true);
            };
          });
        }
      });
    }
    function check() {
      hideResult();
      if (type === 'rule' && mode === 'form') {
        const r = buildRuleJSON();
        const l = r.list || {};
        if (!l.item || !l.url) {
          showErr('规则不完整：至少需要「每一项」和「链接」两个选择器');
          return;
        }
        showErr('');
        UI.toast('语法通过');
        return;
      }
      if (type === 'py') {
        if (!window.Py || !window.Py.available()) {
          showErr('Python 运行时未内置（安装 with-python 包后可用）');
          return;
        }
        showErr('');
        window.Py.check(src).then(r => {
          if (r.ok) { showErr(''); UI.toast('语法通过'); }
          else showErr('Python 语法错误：' + (r.error || r.err || '未知'));
        });
        return;
      }
      if (type === 'rule') {
        try { JSON.parse(src) } catch (e) { showErr('规则 JSON 解析失败：' + e.message); return }
        showErr('');
        UI.toast('语法通过');
        return;
      }
      try {
        Engine.compile(src);
        showErr('');
        UI.toast('语法通过');
      } catch (e) {
        showErr(e.message);
      }
    }

    function save(silent) {
      if (ceEd && type !== 'rule') { files[activeFile] = ceEd.getValue(); src = files[activeFile]; }
      let text = (type === 'rule') ? src : (files[entry] || '');
      if (type === 'rule' && mode === 'form') text = JSON.stringify(buildRuleJSON(), null, 2);
      if (!String(text || '').trim()) { showErr('脚本为空，无法保存'); return }
      if (type === 'js') {
        try {
          if (files && Object.keys(files).length > 1) Engine.compileBundle(files, entry);
          else Engine.compile(text);
        } catch (e) { showErr('保存失败：' + e.message); return }
      }
      if (type === 'py' && !/def\s+parse\s*\(/.test(text)) {
        showErr('保存失败：入口文件缺少 parse(url, html) 函数');
        return;
      }
      const recBase = (type === 'rule') ? { script: text } : { script: text, files: files, entry: entry };
      try { DB.saveSite(Object.assign({ id: id }, recBase)) } catch (e) { showErr('保存失败：' + e.message); return }
      if (draftSite) {
        const rec = Object.assign({}, draftSite, recBase, { enabled: true });
        try { DB.saveSite(rec) } catch (e) { showErr('保存失败：' + e.message); return }
        if (type === 'py' && window.Py && window.Py.available()) {
          if (window.Py.putFiles) window.Py.putFiles(id, files, entry).catch(function () { });
          else window.Py.put(id, text).catch(function () { });
        }
        Engine.invalidate(id);
        App.siteId = id;
        DB._set('lastSite', id);
        UI.toast('已保存并启用');
        App.home();
        App.setTab('home');
        return;
      }
      /* py 站点：把源码落盘到 filesDir/py，引擎执行时用最新版 */
      if (type === 'py' && window.Py && window.Py.available()) {
        if (window.Py.putFiles) window.Py.putFiles(id, files, entry).then(function (w) { if (w && !w.ok) showErr('保存到 Python 目录失败：' + (w.err || '')) });
        else window.Py.put(id, text).then(function (w) { if (!w.ok) showErr('保存到 Python 目录失败：' + (w.err || '')) });
      }
      Engine.invalidate(id);
      src = text;
      dirtyFiles[activeFile] = false;
      Object.keys(dirtyFiles).forEach(function (k) { delete dirtyFiles[k] });
      renderStrip();
      if (type === 'rule' && mode === 'form') {
        const r = ruleFromScript(text);
        if (!r.error) rule = r;
      }
      setDirty(false);
      showErr('');
      if (!silent) UI.toast('已保存，回浏览页刷新生效');
    }

    function safeHome() {
      let h = '';
      if (type === 'js') {
        try {
          const mod = Engine.compile(src);
          if (mod && typeof mod.home === 'function') h = mod.home();
        } catch (e) { }
      }
      if (!h) {
        try { h = Engine.homeUrl(id) } catch (e) { }
      }
      return h || site.site || '';
    }

    async function runRulePreview(r, home) {
      if (!Net.native() || navigator.onLine === false) {
        setResult('<div class="d1-note">' +
          (navigator.onLine === false ? '网络不可用' : '当前没有 Java 网络桥（桌面预览）') +
          '，未做真实抓取，因此没有运行规则预览。</div>', true);
        return;
      }
      setResult('<div class="d1-note">正在抓取 ' + esc(home) + ' …</div>', true);
      let html;
      try { html = await Net.get(home, { site: id }) } catch (e) {
        if (!killed) showRunError('抓取失败：' + e.message + '\n提示：example.com 需在设置里配置代理或 DoH');
        return;
      }
      if (killed) return;
      const t0 = Date.now();
      const out = previewRule(r, html, home);
      const ms = Date.now() - t0;
      if (out.error) { showRunError(out.error); return }
      const titles = out.cards.slice(0, 3).map(function (c, i) { return (i + 1) + '. ' + (c.title || '(无标题)') });
      setResult('<div class="d1-okline">✓ 前端预览抓到 ' + out.cards.length + ' 条 · 耗时 ' + ms + 'ms</div>' +
        '<div class="d1-test-b">' + titles.map(function (t) { return '<div class="d1-test-row">' + esc(t) + '</div>' }).join('') + '</div>' +
        '<div class="d1-note">这里用浏览器 CSS 选择器预览（与 App 内规则执行器同源）。编码按 UTF-8 解码，GBK 站点会乱码。</div>', true);
    }

    async function run() {
      hideResult();
      showErr('');
      if (type === 'py') {
        if (!window.Py || !window.Py.available()) { showErr('Python 运行时未内置（安装 with-python 包后可用）'); return }
        const pyHome = safeHome() || site.site || '';
        if (!pyHome) { showErr('缺少站点地址，无法测试'); return }
        setResult('<div class="d1-note">正在抓取 ' + esc(pyHome) + ' …</div>', true);
        let pyHtml = '';
        try { pyHtml = await Net.get(pyHome, { site: id }) } catch (e) { showRunError('抓取失败：' + e.message); return }
        if (killed) return;
        const t0py = Date.now();
        setResult('<div class="d1-note">Python 执行中…</div>', true);
        const res = await window.Py.run(src, pyHome, pyHtml);
        if (killed) return;
        if (res.ok) showJson(res.data, 'Python · 抓取 ' + pyHtml.length + 'B · 解析 ' + (Date.now() - t0py) + 'ms');
        else showRunError('Python 执行失败：' + res.err + (res.trace ? '\n' + String(res.trace).split('\n').slice(0, 6).join('\n') : ''));
        return;
      }
      const home = type === 'rule' ? (site.site || '') : safeHome();
      if (!home) { showErr('缺少站点地址，无法测试'); return }

      if (type === 'rule') {
        let r = null;
        if (mode === 'form') r = buildRuleJSON();
        else {
          const parsed = ruleFromScript(src);
          if (!parsed.error) r = parsed;
        }
        if (!r) { showErr('规则 JSON 无法解析，先修正后再测试'); return }
        await runRulePreview(r, home);
        return;
      }

      /* js：当前脚本（未保存也行）→ 真实抓取 → parse */
      let mod;
      try { mod = Engine.compile(src) } catch (e) { showErr('编译失败：' + e.message); return }
      if (!Net.native() || navigator.onLine === false) {
        setResult('<div class="d1-note">' +
          (navigator.onLine === false ? '网络不可用' : '当前没有 Java 网络桥（桌面预览）') +
          '，未做真实抓取，因此没有执行 parse。语法检查已通过。\n' +
          '请在 App 内联网后重试；离线自测可用电脑上的 fixtures/home.html 传给 parse(url, html)。</div>', true);
        return;
      }
      setResult('<div class="d1-note">正在抓取 ' + esc(home) + ' …</div>', true);
      const t0 = Date.now();
      let html;
      try {
        html = await Net.get(home, { site: id });
      } catch (e) {
        if (!killed) showRunError('抓取失败：' + e.message + '\n提示：example.com 需在设置里配置代理或 DoH');
        return;
      }
      if (killed) return;
      try {
        const t1 = Date.now();
        const data = await mod.parse(home, html);
        if (killed) return;
        showJson(data, '抓取 ' + html.length + 'B · 解析 ' + (Date.now() - t1) + 'ms · 总 ' + (Date.now() - t0) + 'ms');
      } catch (e) {
        if (killed) return;
        showRunError('parse 执行失败：' + e.message +
          (e.stack ? '\n' + String(e.stack).split('\n').slice(0, 4).join('\n') : ''));
      }
    }

    function toTerminal() {
      const home = safeHome() || site.site || '';
      let prefill;
      if (type === 'py') {
        prefill = 'python';
      } else if (type === 'rule') {
        prefill = 'rou parse ' + id + ' ' + home;
      } else {
        prefill = 'rou parse ' + id + ' ' + home;
      }
      App.go('terminal', { prefill: prefill });
    }

    const st = curStack();
    if (st) st.cleanup = function () {
      killed = true; clearTimeout(saveTimer);
      window.__editGuard = null;
      if (ceEd) { try { ceEd.destroy() } catch (e) { } ceEd = null; }
    };

    renderMode();
    renderStrip();
    if (initRuleError) showErr(initRuleError);
    return Promise.resolve();
  };

  /* ================= P-06 脚本详情 ================= */
  App.pages['scriptDetail'] = function (root, params) {
    ensureStyles();
    const id = params ? params.id : '';
    const site = DB.site(id);
    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '脚本详情', sub: site ? site.name : '' }));
    const body = document.createElement('div');
    root.appendChild(body);
    if (!site) {
      UI.state(body, 'invalid', { msg: '脚本不存在或已删除' });
      return Promise.resolve();
    }

    let headers = [];
    const hsrc = site.headers || {};
    Object.keys(hsrc).forEach(function (k) { headers.push([k, hsrc[k]]) });
    let saveTimer = null;

    function rowLine(t, v, mono) {
      return '<div class="row"><div class="t"><div class="nm">' + esc(t) + '</div></div>' +
        '<div class="v' + (mono ? ' mono' : '') + '">' + esc(v == null || v === '' ? '—' : v) + '</div></div>';
    }
    function askValue(opt) {
      UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">' + esc(opt.title) + '</div>' +
        '<input class="input" id="d1val" value="' + esc(opt.value || '') + '" placeholder="' + esc(opt.placeholder || '') + '" spellcheck="false" autocapitalize="off">' +
        (opt.hint ? '<div class="d1-note">' + esc(opt.hint) + '</div>' : '') +
        '<div class="d1-sheet-acts"><button class="btn ghost" data-c>取消</button><button class="btn pri" data-ok>确定</button></div></div>',
        {
          onOpen: function (pb) {
            const input = $('#d1val', pb);
            $('[data-c]', pb).onclick = function () { UI.closeSheet() };
            $('[data-ok]', pb).onclick = function () {
              const v = input.value;
              UI.closeSheet();
              opt.onOk(v);
            };
          }
        });
    }

    /* ---------- 请求头：增删 + 防抖自动保存 ---------- */
    function doSaveHeaders() {
      const obj = {};
      for (let i = 0; i < headers.length; i++) {
        const k = String(headers[i][0] || '').trim();
        if (!k) continue;
        obj[k] = String(headers[i][1] == null ? '' : headers[i][1]);
      }
      try { DB.saveSite({ id: id, headers: obj }); site.headers = obj } catch (e) {
        const st = $('#hdrSaved', body);
        if (st) st.textContent = '保存失败：' + e.message;
        return;
      }
      const st = $('#hdrSaved', body);
      if (st) st.textContent = '已保存 · 共 ' + Object.keys(obj).length + ' 项';
    }
    function queueSaveHeaders() {
      const st = $('#hdrSaved', body);
      if (st) st.textContent = '保存中…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(doSaveHeaders, 380);
    }
    function renderHeaders(box) {
      let h = '';
      for (let i = 0; i < headers.length; i++) {
        h += '<div class="d1-kv">' +
          '<input class="d1-in k mono" data-i="' + i + '" data-f="k" placeholder="键" value="' + esc(headers[i][0]) + '" spellcheck="false" autocapitalize="off">' +
          '<input class="d1-in v mono" data-i="' + i + '" data-f="v" placeholder="值" value="' + esc(headers[i][1]) + '" spellcheck="false" autocapitalize="off">' +
          '<div class="d1-x" data-i="' + i + '">✕</div></div>';
      }
      if (!headers.length) h = '<div class="d1-note">未设置站点级请求头，将使用全局默认。</div>';
      box.innerHTML = h;
      $$('input[data-i]', box).forEach(function (el) {
        el.oninput = function () {
          const i = parseInt(el.dataset.i, 10);
          if (!headers[i]) return;
          headers[i][el.dataset.f === 'k' ? 0 : 1] = el.value;
          queueSaveHeaders();
        };
      });
      $$('.d1-x', box).forEach(function (el) {
        el.onclick = function () {
          headers.splice(parseInt(el.dataset.i, 10), 1);
          renderHeaders($('#hdrBox', body));
          queueSaveHeaders();
        };
      });
    }

    /* ---------- UA ---------- */
    function saveUA(v) {
      try {
        DB.saveSite({ id: id, ua: String(v || '') });
        site.ua = String(v || '');
        UI.toast('已更新 UA');
        render();
      } catch (e) { UI.toast('保存失败') }
    }
    function openUASheet() {
      let h = '<div class="d1-sheet-h">User-Agent</div><div class="rows">';
      const cur = presetOfUA(site.ua);
      for (let i = 0; i < UAS.length; i++) {
        const u = UAS[i];
        h += '<div class="row tap" data-ua="' + i + '"><div class="t"><div class="nm">' + esc(u.label) + '</div>' +
          (u.val ? '<div class="ds mono">' + esc(shorten(u.val, 72)) + '</div>' : '<div class="ds">不覆盖设置里的全局 UA</div>') +
          '</div><div class="v">' + (cur === u.label ? '✓' : '') + '</div></div>';
      }
      h += '<div class="row tap" data-ua="custom"><div class="t"><div class="nm">自定义…</div>' +
        '<div class="ds">手动输入 UA 字符串</div></div><div class="arw">›</div></div>' +
        '<div class="d1-note">留空（默认）= 使用全局 UA。保存后 Net.headersFor 立即生效。</div></div>';
      UI.sheet(h, {
        onOpen: function (pb) {
          $$('[data-ua]', pb).forEach(function (el) {
            el.onclick = function () {
              const k = el.dataset.ua;
              UI.closeSheet();
              if (k === 'custom') {
                askValue({
                  title: '自定义 User-Agent', value: site.ua || '', placeholder: 'Mozilla/5.0 …',
                  hint: '清空后保存 = 回退到全局 UA', onOk: saveUA
                });
                return;
              }
              saveUA(UAS[parseInt(k, 10)].val);
            };
          });
        }
      });
    }

    /* ---------- 网络覆盖 ---------- */
    function saveNet(patch) {
      const cur = site.net || {};
      const v = {
        mode: patch.mode || 'global',
        proxy: patch.proxy != null ? patch.proxy : (cur.proxy || ''),
        doh: patch.doh != null ? patch.doh : (cur.doh || '')
      };
      try {
        DB.saveSite({ id: id, net: v });
        site.net = v;
        UI.toast('已保存网络覆盖');
        render();
      } catch (e) { UI.toast('保存失败') }
    }
    function openNetSheet() {
      const cur = (site.net && site.net.mode) || 'global';
      const opts = [
        ['global', '跟随全局', '使用设置里的网络模式'],
        ['direct', '直连', '不走 DoH / 代理'],
        ['doh', 'DoH', '本站点用 DoH 解析域名'],
        ['proxy', '代理', '本站点走 HTTP 代理']
      ];
      let h = '<div class="d1-sheet-h">网络覆盖</div><div class="rows">';
      for (let i = 0; i < opts.length; i++) {
        h += '<div class="row tap" data-net="' + opts[i][0] + '"><div class="t"><div class="nm">' + opts[i][1] + '</div>' +
          '<div class="ds">' + opts[i][2] + '</div></div><div class="v">' + (cur === opts[i][0] ? '✓' : '') + '</div></div>';
      }
      h += '</div><div class="d1-note">只写入站点配置；当前网络层（net.js）暂未读取站点级覆盖，接入后才会按站点生效。</div>';
      UI.sheet(h, {
        onOpen: function (pb) {
          $$('[data-net]', pb).forEach(function (el) {
            el.onclick = function () {
              const m = el.dataset.net;
              UI.closeSheet();
              if (m === 'proxy') {
                saveNet({ mode: 'proxy' });
                askValue({
                  title: '代理地址', value: (site.net && site.net.proxy) || '', placeholder: '127.0.0.1:7890',
                  hint: '留空等同直连；设备上可先 adb reverse tcp:7890 tcp:7890', onOk: function (v) { saveNet({ mode: 'proxy', proxy: v.trim() }) }
                });
                return;
              }
              if (m === 'doh') {
                saveNet({ mode: 'doh' });
                askValue({
                  title: 'DoH 端点', value: (site.net && site.net.doh) || '', placeholder: 'https://223.5.5.5/resolve',
                  hint: '留空 = 使用全局 DoH', onOk: function (v) { saveNet({ mode: 'doh', doh: v.trim() }) }
                });
                return;
              }
              saveNet({ mode: m });
            };
          });
        }
      });
    }

    /* ---------- 缓存 ---------- */
    function cacheInfo() {
      let n = 0, chars = 0;
      const ns = DB.NS + 'cache.' + id + '.';
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(ns) === 0) {
            n++;
            chars += k.length + String(localStorage.getItem(k) || '').length;
          }
        }
      } catch (e) { }
      return { n: n, bytes: chars * 2 };
    }
    function clearCache() {
      const ns = DB.NS + 'cache.' + id + '.';
      const ks = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(ns) === 0) ks.push(k);
        }
        for (let i = 0; i < ks.length; i++) localStorage.removeItem(ks[i]);
      } catch (e) { UI.toast('清理失败'); return }
      UI.toast('已清理');
      render();
    }

    function render() {
      const type = typeOf(site);
      const src = sourceOf(site);
      const lines = src ? src.split('\n').length : 0;
      const c = cacheInfo();
      const uaPreset = presetOfUA(site.ua);
      const net = site.net || {};
      const nmode = net.mode || 'global';
      const netName = { global: '跟随全局', direct: '直连', doh: 'DoH', proxy: '代理' }[nmode] || '跟随全局';

      body.innerHTML = '';

      const hero = document.createElement('div');
      hero.className = 'd1-hero';
      hero.innerHTML = '<div class="d1-hero-ico">' + esc(site.icon || TYPE_ICON[type]) + '</div>' +
        '<div class="d1-hero-t"><div class="d1-hero-n">' + esc(site.name || id) + '</div>' +
        '<div class="d1-hero-m">' + esc(siteDomain(site.site)) + ' · ' + lines + ' 行</div>' +
        '<div class="d1-tags"><span class="tag">' + TYPE_NAME[type] + '</span>' +
        '<span class="tag">' + (site.enabled === false ? '已停用' : '已启用') + '</span></div></div>';
      body.appendChild(hero);

      if (type === 'rule') {
        const w = document.createElement('div');
        w.className = 'd1-warn';
        w.style.margin = '0 var(--pad) var(--s3)';
        w.textContent = '该脚本是硬解规则：保存后由 JS 规则执行器解析（DOMParser + CSS 选择器）。';
        body.appendChild(w);
      }

      const acts = document.createElement('div');
      acts.className = 'd1-actrow';
      acts.innerHTML = '<button class="btn pri" data-a="edit">编辑脚本</button>' +
        '<button class="btn ghost" data-a="export">导出源码</button>';
      body.appendChild(acts);
      $('[data-a="edit"]', acts).onclick = function () { App.go('scriptEdit', { id: id }) };
      $('[data-a="export"]', acts).onclick = function () { copyText(sourceOf(site), '已复制') };

      body.insertAdjacentHTML('beforeend',
        '<div class="rows"><div class="grp">基本信息</div>' +
        rowLine('名称', site.name || '') +
        rowLine('ID（只读）', id, true) +
        rowLine('类型', TYPE_FULL[type]) +
        rowLine('域名', site.site || '', true) +
        rowLine('脚本行数', lines + ' 行') +
        rowLine('创建时间', site.createdAt ? ago(site.createdAt) : '未知') +
        '</div>');

      const hs = document.createElement('div');
      hs.className = 'rows';
      hs.innerHTML = '<div class="grp">请求头（站点级覆盖全局）</div>' +
        '<div id="hdrBox"></div>' +
        '<div class="row tap" id="hdrAdd"><div class="t"><div class="nm" style="color:var(--accent)">＋ 添加请求头</div></div></div>' +
        '<div class="d1-note" id="hdrSaved">修改后自动保存。</div>';
      body.appendChild(hs);
      renderHeaders($('#hdrBox', hs));
      $('#hdrAdd', hs).onclick = function () {
        headers.push(['', '']);
        renderHeaders($('#hdrBox', body));
      };

      body.insertAdjacentHTML('beforeend',
        '<div class="rows"><div class="grp">身份 / UA</div>' +
        '<div class="row tap" id="uaRow"><div class="t"><div class="nm">User-Agent</div>' +
        '<div class="ds">' + esc(uaPreset) + ' · 实际发送：' + esc(shorten(site.ua || '跟随全局设置', 56)) + '</div></div><div class="arw">›</div></div>' +
        '</div>');
      $('#uaRow', body).onclick = openUASheet;

      body.insertAdjacentHTML('beforeend',
        '<div class="rows"><div class="grp">网络覆盖（站点级）</div>' +
        '<div class="row tap" id="netRow"><div class="t"><div class="nm">网络模式</div><div class="ds">' +
        esc(netName) +
        (nmode === 'proxy' && net.proxy ? ' · ' + esc(net.proxy) : '') +
        (nmode === 'doh' && net.doh ? ' · ' + esc(net.doh) : '') +
        '</div></div><div class="arw">›</div></div></div>' +
        '<div class="d1-note">站点级覆盖目前只写入配置，网络层（net.js）暂未读取；接入后才会生效。</div>');
      $('#netRow', body).onclick = openNetSheet;

      body.insertAdjacentHTML('beforeend',
        '<div class="rows"><div class="grp">缓存</div>' +
        '<div class="row"><div class="t"><div class="nm">站点页面缓存</div>' +
        '<div class="ds">' + c.n + ' 项 · 约 ' + fmtSize(c.bytes) + '（按 localStorage 字符数估算）</div></div>' +
        '<button class="btn ghost" id="cacheClear" ' + (c.n ? '' : 'disabled') + '>清理</button></div></div>' +
        '<div class="d1-note">封面图与视频分片缓存尚未落盘（WebView 端未实现），这里只能统计页面 JSON 缓存。</div>');
      const cc = $('#cacheClear', body);
      if (cc) cc.onclick = clearCache;

      const danger = document.createElement('div');
      danger.className = 'd1-actrow d1-dangerrow';
      danger.innerHTML = '<button class="btn danger" data-a="del">删除脚本</button>';
      body.appendChild(danger);
      $('[data-a="del"]', danger).onclick = function () {
        UI.dialog({
          title: '删除脚本',
          msg: '「' + (site.name || id) + '」和它的站点缓存会被删除，不可恢复。',
          danger: true,
          okText: '删除',
          onOk: function () {
            clearTimeout(saveTimer);
            saveTimer = null;
            App.siteRemove(id);
            UI.toast('已删除');
            App.back();
          }
        });
      };
    }

    const st = curStack();
    if (st) st.cleanup = function () {
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      if (DB.site(id)) doSaveHeaders();
    };

    render();
    return Promise.resolve();
  };

  /* ================= P-19 新建脚本向导 ================= */
  App.pages['newscript'] = function (root, params) {
    ensureStyles();
    root.innerHTML = '';

    const W = {
      step: 1,
      type: 'rule',
      name: '',
      id: '',
      idManual: false,
      site: '',
      icon: '🔥',
      group: '',
      uaPreset: '默认（跟随全局）',
      uaCustom: '',
      referer: '',
      enc: 'utf-8',
      rule: emptyRule(),
      code: '',
      result: null
    };
    let killed = false;
    let lastStep = 0;
    let wizEd = null;

    const page = document.createElement('div');
    page.className = 'd1-wizpage';
    root.appendChild(page);
    const bar = UI.topbar({ title: '新建脚本' });
    page.appendChild(bar);
    const scroll = document.createElement('div');
    scroll.className = 'd1-wizbody';
    page.appendChild(scroll);
    const foot = document.createElement('div');
    foot.className = 'd1-stepbar';
    page.appendChild(foot);

    function setTitle() {
      const t = $('.tt', bar);
      if (!t) return;
      const stepTxt = W.step === 1 ? '选择类型' : (W.step === 2 ? '基本信息' :
        (W.type === 'rule' ? '规则' : (W.type === 'js' ? 'JavaScript' : 'Python')));
      t.innerHTML = esc(W.step === 1 ? '新建脚本' : '新建 · ' + W.step + '/3') + '<small>' + esc(stepTxt) + '</small>';
    }

    function field(key, label, value, ph, mono) {
      return '<div class="d1-field"><div class="lb">' + label + '</div>' +
        '<input data-f="' + key + '" class="' + (mono ? 'mono' : '') + '" value="' + esc(value) +
        '" placeholder="' + esc(ph) + '" spellcheck="false" autocomplete="off" autocapitalize="off"></div>';
    }

    /* ---------- ID 规则 ---------- */
    function idTaken(v) {
      if (!v) return false;
      if (DB.site(v)) return true;
      return Object.prototype.hasOwnProperty.call(Engine.builtin, v);
    }
    function idError(v) {
      const v2 = String(v || '').trim();
      if (!v2) return '请填写 ID';
      if (!/^[a-z][a-z0-9_]{2,31}$/.test(v2)) return 'ID 需字母开头，3–32 位小写字母/数字/下划线';
      if (idTaken(v2)) return 'ID 已存在，请换一个';
      return '';
    }
    function slugBase(name) {
      let s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
      if (!s) s = 'site';
      if (!/^[a-z]/.test(s)) s = 's' + s;
      if (s.length < 3) s = (s + '_site').slice(0, 32);
      return s.replace(/_+$/, '') || 'site';
    }
    function makeId(name) {
      const base = slugBase(name);
      if (!idError(base)) return base;
      for (let n = 2; n < 100; n++) {
        const id = base.slice(0, 29) + '_' + n;
        if (!idError(id)) return id;
      }
      return base;
    }

    /* ---------- 第 1 步：类型 ---------- */
    function renderStep1() {
      const types = [
        ['rule', '📋', '硬解规则', '填选择器即可，不用写代码（默认）'],
        ['js', '📜', 'JavaScript', '写解析函数，需要会 JS'],
        ['py', '🐍', 'Python', (window.Py && Py.available()) ? ('内置 CPython ' + (Py.versionText() || '') + '，可执行') : '当前包未内置 Python'],
        ['import', '⤓', '导入现成脚本', 'URL / 剪贴板 / 文件，兼容海阔规则 JSON']
      ];
      let h = '<div class="d1-note">三步新建：① 类型 → ② 基本信息 → ③ 规则/代码 → 保存并启用。</div>';
      h += '<div class="d1-types">';
      for (let i = 0; i < types.length; i++) {
        const t = types[i];
        h += '<div class="d1-type' + (t[0] !== 'import' && W.type === t[0] ? ' on' : '') + '" data-type="' + t[0] + '">' +
          '<div class="d1-type-i">' + t[1] + '</div>' +
          '<div class="d1-type-body"><div class="d1-type-n">' + t[2] + '</div>' +
          '<div class="d1-type-d">' + t[3] + '</div></div></div>';
      }
      h += '</div>';
      h += '<div class="d1-note">硬解规则 90% 的站点够用；JS 适合需要逻辑判断的站点；' +
        'Python 使用内置 CPython（支持 pip 装包）。导入兼容海阔视界 JSON（含 name/site/list）。</div>';
      scroll.innerHTML = h;
      $$('[data-type]', scroll).forEach(function (el) {
        el.onclick = function () {
          const t = el.dataset.type;
          if (t === 'import') { openImportSheet(); return }
          const changed = W.type !== t;
          W.type = t;
          if (changed && t === 'js') W.code = Engine.template('js');
          if (changed && t === 'py') W.code = Engine.template('py');
          W.step = 2;
          render();
        };
      });
    }

    /* ---------- 第 2 步：基本信息 ---------- */
    function renderStep2() {
      const ie = idError(W.id);
      let h = '<div class="d1-note">ID 建后不可改；只能小写字母、数字、下划线，3–32 位，首位必须是字母。</div>';
      h += '<div class="rows">' +
        field('name', '名称 <b class="d1-req">*</b>', W.name, '必填，如 示例站点', false) +
        field('id', 'ID', W.id, 'demo_site', true) +
        '</div>' +
        '<div class="d1-hint" id="idHint"' + (ie ? '' : ' style="display:none"') + '>' + esc(ie) + '</div>';
      h += '<div class="rows">' + field('site', '站点地址 <b class="d1-req">*</b>', W.site, 'https://example.com', true) + '</div>';
      h += '<div class="rows"><div class="grp">图标</div><div class="d1-emoji">';
      for (let i = 0; i < EMOJIS.length; i++) {
        h += '<b data-e="' + EMOJIS[i] + '" class="' + (W.icon === EMOJIS[i] ? 'on' : '') + '">' + EMOJIS[i] + '</b>';
      }
      h += '</div></div>';
      h += '<div class="rows"><div class="grp">分组</div>' + field('group', '分组', W.group, '影视 / 漫画 / 图站', false) + '</div>';
      h += '<div class="rows"><div class="grp">请求头</div>' +
        '<div class="d1-field"><div class="lb">User-Agent</div><div class="d1-select" id="uaSel">' + esc(W.uaPreset) + '<span>›</span></div></div>' +
        (W.uaPreset === '自定义' ? field('uaCustom', 'UA 值', W.uaCustom, 'Mozilla/5.0 …', true) : '') +
        field('referer', 'Referer', W.referer, '留空 = 同站点', true) +
        '<div class="d1-field"><div class="lb">编码</div><div class="seg"><b data-enc="utf-8" class="' + (W.enc === 'utf-8' ? 'on' : '') + '">UTF-8</b>' +
        '<b data-enc="gbk" class="' + (W.enc === 'gbk' ? 'on' : '') + '">GBK</b></div></div>' +
        '</div>';
      h += '<div class="d1-note">UA / Referer 会写入站点配置并在请求时带上；编码当前只记录，GBK 解码转换尚未实现。</div>';
      scroll.innerHTML = h;
      bindStep2();
    }

    function bindStep2() {
      $$('input[data-f]', scroll).forEach(function (el) {
        const key = el.dataset.f;
        el.addEventListener('input', function () {
          W[key] = el.value;
          if (key === 'name' && !W.idManual) {
            W.id = makeId(el.value);
            const idEl = $('input[data-f="id"]', scroll);
            if (idEl) idEl.value = W.id;
          }
          if (key === 'id') W.idManual = true;
          if (key === 'id' || key === 'name') {
            const hint = $('#idHint', scroll);
            const e = idError(W.id);
            if (hint) {
              hint.textContent = e;
              hint.style.display = e ? 'block' : 'none';
            }
          }
        });
      });
      $$('[data-e]', scroll).forEach(function (el) {
        el.onclick = function () {
          W.icon = el.dataset.e;
          $$('[data-e]', scroll).forEach(function (x) { x.classList.toggle('on', x === el) });
        };
      });
      const uaSel = $('#uaSel', scroll);
      if (uaSel) uaSel.onclick = openUASheet;
      $$('[data-enc]', scroll).forEach(function (el) {
        el.onclick = function () {
          W.enc = el.dataset.enc;
          $$('[data-enc]', scroll).forEach(function (x) { x.classList.toggle('on', x === el) });
        };
      });
    }

    function openUASheet() {
      let h = '<div class="d1-sheet-h">User-Agent</div><div class="rows">';
      for (let i = 0; i < UAS.length; i++) {
        const u = UAS[i];
        h += '<div class="row tap" data-ua="' + i + '"><div class="t"><div class="nm">' + esc(u.label) + '</div>' +
          (u.val ? '<div class="ds mono">' + esc(shorten(u.val, 70)) + '</div>' : '<div class="ds">不覆盖全局 UA</div>') +
          '</div><div class="v">' + (W.uaPreset === u.label ? '✓' : '') + '</div></div>';
      }
      h += '<div class="row tap" data-ua="custom"><div class="t"><div class="nm">自定义…</div>' +
        '<div class="ds">手动输入 UA 字符串</div></div><div class="arw">›</div></div></div>';
      UI.sheet(h, {
        onOpen: function (pb) {
          $$('[data-ua]', pb).forEach(function (el) {
            el.onclick = function () {
              const k = el.dataset.ua;
              UI.closeSheet();
              W.uaPreset = k === 'custom' ? '自定义' : UAS[parseInt(k, 10)].label;
              render();
            };
          });
        }
      });
    }

    function openCodeDraft() {
      const id = W.id || makeId(W.name);
      W.id = id;
      const draftSite = {
        id: id, name: W.name, site: normSite(W.site), icon: W.icon || '🌐',
        group: String(W.group || '').trim(), type: W.type, enabled: false,
        script: W.code || Engine.template(W.type), encoding: W.enc
      };
      W.step = 2;                 // 返回时回到“基本信息”，不是退出
      App.go('scriptEdit', { id: id, draftSite: draftSite });
    }

    function nextFromBasic() {
      const name = String(W.name || '').trim();
      W.name = name;
      if (!name) {
        UI.toast('名称必填');
        const el = $('input[data-f="name"]', scroll);
        if (el) el.focus();
        return;
      }
      if (!normSite(W.site)) {
        UI.toast('站点地址需 http(s)');
        const el = $('input[data-f="site"]', scroll);
        if (el) el.focus();
        return;
      }
      if (!W.id) W.id = makeId(name);
      const e = idError(W.id);
      if (e) {
        UI.toast('ID 需修改');
        const hint = $('#idHint', scroll);
        if (hint) {
          hint.textContent = e;
          hint.style.display = 'block';
        }
        return;
      }
      if (W.type === 'js' || W.type === 'py') {
        openCodeDraft();
        return;
      }
      W.step = 3;
      render();
    }

    /* ---------- 第 3 步：规则 / 代码 ---------- */
    const RULE_FIELDS = [
      ['list.container', '列表容器', '可留空（用「每一项」即可）'],
      ['list.item', '每一集', 'li'],
      ['list.title', '标题', 'h3'],
      ['list.pic', '封面', 'img'],
      ['list.url', '链接', 'a']
    ];
    const RULE_FIELDS2 = [
      ['detail.title', '详情标题', 'h1'],
      ['detail.playRe', '播放正则', 'm3u8\\?url=([^&]+)'],
      ['search.template', '搜索模板', 'https://example.com/search?q=**'],
      ['page.param', '分页参数', 'page']
    ];

    function ruleSources() { try { return DB._get('ruleSources', []) || []; } catch (e) { return []; } }
    function ruleCache() { try { return DB._get('ruleCache', {}) || {}; } catch (e) { return {}; } }

    function openRuleTemplates() {
      const presets = [
        { n: '通用列表', d: 'li + h3 + a + img，适合大多数列表页', l: { item: 'li', title: 'h3', url: 'a', pic: 'img' } },
        { n: 'WordPress 博客', d: 'article + h2 + a + img', l: { item: 'article', title: 'h2', url: 'a', pic: 'img' } },
        { n: 'Discuz 论坛', d: '主题表格 + a.xst', l: { item: 'tbody[id^="normalthread_"]', title: 'a.xst', url: 'a.xst', pic: 'img' } },
        { n: '静态博客', d: '.post + h2 + a', l: { item: '.post', title: 'h2', url: 'a', pic: 'img' } },
        { n: '视频卡片', d: '.item + .title + a + img', l: { item: '.item', title: '.title', url: 'a', pic: 'img' } }
      ];
      try {
        if (window.Packs && Packs.parserTemplates) Packs.parserTemplates().forEach(function (t) {
          presets.push({ n: t.name, d: t.desc || ('来自扩展包 ' + t.pack), l: (t.rule && t.rule.list) || {}, rule: t.rule });
        });
      } catch (e) { }
      var cache = ruleCache();
      ruleSources().forEach(function (src) {
        var c = cache[src.url];
        if (!c || !c.items) return;
        c.items.forEach(function (t) {
          if (t && t.rule && t.rule.list) presets.push({ n: (t.name || '在线模板'), d: (t.desc || '') + ' · ' + src.url, l: t.rule.list, rule: t.rule });
        });
      });
      UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">规则模板</div>' +
        '<div class="d1-note">先套模板，再按站点实际结构改选择器；保存后是本地 JSON。在线源只缓存模板，不执行远程代码。</div><div class="rows">' +
        presets.map((p, i) => '<div class="row tap" data-tpl="' + i + '"><div class="t"><div class="nm">' + esc(p.n) +
          '</div><div class="ds">' + esc(p.d) + '</div></div><div class="arw">＋</div></div>').join('') +
        '</div><div class="rows"><div class="row tap" data-rulesrc><div class="t"><div class="nm">在线规则源</div>' +
        '<div class="ds">管理订阅 URL · 已配置 ' + ruleSources().length + ' 个</div></div><div class="arw">›</div></div></div></div>', {
        onOpen: function (pb) {
          $$('[data-tpl]', pb).forEach(function (el) {
            el.onclick = function () {
              const p = presets[+el.dataset.tpl];
              W.rule = p.rule ? Object.assign({}, p.rule) : Object.assign({}, W.rule || emptyRule());
              W.rule.list = Object.assign({}, W.rule.list || {}, p.l);
              UI.closeSheet();
              renderStep3();
              UI.toast('已套用：' + p.n);
            };
          });
          var rs = $('[data-rulesrc]', pb);
          if (rs) rs.onclick = function () { UI.closeSheet(); openRuleSources(); };
        }
      });
    }

    function openRuleSources() {
      var list = ruleSources();
      var cache = ruleCache();
      var h = '<div class="d1-pad"><div class="d1-sheet-h">在线规则源</div>' +
        '<div class="d1-note">JSON 格式：[{"name":"…","desc":"…","rule":{"list":{...}}}] 或 {"templates":[...]}。只取数据，不执行远程脚本。</div>';
      if (list.length) {
        h += '<div class="rows">' + list.map(function (s, i) {
          var c = cache[s.url] || {};
          return '<div class="row"><div class="t"><div class="nm mono lines2">' + esc(s.url) + '</div>' +
            '<div class="ds">' + (c.items ? ('已缓存 ' + c.items.length + ' 个模板 · ' + (c.at ? new Date(c.at).toLocaleString() : '')) : '未拉取') + '</div></div>' +
            '<div class="arw" data-src-refresh="' + i + '">⟳</div><div class="arw" data-src-del="' + i + '">🗑</div></div>';
        }).join('') + '</div>';
      } else {
        h += '<div class="d1-note">还没有规则源。</div>';
      }
      h += '<div class="d1-pad"><input class="input" data-src-url placeholder="https://example.com/rules.json">' +
        '<div class="d1-steprow"><button class="btn ghost" data-c>关闭</button><button class="btn pri" data-src-add>添加并拉取</button></div></div></div>';
      UI.sheet(h, {
        onOpen: function (pb) {
          $('[data-c]', pb).onclick = function () { UI.closeSheet() };
          $('[data-src-add]', pb).onclick = function () {
            var u = String($('[data-src-url]', pb).value || '').trim();
            if (!/^https?:\/\//i.test(u)) { UI.toast('请输入 http(s) URL'); return }
            if (list.some(function (x) { return x.url === u; })) { UI.toast('已存在'); return }
            list.push({ url: u, at: Date.now() });
            DB._set('ruleSources', list);
            fetchSource(u, function () { UI.closeSheet(); openRuleSources(); });
          };
          $$('[data-src-refresh]', pb).forEach(function (el) {
            el.onclick = function () { var s = list[+el.dataset.srcRefresh]; if (s) fetchSource(s.url, function () { UI.closeSheet(); openRuleSources(); }); };
          });
          $$('[data-src-del]', pb).forEach(function (el) {
            el.onclick = function () {
              list.splice(+el.dataset.srcDel, 1);
              DB._set('ruleSources', list);
              UI.closeSheet(); openRuleSources();
            };
          });
        }
      });
    }

    var RULE_PUB = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlBV+B3naHspDIwuG0nd7EkT+l6IAbB7I7Ovee/7fbN8TAb0uxUfZh/Px6ks32WtaEScEOGTMIPy3xKysCW5daCshAPlUM2gNQy+B/Cmcjrfubjm3koFK2erX1ZzaJUAK1G+H8uyCCvV9KSp9z40M6HjLf4y0FjIhxains0DzeZtEpAJZMmncmO1XvyoJsUu3YcNaiohTpl3RiPyWg6ftn2nxCWUiNfmkioSSFxvM84SnhuWK9JTijmJmdTzv0Lt/WNh3K4+CiJ0jKQNsnPXgRouMDJUuWIIPzLi4//+pfGHo8Mxz3aFN+MVNb90PrCOevAaz4+Y/7VgCuHkkSYyU+QIDAQAB';
  function verifyRulePayload(payload, sig) {
    try {
      var bin = atob(RULE_PUB), buf = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return crypto.subtle.importKey('spki', buf, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']).then(function (key) {
        var sb = atob(sig), sbuf = new Uint8Array(sb.length);
        for (var j = 0; j < sb.length; j++) sbuf[j] = sb.charCodeAt(j);
        return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sbuf, new TextEncoder().encode(payload));
      });
    } catch (e) { return Promise.resolve(false); }
  }

  function fetchSource(url, done) {
      UI.toast('正在拉取…');
      Promise.resolve(Net.request('GET', url)).then(function (r) {
        if (!r) { UI.toast('拉取失败：网络错误'); return; }
        if (r.status && r.status >= 400) { UI.toast('拉取失败：HTTP ' + r.status); return; }
        var txt = r.txt || r.text || '';
        var obj;
        try { obj = JSON.parse(txt); } catch (e) { UI.toast('不是合法 JSON'); return; }
        function accept(srcObj, verified) {
          var items = Array.isArray(srcObj) ? srcObj : (srcObj.templates || srcObj.rules || []);
          if (!Array.isArray(items)) { UI.toast('缺少 templates/rules'); return; }
          items = items.filter(function (t) { return t && t.rule && t.rule.list; });
          if (!items.length) { UI.toast('没有可用模板（需要 rule.list）'); return; }
          var c = ruleCache();
          c[url] = { at: Date.now(), items: items, verified: !!verified };
          DB._set('ruleCache', c);
          UI.toast((verified ? '签名校验通过，' : '未签名源，') + '已缓存 ' + items.length + ' 个模板');
          if (done) done();
        }
        if (obj && obj.sig) {
          if (!obj.payload) { UI.toast('签名源缺少 payload'); return; }
          verifyRulePayload(obj.payload, obj.sig).then(function (ok) {
            if (!ok) { UI.toast('规则源签名无效，已拒绝'); return; }
            var parsed;
            try { parsed = JSON.parse(obj.payload); } catch (e) { UI.toast('签名 payload 不是 JSON'); return; }
            accept(parsed, true);
          });
          return;
        }
        accept(obj, false);
      }, function (e) { UI.toast('拉取失败：' + (e.message || e)); });
    }

    function openRuleImport() {
      UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">导入规则 JSON</div>' +
        '<div class="d1-note">粘贴规则 JSON（或海阔格式对象）：至少含 list.item 与 list.url。</div>' +
        '<textarea class="input" rows="8" data-rule-json placeholder="{&quot;list&quot;:{...}}"></textarea>' +
        '<div class="d1-steprow"><button class="btn ghost" data-c>取消</button><button class="btn pri" data-ok>导入</button></div></div>', {
        onOpen: function (pb) {
          $('[data-c]', pb).onclick = function () { UI.closeSheet() };
          $('[data-ok]', pb).onclick = function () {
            let obj;
            try { obj = JSON.parse($('[data-rule-json]', pb).value || '{}') } catch (e) { UI.toast('JSON 解析失败'); return }
            if (!obj || typeof obj !== 'object' || !obj.list) { UI.toast('规则缺少 list'); return }
            W.rule = obj;
            UI.closeSheet(); renderStep3(); UI.toast('规则已导入');
          };
        }
      });
    }

    function renderRuleStep() {
      let h = '<div class="d1-steprow" style="padding:0 var(--pad) var(--s2)">' +
        '<button class="btn ghost" data-rule-tpl>规则模板</button>' +
        '<button class="btn ghost" data-rule-import>导入规则 JSON</button></div>';
      h += '<div class="d1-note">选择器用 CSS 语法；容器 + 每一项 决定列表，子选择器在每一项内部取值。</div>';
      h += '<div class="rows"><div class="grp">列表规则</div>';
      for (let i = 0; i < RULE_FIELDS.length; i++) {
        h += field(RULE_FIELDS[i][0], RULE_FIELDS[i][1], getPath(W.rule, RULE_FIELDS[i][0]), RULE_FIELDS[i][2], true);
      }
      h += '</div>';
      h += '<div class="d1-expr" id="expr">等价表达式：' + esc(exprOf(W.rule) || '（填完选择器后生成）') + '</div>';
      h += '<div class="rows"><div class="grp">详情与搜索</div>';
      for (let i = 0; i < RULE_FIELDS2.length; i++) {
        h += field(RULE_FIELDS2[i][0], RULE_FIELDS2[i][1], getPath(W.rule, RULE_FIELDS2[i][0]), RULE_FIELDS2[i][2], true);
      }
      h += '</div>';
      h += '<div id="testres">' + (W.result ? W.result.html : '') + '</div>';
      h += '<div class="d1-note">规则执行器已接入（JS 端 DOMParser + CSS 选择器）：本页「自动识别 / 测试抓取」' +
        '只用浏览器做前端预览，保存下来的是 JSON 规则源码。</div>';
      scroll.innerHTML = h;
      const tplBtn = $('[data-rule-tpl]', scroll);
      if (tplBtn) tplBtn.onclick = openRuleTemplates;
      const impBtn = $('[data-rule-import]', scroll);
      if (impBtn) impBtn.onclick = openRuleImport;
      $$('input[data-f]', scroll).forEach(function (el) {
        const p = el.dataset.f;
        el.addEventListener('input', function () {
          setPath(W.rule, p, el.value);
          const ex = $('#expr', scroll);
          if (ex) ex.textContent = '等价表达式：' + (exprOf(W.rule) || '（填完选择器后生成）');
        });
      });
    }

    function renderCodeStep(kind) {
      if (wizEd) { try { wizEd.destroy() } catch (e) { } wizEd = null; }
      let h = '';
      const pyOk = !!(window.Py && Py.available());
      if (kind === 'js' || (kind === 'py' && pyOk)) {
        h += '<div class="d1-note">' + (kind === 'py'
          ? ('Python ' + (Py.versionText() || '已内置') + '：可编辑、语法检查、测试抓取、保存并启用。')
          : 'JavaScript 脚本：必须提供 parse(url, html)，返回 docs/02 的结构。已预填模板。') + '</div>';
        h += '<div class="d1-edtools" data-wiztools>' +
          '<b data-e="undo">撤销</b><b data-e="redo">重做</b><i></i>' +
          [['{ }', '{}'], ['( )', '()'], ['[ ]', '[]'], ['" "', '""'], ["' '", "''"],
           [':', ':'], [';', ';'], ['=', '='], ['#', '#'], ['$', '$'], ['_', '_']]
            .map(function (x) { return '<b data-e="sym" data-s="' + esc(x[1]) + '">' + esc(x[0]) + '</b>'; }).join('') +
          '</div>';
        h += '<div class="wiz-ce" id="wizEd"></div>';
        h += '<div id="testres">' + (W.result ? W.result.html : '') + '</div>';
        h += '<div class="d1-note">保存前会做语法检查；「测试抓取」会真实抓取首页并执行当前脚本。</div>';
      } else {
        h += '<div class="d1-warn" style="margin:0 var(--pad) var(--s2)">当前安装包没有内置 Python（需要 with-python 包）：只能保存源码，不能执行或测试。</div>';
        h += '<pre class="d1-codebox d1-codebox-pre">' + esc(W.code || Engine.template('py')) + '</pre>';
        h += '<div class="d1-note">保存后作为 .py 源码入库；安装内置 Python 的包后即可执行。</div>';
      }
      scroll.innerHTML = h;
      if (kind === 'js' || (kind === 'py' && pyOk)) {
        const host = $('#wizEd', scroll);
        if (!host) return;
        if (window.CodeEditor) {
          try {
            wizEd = window.CodeEditor(host, {
              value: W.code, lang: kind === 'py' ? 'py' : 'js',
              onChange: function (v) { W.code = v }
            });
          } catch (e) { Log.err('向导编辑器初始化失败: ' + e.message) }
        }
        if (!wizEd) {
          host.innerHTML = '<textarea class="d1-codebox" id="wizCode" spellcheck="false" wrap="off"></textarea>';
          const ta = $('#wizCode', host);
          ta.value = W.code;
          ta.addEventListener('input', function () { W.code = ta.value });
        }
        const tools = $('[data-wiztools]', scroll);
        if (tools && wizEd) {
          $$('[data-e]', tools).forEach(function (b) {
            b.onclick = function () {
              const k = b.dataset.e;
              if (k === 'undo') { if (!wizEd.undo()) UI.toast('没有可撤销的编辑'); return }
              if (k === 'redo') { if (!wizEd.redo()) UI.toast('没有可重做的编辑'); return }
              const s = b.dataset.s || '';
              if (s === '{}' || s === '()' || s === '[]') { wizEd.wrap(s.charAt(0), s.charAt(1)); return }
              if (s === '""') { wizEd.wrap('"', '"'); return }
              if (s === "''") { wizEd.wrap("'", "'"); return }
              wizEd.insert(s);
            };
          });
        }
      }
    }

    function renderStep3() {
      if (W.type === 'rule') renderRuleStep();
      else if (W.type === 'js') renderCodeStep('js');
      else renderCodeStep('py');
    }

    /* ---------- 底部操作条 ---------- */
    function renderFoot() {
      if (W.step === 1) { foot.innerHTML = ''; return }
      if (W.step === 2) {
        foot.innerHTML = '<div class="d1-steprow"><button class="btn ghost back" data-prev>上一步</button>' +
          '<button class="btn pri" data-next>下一步</button></div>';
        $('[data-prev]', foot).onclick = function () { W.step = 1; render() };
        $('[data-next]', foot).onclick = nextFromBasic;
        return;
      }
      let h = '';
      if (W.type !== 'py' || (window.Py && Py.available())) {
        h += '<div class="d1-steprow">';
        if (W.type === 'rule') h += '<button class="btn ghost" data-a="guess">✨ 自动识别</button>';
        h += '<button class="btn ghost" data-a="test">▶ 测试抓取</button></div>';
      }
      h += '<div class="d1-steprow"><button class="btn ghost back" data-prev>上一步</button>' +
        '<button class="btn pri" data-save>保存并启用</button></div>';
      foot.innerHTML = h;
      $('[data-prev]', foot).onclick = function () { W.step = 2; render() };
      $('[data-save]', foot).onclick = saveNew;
      const guess = $('[data-a="guess"]', foot);
      if (guess) guess.onclick = autoGuess;
      const test = $('[data-a="test"]', foot);
      if (test) test.onclick = testFetch;
    }

    function render() {
      const changed = lastStep !== W.step;
      lastStep = W.step;
      setTitle();
      if (W.step === 1) renderStep1();
      else if (W.step === 2) renderStep2();
      else renderStep3();
      renderFoot();
      if (changed) scroll.scrollTop = 0;
    }

    /* ---------- 抓取 / 自动识别 / 测试 ---------- */
    function wizHeaders() {
      const h = {};
      const ua = uaOfPreset(W.uaPreset, W.uaCustom);
      if (ua) h['User-Agent'] = ua;
      if (String(W.referer || '').trim()) h['Referer'] = String(W.referer).trim();
      return h;
    }
    async function fetchPage(url) {
      if (!url) throw new Error('站点地址为空');
      if (navigator.onLine === false) throw new Error('网络不可用，请检查网络后重试');
      let html;
      try {
        html = await Net.get(url, { headers: wizHeaders() });
      } catch (e) {
        throw new Error('抓取失败：' + (e && e.message ? e.message : e) +
          '（无 Java 桥时浏览器受跨域限制；代理 / DoH 未配置也会失败）');
      }
      if (!html || !String(html).trim()) throw new Error('抓取失败：返回内容为空');
      return html;
    }
    function setTest(html) {
      W.result = { html: html };
      const box = $('#testres', scroll);
      if (box) box.innerHTML = html;
    }
    function testBox(title, inner) {
      return '<div class="d1-test"><div class="d1-test-h">' + esc(title) + '</div>' +
        '<div class="d1-test-b">' + inner + '</div></div>';
    }
    function hrefShape(href, base) {
      const h = String(href || '').trim();
      if (!h || h === '#' || /^(javascript|mailto|tel):/i.test(h)) return '';
      let u;
      try { u = new URL(h, base) } catch (e) { return '' }
      let baseOrigin = '';
      try { baseOrigin = new URL(base).origin } catch (e) { return '' }
      if (u.origin !== baseOrigin) return '';
      const segs = u.pathname.split('/').filter(function (s) { return s !== '' });
      if (!segs.length) return '';
      const shape = segs.map(function (s) { return /^[0-9a-zA-Z_-]{6,}$/.test(s) ? '*' : s }).join('/');
      return '/' + shape;
    }
    function selectorOf(el) {
      if (!el || !el.tagName) return '';
      const id = el.getAttribute ? el.getAttribute('id') : '';
      if (id && /^[A-Za-z][\w-]*$/.test(id)) return '#' + id;
      const cls = (el.getAttribute ? el.getAttribute('class') : '') || '';
      const parts = String(cls).split(/\s+/);
      for (let i = 0; i < parts.length; i++) {
        if (/^[A-Za-z_][\w-]*$/.test(parts[i])) return '.' + parts[i];
      }
      return el.tagName.toLowerCase();
    }
    /* 取列表里出现频率 ≥90% 的一个安全 class，用于把「每一项」收紧 */
    function stableClass(list) {
      if (!list.length) return '';
      const first = String(list[0].getAttribute('class') || '').split(/\s+/);
      let best = '';
      for (let i = 0; i < first.length; i++) {
        const c = first[i];
        if (!/^[A-Za-z_][\w-]*$/.test(c)) continue;
        let n = 0;
        for (let j = 0; j < list.length; j++) {
          const cls = String(list[j].getAttribute('class') || '').split(/\s+/);
          if (cls.indexOf(c) >= 0) n++;
        }
        if (n >= list.length * 0.9) { best = c; break }
      }
      return best;
    }
    /* 启发式：取出现次数最多的 a[href] 路径模式 + 其内部 h3；失败给原因，不假成功
       实测（fixtures/home.html）卡片本身就是 <a>，所以先判断「每一项」是不是 a 自己。 */
    function guessRule(html, pageUrl) {
      let doc;
      try { doc = new DOMParser().parseFromString(html, 'text/html') } catch (e) { return { ok: false, reason: 'HTML 解析失败：' + e.message } }
      const anchors = Array.prototype.slice.call(doc.querySelectorAll('a[href]'));
      if (!anchors.length) return { ok: false, reason: '页面里没有 <a href> 链接，无法猜列表结构' };
      const groups = {};
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        if (a.closest && a.closest('nav,header,footer')) continue;
        const s = hrefShape(a.getAttribute('href'), pageUrl);
        if (!s) continue;
        if (!groups[s]) groups[s] = [];
        groups[s].push(a);
      }
      let best = '', bestN = 0;
      Object.keys(groups).forEach(function (k) {
        if (groups[k].length > bestN) { bestN = groups[k].length; best = k }
      });
      if (!best || bestN < 3) {
        return { ok: false, reason: '没有找到重复出现的站内链接结构（最多只有 ' + bestN + ' 个同构链接），无法自动识别' };
      }
      const shapeGroup = groups[best];
      const withHead = shapeGroup.filter(function (a) { return !!a.querySelector('h3') });
      const useSub = withHead.length >= Math.max(3, Math.floor(shapeGroup.length * 0.4)) ? withHead : shapeGroup;

      /* 每一项：优先认为是 a 自己（卡片是链接），否则取统一父元素 */
      const headCount = useSub.filter(function (a) { return !!a.querySelector('h3') }).length;
      let unitIsAnchor = headCount >= useSub.length * 0.6;
      let units = [];
      let item = '';
      let container = '';

      function anchorSelector() {
        const cls = stableClass(useSub);
        /* 用形状里的固定前缀收紧为 href 前缀选择器（相对与绝对链接都支持） */
        const firstHref = String(useSub[0].getAttribute('href') || '');
        const star = String(best).indexOf('*');
        const literal = star >= 0 ? String(best).slice(0, star) : '';
        let prefix = '';
        if (literal) {
          if (firstHref.indexOf(literal) === 0) prefix = literal;
          else {
            const m = firstHref.match(/^([a-z]+:\/\/[^/]+)/i);
            if (m && firstHref.slice(m[1].length).indexOf(literal) === 0) prefix = m[1] + literal;
          }
          if (prefix) {
            for (let i = 0; i < useSub.length; i++) {
              if (String(useSub[i].getAttribute('href') || '').indexOf(prefix) !== 0) { prefix = ''; break }
            }
          }
        }
        let sel = 'a' + (cls ? '.' + cls : '') + (prefix ? '[href^="' + prefix + '"]' : '');
        try {
          if (doc.querySelectorAll(sel).length > useSub.length * 3.5) {
            sel = 'a' + (prefix ? '[href^="' + prefix + '"]' : '');
            if (doc.querySelectorAll(sel).length > useSub.length * 3.5) sel = 'a';
          }
        } catch (e) { }
        return sel;
      }

      if (unitIsAnchor) {
        units = useSub;
        item = anchorSelector();
      } else {
        const pTag = {};
        for (let i = 0; i < useSub.length; i++) {
          const p = useSub[i].parentElement;
          if (!p) continue;
          const t = p.tagName.toLowerCase();
          pTag[t] = (pTag[t] || 0) + 1;
        }
        let tag = '', tagN = 0;
        Object.keys(pTag).forEach(function (t) { if (pTag[t] > tagN) { tagN = pTag[t]; tag = t } });
        if (!tag || tagN < Math.max(3, Math.floor(useSub.length * 0.6))) {
          unitIsAnchor = true;
          units = useSub;
          item = anchorSelector();
        } else {
          units = useSub.map(function (a) { return a.parentElement }).filter(Boolean);
          item = tag;
          /* 容器：按「每一项的父元素」分簇，取最大簇；再用选择器在文档里回验是否命中该容器 */
          const clusters = {};
          const order = [];
          for (let i = 0; i < units.length; i++) {
            const p = units[i].parentElement;
            if (!p) continue;
            if (!clusters[p]) { clusters[p] = []; order.push(p) }
            clusters[p].push(units[i]);
          }
          let bestP = null, bestC = null;
          for (let i = 0; i < order.length; i++) {
            if (!bestC || clusters[order[i]].length > bestC.length) { bestP = order[i]; bestC = clusters[order[i]] }
          }
          if (bestP) {
            const sel = selectorOf(bestP);
            let hit = false;
            try {
              const cand = doc.querySelectorAll(sel);
              for (let i = 0; i < cand.length; i++) if (cand[i] === bestP) { hit = true; break }
            } catch (e) { }
            if (hit) container = sel;
            if (bestC && bestC.length < units.length * 0.5) {
              return { ok: false, reason: '找到 ' + bestN + ' 个同构链接，但它们的父元素不统一（可能不在同一列表里），无法确定「每一项」' };
            }
          }
        }
      }

      const ratio = function (sel) {
        let n = 0;
        for (let i = 0; i < units.length; i++) {
          try { if (units[i].querySelector(sel)) n++ } catch (e) { }
        }
        return n;
      };
      let title = '';
      if (ratio('h3') >= units.length * 0.5) title = 'h3';
      else if (ratio('h2') >= units.length * 0.5) title = 'h2';
      else if (ratio('h1') >= units.length * 0.5) title = 'h1';
      const pic = ratio('img') >= units.length * 0.5 ? 'img' : '';
      return {
        ok: true,
        count: useSub.length,
        shape: best,
        list: { container: container, item: item, title: title, pic: pic, url: 'a' }
      };
    }

    async function autoGuess() {
      const siteUrl = normSite(W.site);
      if (!siteUrl) { UI.toast('站点地址为空'); return }
      setTest(testBox('自动识别', '<span class="spin"></span> 正在抓取首页并分析结构…'));
      let html;
      try { html = await fetchPage(siteUrl) } catch (e) {
        if (!killed) setTest(testBox('自动识别失败', '<div class="d1-errtext">' + esc(e.message) + '</div>'));
        return;
      }
      if (killed) return;
      const g = guessRule(html, siteUrl);
      if (!g.ok) {
        setTest(testBox('自动识别失败', '<div class="d1-errtext">' + esc(g.reason) +
          '\n可手动填写选择器，再点「测试抓取」验证。</div>'));
        return;
      }
      W.rule.list.container = g.list.container;
      W.rule.list.item = g.list.item;
      W.rule.list.title = g.list.title;
      W.rule.list.pic = g.list.pic;
      W.rule.list.url = g.list.url;
      renderRuleStep();
      setTest(testBox('自动识别完成',
        '<div class="d1-okline">✓ 找到 ' + g.count + ' 个同构链接（路径模式 ' + esc(g.shape) + '）</div>' +
        '<div class="d1-meta">容器 <span class="mono">' + esc(g.list.container || '未猜（不需要）') + '</span> · 每一项 <span class="mono">' +
        esc(g.list.item || '(无)') + '</span> · 标题 <span class="mono">' + esc(g.list.title || '(无)') +
        '</span> · 封面 <span class="mono">' + esc(g.list.pic || '(无)') + '</span></div>' +
        '<div class="d1-note">这只是启发式猜测，不保证正确；请点「测试抓取」核对。详情 / 搜索选择器需要手动补。</div>'));
    }

    function countCards(data) {
      if (!data || typeof data !== 'object') return 0;
      if (data.cards && data.cards.length) return data.cards.length;
      if (data.sections && data.sections.length) {
        let n = 0;
        for (let i = 0; i < data.sections.length; i++) n += (data.sections[i].cards || []).length;
        return n;
      }
      if (data.detail) return 1;
      if (data.heroes && data.heroes.length) return data.heroes.length;
      return 0;
    }
    function firstCards(data, n) {
      const out = [];
      const push = function (c) { if (c && out.length < n) out.push(c) };
      if (!data || typeof data !== 'object') return out;
      if (data.cards && data.cards.length) { for (let i = 0; i < data.cards.length; i++) push(data.cards[i]) }
      else if (data.sections && data.sections.length) {
        for (let i = 0; i < data.sections.length; i++) {
          const cs = data.sections[i].cards || [];
          for (let j = 0; j < cs.length; j++) push(cs[j]);
        }
      } else if (data.detail) push(data.detail);
      else if (data.heroes) { for (let i = 0; i < data.heroes.length; i++) push(data.heroes[i]) }
      return out;
    }

    async function testFetch() {
      const pyOk = !!(window.Py && Py.available());
      if (W.type === 'py' && !pyOk) { UI.toast('当前包未内置 Python，无法测试'); return }
      const siteUrl = normSite(W.site);
      if (!siteUrl) { UI.toast('站点地址为空'); return }
      setTest(testBox('测试抓取', '<span class="spin"></span> 正在抓取 ' + esc(siteUrl) + ' …'));
      let html;
      try { html = await fetchPage(siteUrl) } catch (e) {
        if (!killed) setTest(testBox('测试失败', '<div class="d1-errtext">' + esc(e.message) + '</div>'));
        return;
      }
      if (killed) return;
      const t0 = Date.now();
      let data = null;
      let err = '';
      if (W.type === 'rule') {
        const out = previewRule(W.rule, html, siteUrl);
        if (out.error) err = out.error;
        else data = { type: 'list', title: '前端预览', cards: out.cards };
      } else if (W.type === 'py') {
        try {
          const chk = await Py.check(W.code);
          if (!chk.ok) err = 'Python 语法错误：' + (chk.error || chk.err || '');
          if (!err) {
            const put = await Py.put(W.id, W.code);
            if (!put.ok) err = '写入脚本失败：' + (put.err || '');
          }
          if (!err) {
            const r = await Py.dispatch(W.id, siteUrl, html);
            if (!r.ok) err = 'parse 执行失败：' + (r.err || '');
            else data = r.data;
          }
        } catch (e) { err = 'Python 执行失败：' + e.message }
      } else {
        let mod = null;
        try { mod = Engine.compile(W.code) } catch (e) { err = '编译失败：' + e.message }
        if (!err) {
          try { data = await mod.parse(siteUrl, html) } catch (e) { err = 'parse 执行失败：' + e.message }
        }
      }
      if (killed) return;
      const ms = Date.now() - t0;
      if (err) {
        setTest(testBox('测试失败', '<div class="d1-errtext">' + esc(err) + '</div>'));
        return;
      }
      const cards = countCards(data);
      const titles = firstCards(data, 3);
      let inner = '<div class="d1-okline">✓ 抓到 ' + cards + ' 条 · 耗时 ' + ms + 'ms</div>';
      if (titles.length) {
        for (let i = 0; i < titles.length; i++) {
          inner += '<div class="d1-test-row"><span class="d1-dim">' + (i + 1) + '.</span> ' +
            esc(titles[i].title || '(无标题)') + '</div>';
        }
      } else {
        inner += '<div class="d1-errtext">没有解析出条目：请检查选择器 / 脚本返回结构。</div>';
      }
      inner += '<div class="d1-note">' + (W.type === 'rule'
        ? '前端预览：浏览器 CSS 选择器解析（最多 100 条），与 App 内规则执行器同源，结果仅供参考。'
        : '真实抓取 + 当前 JS 引擎执行。') + ' 编码按 UTF-8 解码，GBK 站点会乱码。</div>';
      setTest(testBox('测试结果', inner));
    }

    /* ---------- 导入 ---------- */
    function parseListExpr(v) {
      const out = { container: '', item: '', title: '', pic: '', url: '', desc: '' };
      const parts = String(v).split(';');
      const first = String(parts[0] || '').split('&&');
      out.container = String(first[0] || '').trim();
      out.item = String(first[1] || '').trim();
      for (let i = 1; i < parts.length; i++) {
        const p = String(parts[i] || '').split('&&');
        const sel = String(p[0] || '').trim();
        const attr = String(p[1] || '').trim().toLowerCase();
        if (!sel) continue;
        if (attr === 'text') {
          if (!out.title) out.title = sel;
          else if (!out.desc) out.desc = sel;
        } else if (attr === 'src') {
          if (!out.pic) out.pic = sel;
        } else if (attr === 'href') {
          if (!out.url) out.url = sel;
        }
      }
      return out;
    }
    function listOf(v) {
      const out = { container: '', item: '', title: '', pic: '', url: '', desc: '' };
      if (!v) return out;
      if (typeof v === 'string') return parseListExpr(v);
      if (typeof v === 'object') {
        out.container = String(v.container || '');
        out.item = String(v.item || '');
        out.title = String(v.title || '');
        out.pic = String(v.pic || '');
        out.url = String(v.url || '');
        out.desc = String(v.desc || '');
      }
      return out;
    }
    /* 兼容海阔视界规则 JSON：只要有 name/site/list 就映射成 rule */
    function mapRule(o) {
      if (!o || typeof o !== 'object' || Object.prototype.toString.call(o) === '[object Array]') return null;
      if (!o.name || !o.site || !o.list) return null;
      const base = emptyRule();
      const r = {
        name: String(o.name),
        id: String(o.id || ''),
        site: String(o.site),
        icon: String(o.icon || ''),
        group: String(o.group || ''),
        encoding: String(o.encoding || o.charset || 'utf-8'),
        ua: String(o.ua || o.userAgent || ''),
        referer: String(o.referer || '')
      };
      r.list = Object.assign(base.list, listOf(o.list));
      r.detail = Object.assign({}, base.detail);
      const d = o.detail;
      if (d && typeof d === 'object') {
        r.detail.title = String(d.title || d.titleSel || r.detail.title || '');
        r.detail.pic = String(d.pic || '');
        r.detail.playRe = String(d.playRe || d.play || d.playRegex || '');
        r.detail.playFrom = String(d.playFrom || 'html');
      }
      const s = o.search;
      if (s && typeof s === 'object') r.search = { template: String(s.template || s.url || '') };
      else if (typeof s === 'string') r.search = { template: s };
      else r.search = { template: '' };
      const p = o.page;
      if (p && typeof p === 'object') {
        r.page = { param: String(p.param || p.pageParam || 'page'), start: parseInt(p.start, 10) || 1 };
      } else r.page = { param: 'page', start: 1 };
      return r;
    }
    /* 返回 {ok} / {ok:false, error}；成功后由调用方 finishImport */
    function applyImport(text) {
      const raw = String(text == null ? '' : text).trim();
      if (!raw) return { ok: false, error: '内容为空' };
      if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
        let obj;
        try { obj = JSON.parse(raw) } catch (e) { return { ok: false, error: 'JSON 解析失败：' + e.message } }
        const rule = mapRule(obj);
        if (!rule) return { ok: false, error: 'JSON 里没有 name / site / list 字段，不是可识别的硬解规则' };
        W.type = 'rule';
        W.rule = rule;
        W.name = rule.name;
        W.site = rule.site;
        W.icon = rule.icon || '📋';
        W.group = rule.group || '';
        W.enc = /gbk|gb2312|gb18030/i.test(String(rule.encoding || '')) ? 'gbk' : 'utf-8';
        W.uaPreset = rule.ua ? '自定义' : '默认（跟随全局）';
        W.uaCustom = rule.ua || '';
        W.referer = rule.referer || '';
        W.id = makeId(rule.id || rule.name);
        W.idManual = false;
        return { ok: true };
      }
      if (/def\s+parse\s*\(/.test(raw) || /^\s*NAME\s*=/m.test(raw)) {
        W.type = 'py';
        W.code = raw;
        const nm = raw.match(/^\s*NAME\s*=\s*['"]([^'"]*)['"]/m);
        const sm = raw.match(/^\s*SITE\s*=\s*['"]([^'"]*)['"]/m);
        W.name = nm ? nm[1] : '导入的 Python 脚本';
        W.site = sm ? sm[1] : '';
        W.icon = '🐍';
        W.id = makeId(W.name);
        W.idManual = false;
        return { ok: true };
      }
      if (/export\s+default|function\s+parse\s*\(|parse\s*[:=]\s*(async\s+)?function|parse\s*\(\s*url/.test(raw)) {
        W.type = 'js';
        W.code = raw;
        const nm = raw.match(/name\s*:\s*['"]([^'"]+)['"]/);
        const sm = raw.match(/(?:site|SITE)\s*[:=]\s*['"]([^'"]+)['"]/);
        W.name = nm ? nm[1] : '导入的 JS 脚本';
        W.site = sm ? sm[1] : '';
        W.icon = '📜';
        W.id = makeId(W.name);
        W.idManual = false;
        return { ok: true };
      }
      return { ok: false, error: '无法识别脚本格式：既不是规则 JSON，也不是 js / py 脚本' };
    }
    function finishImport() {
      W.step = 2;
      W.result = null;
      UI.closeSheet();
      render();
      UI.toast('已导入，请检查');
    }

    function openImportSheet() {
      UI.sheet(
        '<div class="d1-pad"><div class="d1-sheet-h">导入现成脚本</div>' +
        '<div class="d1-note">支持 URL 原文、剪贴板、文本文件、内置示例；兼容海阔视界规则 JSON（含 name/site/list 时转成硬解规则）。</div>' +
        '<div class="rows">' +
        '<div class="row tap" data-src="url"><div class="t"><div class="nm">从 URL 读取</div><div class="ds">脚本原文或规则 JSON 地址</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-src="clip"><div class="t"><div class="nm">从剪贴板粘贴</div><div class="ds">读取失败时可手动粘贴</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-src="file"><div class="t"><div class="nm">从文件选择</div><div class="ds">.json / .js / .py / .txt（UTF-8 / GBK）</div></div><div class="arw">›</div></div>' +
        '<div class="row tap" data-src="demo"><div class="t"><div class="nm">内置示例</div><div class="ds">demo_site（示例站点 JS 脚本）</div></div><div class="arw">›</div></div>' +
        '</div></div>',
        {
          onOpen: function (pb) {
            $$('[data-src]', pb).forEach(function (el) {
              el.onclick = function () {
                const s = el.dataset.src;
                if (s === 'url') openImportUrl();
                else if (s === 'clip') importFromClipboard();
                else if (s === 'file') openImportFile();
                else importDemo();
              };
            });
          }
        });
    }

    function openImportUrl() {
      UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">从 URL 导入</div>' +
        '<input class="input" id="impUrl" placeholder="https://…/rule.json" spellcheck="false" autocapitalize="off" autocomplete="off">' +
        '<div class="d1-hint" id="impErr" style="display:none"></div>' +
        '<div class="d1-sheet-acts"><button class="btn ghost" data-c>取消</button><button class="btn pri" data-ok>读取</button></div></div>',
        {
          onOpen: function (pb) {
            const input = $('#impUrl', pb);
            const err = $('#impErr', pb);
            const ok = $('[data-ok]', pb);
            $('[data-c]', pb).onclick = function () { UI.closeSheet() };
            ok.onclick = async function () {
              const u = String(input.value || '').trim();
              if (!u) { err.textContent = '请填写 URL'; err.style.display = 'block'; return }
              err.style.display = 'none';
              ok.disabled = true;
              ok.textContent = '读取中…';
              let txt;
              try {
                txt = await Net.get(u, { headers: wizHeaders() });
              } catch (e) {
                ok.disabled = false;
                ok.textContent = '读取';
                err.textContent = '抓取失败：' + (e.message || e) + '（无 Java 桥时浏览器受跨域限制）';
                err.style.display = 'block';
                return;
              }
              ok.disabled = false;
              ok.textContent = '读取';
              if (!String(txt || '').trim()) {
                err.textContent = '返回内容为空';
                err.style.display = 'block';
                return;
              }
              const r = applyImport(txt);
              if (!r.ok) {
                err.textContent = r.error;
                err.style.display = 'block';
                return;
              }
              finishImport();
            };
          }
        });
    }

    function importFromClipboard() {
      let pending = false;
      const done = function (txt) {
        const r = applyImport(txt);
        if (r.ok) { finishImport(); return true }
        openPasteSheet('剪贴板内容无法识别：' + r.error + '。可修改后再导入。', txt);
        return false;
      };
      if (navigator.clipboard && navigator.clipboard.readText) {
        pending = true;
        try {
          navigator.clipboard.readText().then(function (txt) {
            pending = false;
            if (String(txt || '').trim()) { done(txt); return }
            openPasteSheet('剪贴板为空，请手动粘贴脚本内容。', '');
          }, function () {
            pending = false;
            openPasteSheet('当前 WebView 不允许直接读取剪贴板，请手动粘贴脚本内容。', '');
          });
        } catch (e) {
          pending = false;
        }
      }
      if (!pending) openPasteSheet('当前 WebView 没有剪贴板读取能力，请手动粘贴脚本内容。', '');
    }

    function openPasteSheet(note, initial) {
      UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">粘贴脚本内容</div>' +
        '<div class="d1-note">' + esc(note) + '</div>' +
        '<textarea class="input d1-copybox" id="impText" placeholder="在这里粘贴规则 JSON / js / py 源码…" spellcheck="false">' + esc(initial || '') + '</textarea>' +
        '<div class="d1-hint" id="impErr" style="display:none"></div>' +
        '<div class="d1-sheet-acts"><button class="btn ghost" data-c>取消</button><button class="btn pri" data-ok>导入</button></div></div>',
        {
          onOpen: function (pb) {
            const ta = $('#impText', pb);
            const err = $('#impErr', pb);
            $('[data-c]', pb).onclick = function () { UI.closeSheet() };
            $('[data-ok]', pb).onclick = function () {
              const r = applyImport(ta.value);
              if (!r.ok) { err.textContent = r.error; err.style.display = 'block'; return }
              finishImport();
            };
          }
        });
    }

    function readFileText(file) {
      return new Promise(function (resolve, reject) {
        const fr = new FileReader();
        fr.onerror = function () { reject(new Error('读取文件失败')) };
        fr.onload = function () {
          const buf = fr.result;
          let text = '';
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
          } catch (e) {
            try { text = new TextDecoder('gbk').decode(buf) } catch (e2) {
              reject(new Error('文件编码无法识别（支持 UTF-8 / GBK）'));
              return;
            }
          }
          resolve(text);
        };
        fr.readAsArrayBuffer(file);
      });
    }

    function openImportFile() {
      UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">从文件导入</div>' +
        '<div class="d1-note">选择 .json / .js / .py / .txt 文件。UTF-8 优先，失败时按 GBK 解码。</div>' +
        '<input type="file" id="impFile" accept=".json,.js,.py,.txt,application/json,text/plain" class="d1-file">' +
        '<div class="d1-hint" id="impErr" style="display:none"></div>' +
        '<div class="d1-sheet-acts"><button class="btn ghost" data-c>取消</button></div></div>',
        {
          onOpen: function (pb) {
            const input = $('#impFile', pb);
            const err = $('#impErr', pb);
            $('[data-c]', pb).onclick = function () { UI.closeSheet() };
            input.onchange = async function () {
              const f = input.files && input.files[0];
              if (!f) return;
              let text;
              try { text = await readFileText(f) } catch (e) {
                err.textContent = e.message;
                err.style.display = 'block';
                return;
              }
              const r = applyImport(text);
              if (!r.ok) { err.textContent = r.error; err.style.display = 'block'; return }
              finishImport();
            };
          }
        });
    }

    function importDemo() {
      const src = Engine.builtin.demo_site || '';
      if (!src) { UI.toast('内置示例不可用'); return }
      W.type = 'js';
      W.code = src;
      W.name = '示例站点';
      W.site = 'https://example.com';
      W.icon = '🔥';
      W.group = '影视';
      W.id = makeId('demo_site');
      W.idManual = false;
      W.step = 2;
      UI.closeSheet();
      render();
      UI.toast('已载入示例');
    }

    /* ---------- 保存并启用 ---------- */
    function saveNew() {
      const name = String(W.name || '').trim();
      const siteUrl = normSite(W.site);
      if (!name) {
        W.step = 2; render(); UI.toast('名称必填');
        return;
      }
      if (!siteUrl) {
        W.step = 2; render(); UI.toast('站点地址需 http(s)');
        return;
      }
      if (!W.id) W.id = makeId(name);
      const ie = idError(W.id);
      if (ie) {
        W.step = 2; render(); UI.toast('ID 需修改');
        return;
      }
      let script = '';
      if (W.type === 'rule') {
        const r = JSON.parse(JSON.stringify(W.rule));
        r.name = name;
        r.id = W.id;
        r.site = siteUrl;
        r.icon = W.icon || '';
        r.group = String(W.group || '').trim();
        r.encoding = W.enc;
        r.page = r.page || {};
        r.page.start = parseInt(r.page.start, 10) || 1;
        const ua0 = uaOfPreset(W.uaPreset, W.uaCustom);
        if (ua0) r.ua = ua0;
        const ref0 = String(W.referer || '').trim();
        if (ref0) r.referer = ref0;
        script = JSON.stringify(r, null, 2);
      } else if (W.type === 'py') {
        script = W.code || Engine.template('py');
      } else {
        script = W.code || Engine.template('js');
        try {
          Engine.compile(script);
        } catch (e) {
          W.step = 3;
          render();
          setTest(testBox('保存失败', '<div class="d1-errtext">' + esc(e.message) + '</div>'));
          UI.toast('脚本有语法错误');
          return;
        }
      }
      const rec = {
        id: W.id,
        name: name,
        site: siteUrl,
        icon: W.icon || '🌐',
        group: String(W.group || '').trim(),
        type: W.type,
        enabled: true,
        script: script,
        encoding: W.enc
      };
      const ua = uaOfPreset(W.uaPreset, W.uaCustom);
      if (ua) rec.ua = ua;
      const ref = String(W.referer || '').trim();
      if (ref) rec.referer = ref;
      try { DB.saveSite(rec) } catch (e) { UI.toast('保存失败'); return }
      Engine.invalidate(W.id);
      App.siteId = W.id;
      DB._set('lastSite', W.id);
      UI.toast('已添加站点');
      const from = App.tab;
      if (from === 'home') {
        App.home();
      } else {
        App.stacks[from] = [];
        App.setTab('home');
      }
    }

    const st = curStack();
    if (st) st.cleanup = function () { killed = true };

    render();
    if (params && params.import) setTimeout(function () { if (!killed) openImportSheet() }, 60);
    return Promise.resolve();
  };
})();
