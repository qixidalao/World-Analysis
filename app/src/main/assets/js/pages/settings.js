/* settings.js — P-10 设置根 + P-11~P-17 设置子页 + P-18 日志
   约定见 docs/dev-frontend-conventions.md §2/§3/§7、docs/06 §6.2、docs/07 P-10~P-18。
   所有配置走 DB.setCfg（内部已调 UI.applyTheme + Net.config），只读调用既有 API。
   「如实标注」原则：Python / 真 shell / 代理认证 / 站点级网络覆盖 / 后台播放 /
   签名指纹 等当前 APK 做不到的能力，一律标注未接入或仅记录，绝不伪造成功。 */
(function () {
  'use strict';

  /* ================= 常量 ================= */
  var NET_MODES = [['direct', '直连'], ['doh', 'DoH'], ['proxy', '代理'], ['both', 'DoH+代理']];
  var NET_MODE_NAME = { direct: '直连', doh: 'DoH', proxy: '代理', both: 'DoH+代理' };
  var DOH_PRESETS = [
    ['ali', '阿里', 'https://223.5.5.5/resolve'],
    ['tencent', '腾讯', 'https://1.12.12.12/resolve'],
    ['cf', 'Cloudflare', 'https://1.1.1.1/dns-query'],
    ['custom', '自定义', '']
  ];
  var ACCENTS = ['#FF5A3C', '#4DABF7', '#51CF66', '#FCC419', '#B197FC', '#FF6B9D'];
  var DECODERS = [['auto', '自动'], ['hw', '硬解'], ['sw', '软解']];
  var RATIOS = [['fit', '适应'], ['fill', '填充'], ['crop', '裁切']];
  var VERSION = 'v' + ((window.App && App.info && App.info.version) || '0.0.0');
  /* 存储五类（其它 = 配置/收藏/历史/进度，单列灰色不占五色） */
  var CATS = [
    ['img', '图片', 'var(--info)'],
    ['video', '视频', 'var(--ok)'],
    ['page', '页面', 'var(--warn)'],
    ['pkg', '包', 'var(--accent)'],
    ['log', '日志', 'var(--err)'],
    ['other', '其它', 'var(--surface2)']
  ];

  /* ================= 通用小工具 ================= */
  function firstLine(e) {
    var s = (e && (e.message || e)) ? String(e.message || e) : '未知错误';
    return s.split('\n')[0];
  }

  function guard(name, fn) {
    return function (root, params, st) {
      try { return fn(root, params, st) }
      catch (e) {
        Log.err(name + ': ' + firstLine(e));
        root.innerHTML = UI.stateHTML('error', { msg: firstLine(e), retry: function () { App.refresh() } });
        var b = $('[data-act=retry]', root);
        if (b) b.onclick = function () { App.refresh() };
      }
    };
  }

  function goFirst(names, toastMsg) {
    for (var i = 0; i < names.length; i++) {
      if (App.pages[names[i]]) { App.go(names[i]); return true }
    }
    if (toastMsg) UI.toast(toastMsg);
    return false;
  }

  function mq(q) {
    try { return !!(window.matchMedia && window.matchMedia(q).matches) } catch (e) { return false }
  }

  /* ================= 设置行 / 分段 / 滑块 ================= */
  /* 字段块：标题 + 右侧当前值 + 说明 + 控件 */
  function fieldHTML(o) {
    var val = o.value == null ? '' : String(o.value);
    return '<div class="st-field">' +
      '<div class="st-fh"><span class="nm">' + esc(o.title) + '</span>' +
      '<span class="v"' + (o.valAct ? ' data-val="' + esc(o.valAct) + '"' : '') + '>' + esc(val) + '</span></div>' +
      (o.desc ? '<div class="st-fd">' + esc(o.desc) + '</div>' : '') +
      (o.control || '') +
      '</div>';
  }

  /* 分段控件（C-16） */
  function segHTML(o) {
    var cur = String(o.cur);
    return '<div class="seg st-seg" data-seg="' + esc(o.act) + '">' + (o.items || []).map(function (it) {
      return '<b data-v="' + esc(it.v) + '"' + (String(it.v) === cur ? ' class="on"' : '') + '>' + esc(it.label) + '</b>';
    }).join('') + '</div>';
  }

  function bindSegs(scope, onPick) {
    $$('[data-seg]', scope).forEach(function (seg) {
      var act = seg.dataset.seg;
      $$('b', seg).forEach(function (b) {
        b.onclick = function () {
          $$('b', seg).forEach(function (x) { x.classList.remove('on') });
          b.classList.add('on');
          if (onPick) onPick(act, b.dataset.v);
        };
      });
    });
  }

  function setVal(scope, act, text) {
    var el = $('[data-val="' + act + '"]', scope);
    if (el) el.textContent = String(text == null ? '' : text);
  }

  /* 滑块行（C-15） */
  function sliderHTML(o) {
    return '<div class="st-field">' +
      '<div class="st-fh"><span class="nm">' + esc(o.title) + '</span>' +
      '<span class="v" data-out="' + esc(o.act) + '">' + esc(o.text) + '</span></div>' +
      (o.desc ? '<div class="st-fd">' + esc(o.desc) + '</div>' : '') +
      '<input type="range" class="slider" data-range="' + esc(o.act) + '" min="' + o.min + '" max="' + o.max +
      '" step="' + o.step + '" value="' + o.val + '">' +
      '</div>';
  }

  function bindRanges(scope, onChange, fmt) {
    $$('[data-range]', scope).forEach(function (inp) {
      var act = inp.dataset.range;
      var out = $('[data-out="' + act + '"]', scope);
      var upd = function () { if (out) out.textContent = fmt(act, +inp.value) };
      inp.oninput = upd;
      inp.onchange = function () { upd(); if (onChange) onChange(act, +inp.value) };
    });
  }

  /* 开关行（C-14）：整行可点，避免 switch 冒泡重复触发 */
  function bindSwitch(scope, act, onToggle) {
    var row = $('[data-act="' + act + '"]', scope);
    if (!row) return;
    row.onclick = function () {
      var sw = $('.switch', row);
      if (!sw) return;
      var on = !sw.classList.contains('on');
      sw.classList.toggle('on', on);
      if (onToggle) onToggle(on);
    };
  }

  /* ================= 本地存储统计 ================= */
  function byteLen(s) {
    try { return new Blob([String(s)]).size } catch (e) { return String(s).length }
  }

  function lsEntries() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(DB.NS) !== 0) continue;
        var v = localStorage.getItem(k) || '';
        out.push({ key: k.slice(DB.NS.length), bytes: byteLen(v) });
      }
    } catch (e) { Log.err('读取存储失败：' + firstLine(e)) }
    return out;
  }

  function catOf(k) {
    if (k === 'logs') return 'log';
    if (k === 'installed' || k.indexOf('pkg.') === 0) return 'pkg';
    if (k.indexOf('img.') === 0 || k.indexOf('image.') === 0) return 'img';
    if (k.indexOf('video.') === 0 || k.indexOf('media.') === 0) return 'video';
    if (k.indexOf('cache.') === 0) {
      if (/\.(img|pic|cover)$/.test(k)) return 'img';
      if (/\.(video|seg|ts|m3u8)$/.test(k)) return 'video';
      return 'page';
    }
    return 'other';
  }

  function storageTotals() {
    var es = lsEntries();
    var t = { img: 0, video: 0, page: 0, pkg: 0, log: 0, other: 0, total: 0, keys: es.length };
    es.forEach(function (e) {
      var c = catOf(e.key);
      t[c] = (t[c] || 0) + e.bytes;
      t.total += e.bytes;
    });
    return t;
  }

  function clearCats(cats) {
    var freed = 0, n = 0;
    lsEntries().forEach(function (e) {
      if (cats.indexOf(catOf(e.key)) < 0) return;
      try { localStorage.removeItem(DB.NS + e.key); freed += e.bytes; n++ } catch (err) { }
    });
    return { freed: freed, n: n };
  }

  /* ================= 复制 / 日志合并 ================= */
  function showCopySheet(text) {
    UI.sheet('<div class="st-grp">复制失败 · 请长按选择全文</div>' +
      '<div class="st-field"><textarea class="input st-copyarea" readonly>' + esc(text) + '</textarea></div>', {
      onOpen: function (pb) {
        var t = $('textarea', pb);
        if (t) { try { t.focus(); t.select() } catch (e) { } }
      }
    });
  }

  function copyText(txt, okMsg) {
    var text = String(txt == null ? '' : txt);
    var ok = function () { UI.toast(okMsg || '已复制') };
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
      showCopySheet(text);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, fallback);
    } else fallback();
  }

  function logsMerged() {
    var mem = [];
    try { mem = Log.all() || [] } catch (e) { }
    var disk = [];
    try { disk = DB.logs() || [] } catch (e) { }
    var seen = {}, out = [];
    mem.concat(disk).forEach(function (r) {
      if (!r || !r.t) return;
      var k = r.t + '|' + (r.lv || '') + '|' + r.msg;
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ t: +r.t, lv: r.lv || 'info', msg: String(r.msg == null ? '' : r.msg) });
    });
    out.sort(function (a, b) { return a.t - b.t });
    return out;
  }

  function logsText() {
    return logsMerged().map(function (r) {
      return '[' + hhmmss(r.t) + '] [' + r.lv + '] ' + r.msg;
    }).join('\n');
  }

  function hhmmss(ts) {
    var d = new Date(ts || 0);
    var p = function (n) { return String(n).padStart(2, '0') };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ================= 主题/外观即时应用（补 UI.applyTheme 的 auto 分支） ================= */
  function applyUIExtra() {
    UI.applyTheme();
    var c = DB.cfg();
    var el = document.documentElement;
    /* 主题「跟随系统」：tokens.css 只认 data-theme=light|dark */
    if (c.theme === 'auto') el.setAttribute('data-theme', mq('(prefers-color-scheme: light)') ? 'light' : 'dark');
    /* 动效「跟随系统」：读系统「减少动画」 */
    if (c.motion === 'auto') el.setAttribute('data-motion', mq('(prefers-reduced-motion: reduce)') ? 'off' : 'on');
    /* 圆角：tokens 默认 8/12/16，随设置整体收放 */
    var r = parseInt(c.radius, 10) || 12;
    el.style.setProperty('--r-s', Math.max(4, r - 4) + 'px');
    el.style.setProperty('--r-m', r + 'px');
    el.style.setProperty('--r-l', r + 4 + 'px');
    /* 字号缩放：写 --font-scale（tokens 的字号是固定 px，视觉生效需全局改造） */
    el.style.setProperty('--font-scale', String((parseInt(c.fontScale, 10) || 100) / 100));
  }

  /* 系统主题/动效变化时，只对 auto 的项即时响应 */
  (function watchMedia() {
    if (!window.matchMedia) return;
    var bind = function (q) {
      try {
        var m = window.matchMedia(q);
        var fn = function () {
          var c = DB.cfg();
          if (c.theme === 'auto' || c.motion === 'auto') applyUIExtra();
        };
        if (m.addEventListener) m.addEventListener('change', fn);
        else if (m.addListener) m.addListener(fn);
      } catch (e) { }
    };
    bind('(prefers-color-scheme: light)');
    bind('(prefers-reduced-motion: reduce)');
  })();

  /* ================= 长按手势 ================= */
  function longPress(scope, sel, fn) {
    var timer = null, sx = 0, sy = 0;
    var cancel = function () { clearTimeout(timer); timer = null };
    scope.addEventListener('pointerdown', function (e) {
      var el = e.target && e.target.closest ? e.target.closest(sel) : null;
      if (!el) return;
      sx = e.clientX; sy = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(function () { timer = null; fn(el) }, 550);
    });
    scope.addEventListener('pointerup', cancel);
    scope.addEventListener('pointercancel', cancel);
    scope.addEventListener('pointermove', function (e) {
      if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel();
    });
  }

  /* ================= P-10 设置根 ================= */
  function renderSettings(root) {
    var c = DB.cfg();
    var sites = DB.sites();
    var pyOk = !!(window.Py && Py.available());
    var pyVer = pyOk ? Py.versionText() : '未接入';
    var t = storageTotals();
    var decName = ({ auto: '自动', hw: '硬解', sw: '软解' })[c.play.decoder] || '自动';
    var themeName = c.theme === 'light' ? '浅色' : (c.theme === 'auto' ? '跟随系统' : '深色');

    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '设置' }));
    var body = document.createElement('div');
    body.innerHTML = [
      '<div class="st-grp">偏好</div>',
      '<div class="rows">',
      UI.row({ title: '站点与脚本', desc: '站点列表 · 默认站点 · 频道自定义', right: sites.length + ' 个站点', arrow: true, act: 'site' }),
      UI.row({ title: '网络', desc: '连接方式 · DoH · 代理 · 请求参数', right: NET_MODE_NAME[c.net.mode] || '直连', arrow: true, act: 'net' }),
      UI.row({ title: '浏览缓存', desc: '主页内容缓存时长，减少请求与风控', right: (Number(c.browseCache) > 0 ? c.browseCache + ' 分钟' : '不缓存'), arrow: true, act: 'cachettl' }),
      UI.row({ title: '播放', desc: '解码器 · 分片缓存 · 手势', right: decName + ' · ' + (c.play.cache || 128) + 'MB', arrow: true, act: 'play' }),
      UI.row({ title: '外观', desc: '主题 · 强调色 · 布局 · 字号', right: themeName + ' · ' + (c.gridCols || 2) + '列', arrow: true, act: 'ui' }),
      UI.row({ title: '主页布局', desc: '模块顺序 · 欢迎语 · 自定义区块', right: '编辑', arrow: true, act: 'homelayout' }),
      '</div>',
      '<div class="st-grp">运行时</div>',
      '<div class="rows">',
      UI.row({ title: 'Python', desc: '解释器 · 模块 · sys.path', right: pyOk ? pyVer : '未接入 · shell/JS 可用', arrow: true, act: 'py' }),
      UI.row({ title: '扩展包', desc: '语法 · 组件 · 主题 · 解析器', right: (window.Packs ? Packs.list().filter(function (x) { return x.enabled; }).length : 0) + ' 个启用', arrow: true, act: 'packs' }),
      UI.row({ title: '存储', desc: '占用 · 清理 · 导出', right: fmtSize(t.total), arrow: true, act: 'storage' }),
      UI.row({ title: '关于', desc: '版本 · 引擎 · 开源许可', right: VERSION, arrow: true, act: 'about' }),
      '</div>',
      '<div class="st-note">' + (pyOk ? 'CPython ' + pyVer + ' 已内置，可执行/检查/测试 Python 脚本。' : '当前 APK 未打包 Chaquopy，<b>没有 Python 运行时</b>；终端仍有 shell，Python 脚本不可执行。') +
      '设置改动即时保存并生效，无需重启。</div>'
    ].join('');
    root.appendChild(body);

    var map = {
      site: 'settings.site', net: 'settings.net', play: 'settings.play',
      ui: 'settings.ui', py: 'settings.py', packs: 'settings.packs', storage: 'settings.storage', about: 'settings.about'
    };
    Object.keys(map).forEach(function (act) {
      var el = $('[data-act="' + act + '"]', body);
      if (el) el.onclick = function () { App.go(map[act]) };
    });

    var hl = $('[data-act="homelayout"]', body);
    if (hl) hl.onclick = function () { var h = App.tabs['home']; if (h && h.openCustomize) h.openCustomize(); };

    var ct = $('[data-act="cachettl"]', body);
    if (ct) ct.onclick = function () { openCacheTtl(); };

    function openCacheTtl() {
      var cur = Number(DB.cfg().browseCache);
      var opts = [[5, '5 分钟'], [15, '15 分钟'], [30, '30 分钟'], [60, '1 小时'], [120, '2 小时'], [0, '不缓存']];
      UI.sheet('<div class="sheet-hd">浏览缓存</div>' +
        '<div class="d1-note" style="padding:0 14px 8px">主页内容在该时间内直接读缓存，不再发请求；强制下拉刷新仍会联网。</div>' +
        '<div class="rows">' + opts.map(function (o) {
          return '<div class="row tap" data-ttl="' + o[0] + '"><div class="t"><div class="nm">' + o[1] + '</div>' +
            '<div class="ds">' + (o[0] === 0 ? '每次进入都重新请求' : '缓存 ' + o[0] + ' 分钟') + '</div></div>' +
            '<div class="arw">' + (cur === o[0] ? '✓' : '') + '</div></div>';
        }).join('') + '</div>' +
        '<div class="d1-pad"><div class="d1-note">自定义分钟数（0–1440）</div>' +
        '<input class="input" type="number" min="0" max="1440" data-ttl-custom value="' + cur + '">' +
        '<div class="d1-steprow"><button class="btn ghost" data-c>取消</button><button class="btn pri" data-ok>保存</button></div></div>',
        {
          onOpen: function (pb) {
            $$('[data-ttl]', pb).forEach(function (el) {
              el.onclick = function () {
                DB.setCfg({ browseCache: Number(el.dataset.ttl) });
                UI.closeSheet(); UI.toast('已设置'); App.renderTab();
              };
            });
            $('[data-c]', pb).onclick = function () { UI.closeSheet() };
            var pf = $('[data-pack-fetch]', pb);
            if (pf) pf.onclick = function () {
              var u = String($('[data-pack-url]', pb).value || '').trim();
              if (!/^https?:\/\//i.test(u)) { UI.toast('请输入 http(s) URL'); return }
              UI.toast('正在拉取…');
              Promise.resolve(Net.request('GET', u)).then(function (r) {
                if (!r || (r.status && r.status >= 400)) { UI.toast('拉取失败'); return; }
                var txt = r.txt || r.text || '';
                $('[data-pack-json]', pb).value = txt;
                UI.toast('已拉取，确认后点安装');
              }, function (e) { UI.toast('拉取失败：' + (e.message || e)); });
            };
            $('[data-ok]', pb).onclick = function () {
              var v = Number($('[data-ttl-custom]', pb).value);
              if (!isFinite(v) || v < 0 || v > 1440) { UI.toast('请输入 0–1440'); return }
              DB.setCfg({ browseCache: Math.floor(v) });
              UI.closeSheet(); UI.toast('已设置'); App.renderTab();
            };
          }
        });
    }
  }

  /* ================= P-11 站点与脚本 ================= */
  function normTabs(site) {
    var raw = site && site.tabs ? site.tabs : [];
    var out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (t) {
      if (!t) return;
      if (Array.isArray(t)) out.push({ title: String(t[0] == null ? '' : t[0]), url: String(t[1] == null ? '' : t[1]) });
      else if (typeof t === 'object') out.push({ title: String(t.title == null ? '' : t.title), url: String(t.url == null ? '' : t.url) });
      else out.push({ title: String(t), url: '' });
    });
    return out;
  }

  function saveTabs(id, tabs) {
    DB.saveSite({ id: id, tabs: tabs.map(function (t) { return [t.title, t.url] }) });
    Log.info('站点频道更新 ' + id + ' · ' + tabs.length + ' 个');
  }

  function openTabs(siteId) {
    var site = DB.site(siteId);
    if (!site) return;
    var tabs = normTabs(site);
    UI.sheet(
      '<div class="st-grp">频道自定义 · ' + esc(site.name || site.id) + '</div>' +
      (tabs.length ? tabs.map(function (t, i) {
        return '<div class="row"><div class="t"><div class="nm">' + esc(t.title || '未命名') + '</div>' +
          '<div class="ds mono">' + esc(t.url || '无链接') + '</div></div>' +
          '<b class="st-del" data-del="' + i + '">删除</b></div>';
      }).join('') : '<div class="st-note">该站点还没有自定义频道。</div>') +
      '<div class="st-grp">新增频道</div>' +
      '<div class="st-field">' +
      '<input class="input st-input" data-f="name" placeholder="频道名称（如：推荐）">' +
      '<input class="input st-input" data-f="url" placeholder="链接（如：https://example.com/home）">' +
      '</div>' +
      '<div class="st-btnwrap"><button class="btn pri" data-add>添加频道</button></div>' +
      '<div class="st-note">写入 <span class="mono">DB.site(id).tabs</span>（site.tabs）。' +
      '浏览页当前仍使用脚本解析出的频道，自定义频道待 M2 接入后才影响浏览页。</div>', {
      onOpen: function (pb) {
        $$('[data-del]', pb).forEach(function (b) {
          b.onclick = function () {
            var i = +b.dataset.del;
            tabs.splice(i, 1);
            saveTabs(siteId, tabs);
            UI.closeSheet();
            openTabs(siteId);
            UI.toast('已删频道');
          };
        });
        var add = $('[data-add]', pb);
        if (add) add.onclick = function () {
          var name = ($('[data-f=name]', pb).value || '').trim();
          var url = ($('[data-f=url]', pb).value || '').trim();
          if (!name) return UI.toast('请填频道名');
          tabs.push({ title: name, url: url });
          saveTabs(siteId, tabs);
          UI.closeSheet();
          openTabs(siteId);
          UI.toast('已添加频道');
        };
      }
    });
  }

  function siteCacheEntries(id) {
    var pre = 'cache.' + id + '.';
    return lsEntries().filter(function (e) { return e.key.indexOf(pre) === 0 });
  }

  function clearSiteCache(s) {
    var es = siteCacheEntries(s.id);
    var bytes = 0;
    es.forEach(function (e) { bytes += e.bytes });
    UI.dialog({
      title: '清理站点缓存',
      msg: '将清空「' + (s.name || s.id) + '」的页面缓存' +
        (es.length ? '（' + es.length + ' 项 · ' + fmtSize(bytes) + '）' : '（当前没有缓存）') +
        '，不影响脚本、收藏与历史。',
      okText: '清理', cancelText: '取消', danger: true,
      onOk: function () {
        es.forEach(function (e) { try { localStorage.removeItem(DB.NS + e.key) } catch (err) { } });
        Log.ok('清理站点缓存 ' + s.id + ' · ' + fmtSize(bytes));
        UI.toast('已清缓存');
      }
    });
  }

  function onSiteOp(id, op) {
    var list = DB.sites();
    var i = list.findIndex(function (x) { return x.id === id });
    if (i < 0) return;
    var s = list[i];
    if (op === 'up' || op === 'down') {
      var j = i + (op === 'up' ? -1 : 1);
      if (j < 0 || j >= list.length) return UI.toast('已到边界');
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
      DB._set('sites', list);
      App.afterSiteChange('reorder');
      Log.info('站点排序 ' + id + ' ' + op);
      App.refresh();
      return;
    }
    if (op === 'def') {
      DB._set('defaultSite', id);
      App.afterSiteChange('default', id);
      Log.info('默认站点改为 ' + id);
      UI.toast('已设为默认');
      App.refresh();
      return;
    }
    if (op === 'tabs') return openTabs(id);
    if (op === 'cache') return clearSiteCache(s);
    if (op === 'detail') {
      if (!App.pages['scriptDetail']) return UI.toast('脚本详情页未注册');
      return App.go('scriptDetail', { id: id });
    }
  }

  function renderSettingsSite(root) {
    var sites = DB.sites();
    var defId = DB._get('defaultSite', null) || DB._get('lastSite', null) || App.siteId || (sites[0] ? sites[0].id : null);

    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '站点与脚本' }));
    var body = document.createElement('div');
    var h = '';

    if (!sites.length) {
      h += UI.stateHTML('empty', { msg: '还没有站点脚本，先建一个才能浏览', btn: '去新建脚本' });
    } else {
      h += '<div class="st-grp">站点列表 · 排序即主页顺序</div>';
      h += sites.map(function (s, i) {
        var lines = String(s.script || '').split('\n').length;
        var n = s.net || null;
        var netTxt = n ? [NET_MODE_NAME[n.mode] || '', n.proxy || '', n.doh || ''].filter(Boolean).join(' · ') : '';
        return '<div class="st-site" data-id="' + esc(s.id) + '">' +
          '<div class="st-site-h">' +
          '<div class="ic">' + esc(s.icon || '🌐') + '</div>' +
          '<div class="t"><div class="nm">' + esc(s.name || s.id) +
          (s.enabled === false ? ' <span class="dim">（停用）</span>' : '') +
          (s.id === defId ? ' <span class="tag">默认</span>' : '') + '</div>' +
          '<div class="ds">' + esc(String(s.site || '').replace(/^https?:\/\//, '') || '无域名') +
          ' · ' + esc(s.type || 'js') + ' · ' + lines + ' 行' +
          (netTxt ? ' · 网络 ' + esc(netTxt) : '') + '</div></div>' +
          '<div class="switch' + (s.enabled === false ? '' : ' on') + '"></div>' +
          '</div>' +
          '<div class="st-ops">' +
          '<b data-op="up"' + (i === 0 ? ' class="off"' : '') + '>↑ 上移</b>' +
          '<b data-op="down"' + (i === sites.length - 1 ? ' class="off"' : '') + '>↓ 下移</b>' +
          '<b data-op="def"' + (s.id === defId ? ' class="on"' : '') + '>' + (s.id === defId ? '● 默认' : '○ 设为默认') + '</b>' +
          '<b data-op="tabs">频道 ' + normTabs(s).length + '</b>' +
          '<b data-op="cache">清缓存</b>' +
          '<b data-op="detail">详情</b>' +
          '</div></div>';
      }).join('');
    }

    h += '<div class="rows">' +
      UI.row({ title: '脚本管理', desc: '编辑 / 导入 / 删除脚本', right: '', arrow: true, act: 'scripts' }) +
      UI.row({ title: '新建站点', desc: '三步向导：类型 → 信息 → 规则', right: '', arrow: true, act: 'newscript' }) +
      '</div>' +
      '<div class="st-note">排序决定主页「我的站点」的先后；停用后该站点不出现在浏览与切换列表。' +
      '「频道自定义」写入 site.tabs，浏览页当前仍用脚本解析出的频道（待接入）。' +
      '站点级 UA / Referer / Cookie / 代理覆盖在「详情」（脚本详情）里编辑。</div>';

    body.innerHTML = h;
    root.appendChild(body);

    if (!sites.length) {
      var b = $('[data-act=retry]', body);
      if (b) b.onclick = function () { goFirst(['newscript', 'scripts'], '新建脚本页未注册') };
      return;
    }

    $$('.st-site', body).forEach(function (card) {
      var id = card.dataset.id;
      var sw = $('.switch', card);
      if (sw) sw.onclick = function (ev) {
        if (ev) ev.stopPropagation();
        App.siteToggle(id);
        var s = DB.site(id);
        var on = !!(s && s.enabled !== false);
        sw.classList.toggle('on', on);
        Log.info('站点 ' + id + (on ? ' 启用' : ' 停用'));
        UI.toast(on ? '已启用' : '已停用');
      };
      $$('[data-op]', card).forEach(function (b2) {
        b2.onclick = function () { onSiteOp(id, b2.dataset.op) };
      });
    });

    var nav = $('[data-act=scripts]', body);
    if (nav) nav.onclick = function () { goFirst(['scripts'], '脚本列表页未注册') };
    var nav2 = $('[data-act=newscript]', body);
    if (nav2) nav2.onclick = function () { goFirst(['newscript', 'scripts'], '新建脚本页未注册') };
  }

  /* ================= P-12 网络 ================= */
  function saveNet(patch) {
    DB.setCfg({ net: patch });
    Net.config(DB.netCfg());
    Log.info('网络配置 ' + JSON.stringify(patch));
  }
  function saveDoh(v) {
    saveNet({ doh: v });
  }

  function setRes(el, cls, txt) {
    if (!el) return;
    el.className = 'st-testres' + (cls ? ' ' + cls : '');
    el.textContent = txt || '';
  }

  async function testDoh(btn, res) {
    var url = String((DB.cfg().net.doh || '')).trim();
    if (!url) return setRes(res, 'err', '先填 DoH 端点');
    if (btn) { btn.disabled = true; btn.textContent = '测试中…' }
    setRes(res, '', '解析 example.com …');
    var t0 = Date.now();
    try {
      var full = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'name=example.com&type=A';
      var txt = await Net.get(full, { headers: { Accept: 'application/dns-json' } });
      var ms = Date.now() - t0;
      var ips = [];
      try {
        var d = JSON.parse(txt);
        ips = (d.Answer || []).filter(function (a) { return a && a.type === 1 }).map(function (a) { return a.data });
      } catch (e) { }
      if (ips.length) {
        setRes(res, 'ok', '解析 example.com → ' + ips.join(' / ') + ' · ' + ms + 'ms');
        Log.ok('DoH 测试成功 ' + url + ' → ' + ips[0]);
      } else {
        setRes(res, 'err', '未解析到 A 记录（返回 ' + String(txt || '').length + ' 字符 · ' + ms + 'ms），' +
          '可能被阻断或该端点不支持 dns-json');
        Log.err('DoH 测试无结果 ' + url);
      }
    } catch (e) {
      setRes(res, 'err', '解析失败：' + firstLine(e));
      Log.err('DoH 测试失败 ' + url + '：' + firstLine(e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '测试 DoH' }
    }
  }

  async function testProxy(btn, res) {
    if (btn) { btn.disabled = true; btn.textContent = '测试中…' }
    setRes(res, '', '请求 https://example.com/home …');
    var t0 = Date.now();
    try {
      var r = await Net.request('GET', 'https://example.com/home', { timeout: DB.cfg().net.timeout || 20 });
      var ms = r.ms != null ? r.ms : (Date.now() - t0);
      var size = r.bytes ? fmtSize(r.bytes.length) : (r.txt ? String(r.txt).length + ' 字符' : '');
      setRes(res, 'ok', '连通 · HTTP ' + r.status + ' · ' + ms + 'ms' + (size ? ' · ' + size : ''));
      Log.ok('代理测试连通 HTTP ' + r.status + ' · ' + ms + 'ms');
    } catch (e) {
      setRes(res, 'err', '失败：' + firstLine(e));
      Log.err('代理测试失败：' + firstLine(e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '代理测试' }
    }
  }

  function renderSettingsNet(root) {
    var c = DB.cfg();
    var n = c.net;
    var native = !!(window.Native && typeof window.Native.req === 'function');
    var curDoh = n.doh || DOH_PRESETS[0][2];
    var preset = 'custom';
    DOH_PRESETS.forEach(function (p) { if (p[2] && p[2] === curDoh) preset = p[0] });

    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '网络' }));
    var body = document.createElement('div');
    body.innerHTML = [
      native ? '' : '<div class="st-note"><b>无 Java 桥</b>：本机没有 window.Native，' +
        'DoH / 代理 / 超时都不生效，请求走浏览器 fetch（受跨域限制）。下面的值照常保存，接入桥后立即生效。</div>',

      '<div class="st-grp">连接方式</div>',
      fieldHTML({
        title: '连接方式', valAct: 'mode', value: NET_MODE_NAME[n.mode] || '直连',
        desc: '直连=不做处理；DoH=自定义解析保 SNI；代理=优先走代理；DoH+代理=双保险',
        control: segHTML({ act: 'mode', cur: n.mode || 'direct', items: NET_MODES.map(function (x) { return { v: x[0], label: x[1] } }) })
      }),

      '<div class="st-grp">DoH 端点</div>',
      '<div class="st-field">' +
      '<div class="st-fh"><span class="nm">服务</span><span class="v">' + (preset === 'custom' ? '自定义' : '预设') + '</span></div>' +
      '<select class="input st-select" data-doh-preset>' +
      DOH_PRESETS.map(function (p) {
        return '<option value="' + p[0] + '"' + (p[0] === preset ? ' selected' : '') + '>' + esc(p[1]) + '</option>';
      }).join('') + '</select>' +
      '<input class="input st-input" data-doh-url placeholder="https://223.5.5.5/resolve" value="' + esc(curDoh) + '">' +
      '<div class="st-btnwrap st-btnwrap-tight"><button class="btn" data-test-doh>测试 DoH</button></div>' +
      '<div class="st-testres" data-res-doh></div>' +
      '<div class="st-fd">测试会真发一次 <span class="mono">?name=example.com&amp;type=A</span>，显示解析结果与耗时。</div>' +
      '</div>',

      '<div class="st-grp">代理</div>',
      fieldHTML({
        title: '协议', valAct: 'pp', value: (n.proxyProtocol === 'socks5' ? 'SOCKS5' : 'HTTP'),
        desc: 'socks5 仅记录：需要 Native(OkHttp) 支持，当前不会生效',
        control: segHTML({ act: 'pp', cur: n.proxyProtocol || 'http', items: [{ v: 'http', label: 'HTTP' }, { v: 'socks5', label: 'SOCKS5' }] })
      }),
      '<div class="st-field">' +
      '<div class="st-fh"><span class="nm">代理地址</span><span class="v">' + (n.proxy ? '已填' : '空') + '</span></div>' +
      '<div class="st-fd">设备侧先执行 adb reverse tcp:7890 tcp:7890，再填 127.0.0.1:7890</div>' +
      '<input class="input st-input" data-proxy placeholder="host:port" value="' + esc(n.proxy || '') + '">' +
      '<div class="st-two">' +
      '<input class="input" data-proxy-user placeholder="用户名（可选）" value="' + esc(n.proxyUser || '') + '">' +
      '<input class="input" data-proxy-pass placeholder="密码（可选）" value="' + esc(n.proxyPass || '') + '">' +
      '</div>' +
      '<div class="st-btnwrap st-btnwrap-tight"><button class="btn" data-test-proxy>代理测试</button></div>' +
      '<div class="st-testres" data-res-proxy></div>' +
      '<div class="st-fd">代理认证字段仅记录：Net 层当前不透传用户名/密码。</div>' +
      '</div>',

      '<div class="st-grp">请求参数</div>',
      sliderHTML({ act: 'timeout', title: '超时', desc: '单次请求超时（5–60 秒），Net 层已使用', min: 5, max: 60, step: 1, val: n.timeout == null ? 20 : n.timeout, text: (n.timeout == null ? 20 : n.timeout) + ' 秒' }),
      sliderHTML({ act: 'retry', title: '重试次数', desc: '失败重试（0–3）；当前网络层未透传，仅记录', min: 0, max: 3, step: 1, val: n.retry == null ? 1 : n.retry, text: (n.retry == null ? 1 : n.retry) + ' 次' }),
      sliderHTML({ act: 'qps', title: '请求限速', desc: '站点级 QPS（1–20）· 仅记录，当前不限速', min: 1, max: 20, step: 1, val: n.qps == null ? 3 : n.qps, text: (n.qps == null ? 3 : n.qps) + ' req/s' }),
      sliderHTML({ act: 'conc', title: '并发数', desc: '同时请求数（1–8）· 仅记录', min: 1, max: 8, step: 1, val: n.conc == null ? 4 : n.conc, text: String(n.conc == null ? 4 : n.conc) }),

      '<div class="st-grp">每站点覆盖</div>',
      '<div class="rows">' + (DB.sites().length ? DB.sites().map(function (s) {
        var sn = s.net || null;
        var val = sn ? ([NET_MODE_NAME[sn.mode] || '', sn.proxy || '', sn.doh || ''].filter(Boolean).join(' · ') || '已配置') : '跟随全局';
        return UI.row({
          title: s.name || s.id,
          desc: String(s.site || '').replace(/^https?:\/\//, ''),
          right: val, arrow: !!App.pages['scriptDetail'], act: 's:' + s.id
        });
      }).join('') : UI.row({ title: '暂无站点', desc: '先到站点与脚本里新建', right: '' })) + '</div>',
      '<div class="st-note">站点级网络覆盖保存在 <span class="mono">site.net</span>（脚本详情页编辑）。' +
      '当前 Net 层只读取全局配置，<b>站点覆盖暂未生效</b>，仅做记录。</div>'
    ].join('');
    root.appendChild(body);

    /* 分段：连接方式 / 代理协议 */
    bindSegs(body, function (act, v) {
      if (act === 'mode') {
        saveNet({ mode: v });
        setVal(body, 'mode', NET_MODE_NAME[v] || v);
        UI.toast('已切换网络');
      } else if (act === 'pp') {
        saveNet({ proxyProtocol: v });
        setVal(body, 'pp', v === 'socks5' ? 'SOCKS5' : 'HTTP');
        if (v === 'socks5') UI.toast('socks5 仅记录');
      }
    });

    /* DoH 端点 */
    var presetSel = $('[data-doh-preset]', body);
    var dohInput = $('[data-doh-url]', body);
    if (presetSel) presetSel.onchange = function () {
      var v = presetSel.value;
      for (var i = 0; i < DOH_PRESETS.length; i++) {
        if (DOH_PRESETS[i][0] === v && DOH_PRESETS[i][2]) {
          dohInput.value = DOH_PRESETS[i][2];
          saveDoh(DOH_PRESETS[i][2]);
          return;
        }
      }
      try { dohInput.focus() } catch (e) { }
    };
    if (dohInput) dohInput.onchange = function () {
      var v = String(dohInput.value || '').trim();
      saveDoh(v);
      UI.toast('已保存端点');
    };

    /* 代理地址 / 认证（change 时落盘，避免半截输入） */
    var pIn = $('[data-proxy]', body);
    if (pIn) pIn.onchange = function () {
      var v = String(pIn.value || '').trim();
      if (v && v.indexOf(':') < 0) return UI.toast('格式 host:port');
      saveNet({ proxy: v });
      UI.toast('已保存代理');
    };
    var pu = $('[data-proxy-user]', body), pp = $('[data-proxy-pass]', body);
    if (pu) pu.onchange = function () { saveNet({ proxyUser: String(pu.value || '') }) };
    if (pp) pp.onchange = function () { saveNet({ proxyPass: String(pp.value || '') }) };

    /* 滑块 */
    bindRanges(body, function (k, v) {
      var patch = {};
      patch[k] = v;
      saveNet(patch);
    }, function (k, v) {
      if (k === 'timeout') return v + ' 秒';
      if (k === 'retry') return v + ' 次';
      if (k === 'qps') return v + ' req/s';
      return String(v);
    });

    /* 测试按钮 */
    var bDoh = $('[data-test-doh]', body);
    if (bDoh) bDoh.onclick = function () { testDoh(bDoh, $('[data-res-doh]', body)) };
    var bProxy = $('[data-test-proxy]', body);
    if (bProxy) bProxy.onclick = function () { testProxy(bProxy, $('[data-res-proxy]', body)) };

    /* 每站点覆盖 → 脚本详情 */
    $$('[data-act^="s:"]', body).forEach(function (el) {
      el.onclick = function () {
        var id = el.dataset.act.slice(2);
        if (App.pages['scriptDetail']) App.go('scriptDetail', { id: id });
        else UI.toast('脚本详情页未注册');
      };
    });
  }

  /* ================= P-13 播放 ================= */
  function savePlay(patch) {
    DB.setCfg({ play: patch });
    Log.info('播放设置 ' + JSON.stringify(patch));
  }

  function fmtRate(v) {
    return String(Math.round(v * 100) / 100) + '×';
  }

  function renderSettingsPlay(root) {
    var p = DB.cfg().play;
    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '播放' }));
    var body = document.createElement('div');
    body.innerHTML = [
      '<div class="st-grp">解码与缓存</div>',
      fieldHTML({
        title: '解码器', valAct: 'decoder', value: ({ auto: '自动', hw: '硬解', sw: '软解' })[p.decoder] || '自动',
        desc: 'WebView 下实际由系统决定硬解/软解，此项仅记录偏好',
        control: segHTML({ act: 'decoder', cur: p.decoder || 'auto', items: DECODERS.map(function (d) { return { v: d[0], label: d[1] } }) })
      }),
      fieldHTML({
        title: '分片缓存', valAct: 'cache', value: (p.cache || 128) + ' MB',
        desc: 'HLS 分片缓存到 IndexedDB，按上限 LRU 淘汰',
        control: segHTML({
          act: 'cache', cur: p.cache || 128,
          items: [64, 128, 256, 512].map(function (v) { return { v: v, label: v + 'M' } })
        })
      }),
      sliderHTML({
        act: 'rate', title: '默认倍速', desc: '0.75–2.0，步进 0.25', min: 0.75, max: 2, step: 0.25,
        val: p.rate == null ? 1 : p.rate, text: fmtRate(p.rate == null ? 1 : p.rate)
      }),

      '<div class="st-grp">手势</div>',
      fieldHTML({
        title: '长按倍速', valAct: 'longPress', value: (p.longPress || 2) + '×',
        desc: '长按画面临时提速（播放器读取）',
        control: segHTML({
          act: 'longPress', cur: p.longPress || 2,
          items: [1.5, 2, 3].map(function (v) { return { v: v, label: v + '×' } })
        })
      }),
      UI.switchRow({ title: '手势：亮度', desc: '左侧上下滑调亮度', on: p.gestureLight !== false, act: 'g.light' }),
      UI.switchRow({ title: '手势：音量', desc: '右侧上下滑调音量', on: p.gestureVol !== false, act: 'g.vol' }),
      UI.switchRow({ title: '手势：进度', desc: '横滑快进快退', on: p.gestureSeek !== false, act: 'g.seek' }),

      '<div class="st-grp">播放行为</div>',
      UI.switchRow({ title: '记忆播放进度', desc: '写入 DB.progress（键 site|内容|集），P-24 读取', on: p.resume !== false, act: 'resume' }),
      UI.switchRow({
        title: '后台播放', desc: '需系统 MediaSession；WebView 播放切后台会被系统暂停，开关仅记录', on: !!p.bgPlay, act: 'bg'
      }),
      fieldHTML({
        title: '画面比例', valAct: 'ratio', value: ({ fit: '适应', fill: '填充', crop: '裁切' })[p.ratio] || '适应',
        desc: '播放器默认缩放方式',
        control: segHTML({ act: 'ratio', cur: p.ratio || 'fit', items: RATIOS.map(function (r) { return { v: r[0], label: r[1] } }) })
      }),
      '<div class="st-note">当前播放器为 WebView + hls.js：<b>后台播放、硬解选择做不到；分片缓存已落盘 IndexedDB</b>，' +
      '上面对应项只做记录。切到 Native(ExoPlayer) 后这些设置才会真正生效。</div>'
    ].join('');
    root.appendChild(body);

    bindSegs(body, function (act, v) {
      if (act === 'decoder') { savePlay({ decoder: v }); setVal(body, 'decoder', ({ auto: '自动', hw: '硬解', sw: '软解' })[v] || v) }
      else if (act === 'cache') { savePlay({ cache: +v }); setVal(body, 'cache', v + ' MB') }
      else if (act === 'longPress') { savePlay({ longPress: +v }); setVal(body, 'longPress', v + '×') }
      else if (act === 'ratio') { savePlay({ ratio: v }); setVal(body, 'ratio', ({ fit: '适应', fill: '填充', crop: '裁切' })[v] || v) }
    });
    bindRanges(body, function (k, v) {
      if (k === 'rate') savePlay({ rate: v });
    }, function (k, v) {
      if (k === 'rate') return fmtRate(v);
      return String(v);
    });
    bindSwitch(body, 'g.light', function (on) { savePlay({ gestureLight: on }) });
    bindSwitch(body, 'g.vol', function (on) { savePlay({ gestureVol: on }) });
    bindSwitch(body, 'g.seek', function (on) { savePlay({ gestureSeek: on }) });
    bindSwitch(body, 'resume', function (on) { savePlay({ resume: on }) });
    bindSwitch(body, 'bg', function (on) {
      savePlay({ bgPlay: on });
      if (on) UI.toast('仅记录，需 MediaSession');
    });
  }

  /* ================= P-14 外观 ================= */
  function saveUi(patch) {
    DB.setCfg(patch);
    applyUIExtra();
    Log.info('外观设置 ' + JSON.stringify(patch));
  }


  function openSyntaxColorSheet() {
    var DEF = [['kw', '关键字', '#FF7B72'], ['type', '类型', '#7DD3FC'], ['str', '字符串', '#A5D6A7'],
      ['num', '数字', '#F0B37E'], ['com', '注释', '#6E7B87'], ['fn', '函数', '#82AAFF'],
      ['const', '常量', '#C4B5FD'], ['bi', '内置', '#FBBF24'], ['punct', '标点', '#93A1AD']];
    var PRESETS = ['#FF7B72', '#A5D6A7', '#F0B37E', '#6E7B87', '#82AAFF', '#7DD3FC', '#C4B5FD', '#FBBF24', '#FF5A3C', '#3BA7FF', '#E5E7EB'];
    function renderSheet() {
      var cur = DB.cfg().syntaxColors || {};
      var h = '<div class="sheet-hd">语法配色</div><div class="st-note">所有语言共用；改完立即生效。</div>';
      DEF.forEach(function (x) {
        var v = cur[x[0]] || x[2];
        h += '<div class="syn-row"><div class="syn-name"><b>' + x[1] + '</b><s>' + v + '</s></div>' +
          '<input type="color" data-syn-color="' + x[0] + '" value="' + v + '">' +
          '<div class="syn-swatches">' + PRESETS.map(function (c) {
            return '<i data-syn-set="' + x[0] + '" data-c="' + c + '" style="background:' + c + '" class="' + (c.toLowerCase() === v.toLowerCase() ? 'on' : '') + '"></i>';
          }).join('') + '</div></div>';
      });
      h += '<div class="btn-row"><button class="btn ghost" data-syn-reset>恢复默认</button><button class="btn" data-syn-close>完成</button></div>';
      UI.sheet(h, {
        onOpen: function (pb) {
          function save(k, c) {
            var cur2 = DB.cfg().syntaxColors || {};
            cur2[k] = c;
            DB.setCfg({ syntaxColors: cur2 });
            UI.applySyntaxColors();
            UI.toast('已应用');
          }
          $$('[data-syn-set]', pb).forEach(function (el) {
            el.onclick = function () { save(el.dataset.synSet, el.dataset.c); UI.closeSheet(); renderSheet(); };
          });
          $$('[data-syn-color]', pb).forEach(function (el) {
            el.oninput = function () { save(el.dataset.synColor, el.value); };
          });
          $('[data-syn-reset]', pb).onclick = function () { DB.setCfg({ syntaxColors: {} }); UI.applySyntaxColors(); UI.closeSheet(); renderSheet(); };
          $('[data-syn-close]', pb).onclick = function () { UI.closeSheet(); };
        }
      });
    }
    renderSheet();
  }

  function renderSettingsUi(root) {
    var c = DB.cfg();
    var themeName = ({ dark: '深色', light: '浅色', auto: '跟随系统' })[c.theme] || '深色';
    var motionName = ({ on: '开', off: '关', auto: '跟随系统' })[c.motion] || '开';

    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '外观' }));
    var body = document.createElement('div');
    body.innerHTML = [
      '<div class="st-grp">主题</div>',
      fieldHTML({
        title: '主题', valAct: 'theme', value: themeName,
        desc: '浅色主题切换 data-theme，tokens.css 已支持；跟随系统读 prefers-color-scheme',
        control: segHTML({
          act: 'theme', cur: c.theme || 'dark',
          items: [{ v: 'dark', label: '深色' }, { v: 'light', label: '浅色' }, { v: 'auto', label: '跟随系统' }]
        })
      }),
      '<div class="st-field">' +
      '<div class="st-fh"><span class="nm">强调色</span><span class="v">' + esc(c.accent || ACCENTS[0]) + '</span></div>' +
      '<div class="st-fd">只换 --accent，其它 token 不变</div>' +
      '<div class="st-dots">' + ACCENTS.map(function (a) {
        return '<i data-accent="' + a + '"' + (String(c.accent || '').toUpperCase() === a.toUpperCase() ? ' class="on"' : '') +
          ' style="background:' + a + '"></i>';
      }).join('') + '</div></div>',

      '<div class="st-grp">布局</div>',
      sliderHTML({
        act: 'fontScale', title: '字号缩放', desc: '85%–120%；写 --font-scale（tokens 字阶是固定 px，视觉生效需全局改造）',
        min: 85, max: 120, step: 5, val: c.fontScale || 100, text: (c.fontScale || 100) + '%'
      }),
      fieldHTML({
        title: '圆角', valAct: 'radius', value: (c.radius || 12) + 'px',
        desc: '同时写入 --r-s / --r-m / --r-l',
        control: segHTML({
          act: 'radius', cur: c.radius || 12,
          items: [8, 12, 16].map(function (v) { return { v: v, label: v + 'px' } })
        })
      }),
      fieldHTML({
        title: '动效', valAct: 'motion', value: motionName,
        desc: '关掉后所有过渡降为 0ms；跟随系统读 prefers-reduced-motion',
        control: segHTML({
          act: 'motion', cur: c.motion || 'on',
          items: [{ v: 'on', label: '开' }, { v: 'off', label: '关' }, { v: 'auto', label: '跟随系统' }]
        })
      }),
      '<div class="st-note">主题 / 强调色 / 轮播高度 / 圆角 / 动效改动后立即生效；' +
      '字号缩放因全局字阶为固定 px，当前只写入变量并记录，待全局改造后可见。</div>'
    ].join('');
    root.appendChild(body);
    var uiCss = String((DB.cfg().ui || {}).css || '');
    var cssHtml = '<div class="sh-grp">自定义 CSS</div>' +
      '<div class="d1-pad"><textarea class="input" id="uiCustomCss" rows="6" placeholder="例：:root{--hero-h:220px} .home-body{padding-top:8px}">' + esc(uiCss) + '</textarea>' +
      '<button class="btn ghost block" id="uiSaveCss">保存并应用 CSS</button>' +
      '<button class="btn ghost block" id="uiCssHelp">CSS 示例</button></div>';
    var uiNote = body.querySelector('.st-note');
    if (uiNote) uiNote.insertAdjacentHTML('beforebegin', cssHtml); else body.insertAdjacentHTML('beforeend', cssHtml);
    var cssHelp = $('#uiCssHelp', body);
    if (cssHelp) cssHelp.onclick = function () {
      UI.sheet('<div class="sheet-hd">CSS 示例</div>' +
        '<div class="st-note">CSS 会全局生效，可覆盖内置变量。</div>' +
        '<pre class="doc-code">:root {\n  --accent: #3BA7FF;\n  --hero-h: 220px;\n  --font-scale: 1.05;\n}\n.home-wel { padding: 20px; }\n.home-custom h2 { color: var(--accent); }\n.home-custom { margin: 12px 0; }</pre>' +
        '<div class="st-note">常用变量：--accent 强调色，--hero-h 轮播高度，--font-scale 字号系数，--r-s / --r-m / --r-l 圆角。自定义区块可用 .home-custom 选择器。</div>', {});
    };
    var cssBtn = $('#uiSaveCss', body);
    if (cssBtn) cssBtn.onclick = function () {
      DB.setCfg({ ui: { css: String($('#uiCustomCss', body).value || '') } });
      UI.applyUserCss();
      UI.toast('CSS 已应用');
    };

    var synHtml = UI.row({
      title: '自定义语法',
      desc: '扩展名 → 关键字 / 注释高亮',
      right: (Packs.syntaxes() || []).length + ' 个',
      arrow: true, act: 'syn'
    });
    var synNote = body.querySelector('.st-note');
    if (synNote) synNote.insertAdjacentHTML('beforebegin', synHtml); else body.insertAdjacentHTML('beforeend', synHtml);
    var synEl = $('[data-act=syn]', body);
    if (synEl) synEl.onclick = function openCustomSyntax() {
      var list = Packs.syntaxes() || [];
      var listHtml = list.length ? list.map(function (s) {
        return '<div class="row"><div class="t"><div class="nm">' + esc(s.name) + '</div>' +
          '<div class="ds mono">.' + esc(s.exts) + ' · ' + esc((s.keywords || []).join(' ')) + '</div></div>' +
          '<button class="btn ghost" data-delsyn="' + esc(s.name) + '">删除</button></div>';
      }).join('') : '<div class="st-note">还没有自定义语法。</div>';
      UI.sheet('<div class="sheet-hd">自定义语法</div>' +
        '<div class="st-note">注册后，编辑器按扩展名自动套用关键字/注释高亮。关键字用空格或逗号分隔。</div>' +
        '<div class="rows">' + listHtml + '</div>' +
        '<div class="sh-grp">新增</div>' +
        '<div class="d1-pad">' +
        '<input class="input" data-syn-name placeholder="名称，例如 mylang">' +
        '<input class="input" data-syn-exts placeholder="扩展名，例如 my,myx">' +
        '<input class="input" data-syn-kw placeholder="关键字：if else return">' +
        '<input class="input" data-syn-types placeholder="类型：int str bool">' +
        '<input class="input" data-syn-consts placeholder="常量：true false null">' +
        '<input class="input" data-syn-fns placeholder="函数：print len open">' +
        '<input class="input" data-syn-line placeholder="行注释，例如 //">' +
        '<input class="input" data-syn-block placeholder="块注释，例如 /*,*/">' +
        '<button class="btn pri block" data-syn-save>保存语法</button></div>', {
          onOpen: function (pb) {
            $$('[data-delsyn]', pb).forEach(function (b) {
              b.onclick = function () { Packs.removeCustomSyntax(b.dataset.delsyn); UI.closeSheet(); UI.toast('已删除'); };
            });
            var sv = $('[data-syn-save]', pb);
            if (sv) sv.onclick = function () {
              var name = String($('[data-syn-name]', pb).value || '').trim();
              var exts = String($('[data-syn-exts]', pb).value || '').trim();
              if (!name || !exts) { UI.toast('名称和扩展名必填'); return }
              var block = String($('[data-syn-block]', pb).value || '').split(',');
              var ok = Packs.addCustomSyntax({
                name: name,
                exts: exts,
                keywords: String($('[data-syn-kw]', pb).value || '').split(/[,\s]+/).filter(Boolean),
                types: String($('[data-syn-types]', pb).value || '').split(/[,\s]+/).filter(Boolean),
                constants: String($('[data-syn-consts]', pb).value || '').split(/[,\s]+/).filter(Boolean),
                functions: String($('[data-syn-fns]', pb).value || '').split(/[,\s]+/).filter(Boolean),
                lineComment: String($('[data-syn-line]', pb).value || '').trim(),
                blockComment: block.length === 2 && block[0].trim() ? [block[0].trim(), block[1].trim()] : null
              });
              UI.closeSheet();
              UI.toast(ok ? '语法已保存' : '保存失败');
              if (ok) setTimeout(function () { App.go('settings.ui') }, 60);
            };
          }
        });
    };


    var synColorHtml = UI.row({ title: '语法配色', desc: '关键字 / 类型 / 字符串 / 注释，所有语言通用', right: '调整', arrow: true, act: 'syncolor' });
    var synColorNote = body.querySelector('.st-note');
    if (synColorNote) synColorNote.insertAdjacentHTML('beforebegin', synColorHtml); else body.insertAdjacentHTML('beforeend', synColorHtml);
    var synColorEl = $('[data-act=syncolor]', body);
    if (synColorEl) synColorEl.onclick = function () { openSyntaxColorSheet(); };

    bindSegs(body, function (act, v) {
      if (act === 'theme') {
        saveUi({ theme: v });
        setVal(body, 'theme', ({ dark: '深色', light: '浅色', auto: '跟随系统' })[v] || v);
      } else if (act === 'heroH') {
        saveUi({ heroH: +v });
        setVal(body, 'heroH', v + ' dp');
      } else if (act === 'gridCols') {
        saveUi({ gridCols: +v });
        setVal(body, 'gridCols', v + ' 列');
      } else if (act === 'radius') {
        saveUi({ radius: +v });
        setVal(body, 'radius', v + 'px');
      } else if (act === 'motion') {
        saveUi({ motion: v });
        setVal(body, 'motion', ({ on: '开', off: '关', auto: '跟随系统' })[v] || v);
      }
    });
    bindRanges(body, function (k, v) {
      if (k === 'fontScale') saveUi({ fontScale: v });
    }, function (k, v) {
      if (k === 'fontScale') return v + '%';
      return String(v);
    });

    $$('[data-accent]', body).forEach(function (dot) {
      dot.onclick = function () {
        var a = dot.dataset.accent;
        saveUi({ accent: a });
        $$('[data-accent]', body).forEach(function (x) { x.classList.remove('on') });
        dot.classList.add('on');
        var v = $('.st-fh .v', dot.parentNode.parentNode);
        if (v) v.textContent = a;
      };
    });
  }

  /* ================= P-14 扩展包（1.8.0） ================= */
  function renderSettingsPacks(root) {
    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '扩展包' }));
    var body = document.createElement('div');
    root.appendChild(body);

    function draw() {
      if (!window.Packs) {
        body.innerHTML = UI.stateHTML('error', { msg: '扩展包管理器未加载' });
        return;
      }
      var list = Packs.list();
      var builtin = list.filter(function (x) { return x.builtin; });
      var ins = list.filter(function (x) { return !x.builtin; });
      var row = function (p) {
        var m = p.manifest || {};
        var con = m.contributes || {};
        var tags = [];
        if (con.syntax) tags.push('语法 ' + con.syntax.join('/'));
        if (con.components) tags.push('组件 ' + con.components.join('/'));
        if (con.parsers) tags.push('解析器');
        if (con.themes) tags.push('主题 ' + con.themes.join('/'));
        if (con.pages) tags.push('页面 ' + con.pages.join('/'));
        if (con.layouts) tags.push('布局 ' + con.layouts.join('/'));
        if (m.permissions && m.permissions.length) tags.push('权限 ' + m.permissions.join('/'));
        return '<div class="row tap" data-pack="' + esc(p.id) + '">' +
          '<div class="t"><div class="nm">' + esc(m.name || p.id) + ' <span class="dim mono">v' + esc(m.version || '') + '</span></div>' +
          '<div class="ds">' + esc(tags.join(' · ') || '无贡献点') + ' · ' + esc(p.id) + '</div></div>' +
          '<div class="switch' + (p.enabled ? ' on' : '') + '" data-toggle="' + esc(p.id) + '"><i></i></div>' +
          (p.builtin ? '' : '<div class="arw" data-del="' + esc(p.id) + '">🗑</div>') + '</div>';
      };
      body.innerHTML = [
        '<div class="st-note">扩展包基础版：目前开放语法/组件贡献点；JS 包与 App 同上下文，只安装可信来源。</div>',
        '<div class="st-grp">内置包</div>',
        '<div class="rows">' + builtin.map(row).join('') + '</div>',
        '<div class="st-grp">已安装</div>',
        (ins.length ? '<div class="rows">' + ins.map(row).join('') + '</div>' : '<div class="st-note">还没有第三方扩展包。</div>'),
        '<div class="st-grp">安装</div>',
        '<div class="rows"><div class="row tap" data-install><div class="t"><div class="nm">粘贴扩展包 JSON</div>' +
        '<div class="ds">{"manifest":{...},"code":"..."}；只接受可信来源</div></div><div class="arw">＋</div></div></div>',
        '<div class="st-note">核心版本 ' + esc(Packs.core) + ' · 已注册语法：' + esc((Packs.languages() || []).join(', ') || '无') + '</div>'
      ].join('');
      $$('[data-toggle]', body).forEach(function (el) {
        el.onclick = function (e) {
          e.stopPropagation();
          var id = el.dataset.toggle;
          var cur = list.filter(function (x) { return x.id === id; })[0];
          var r = Packs.setEnabled(id, !(cur && cur.enabled));
          UI.toast(r.ok ? '已更新，重启编辑器或页面后生效' : (r.err || '失败'));
          draw();
        };
      });
      $$('[data-del]', body).forEach(function (el) {
        el.onclick = function (e) {
          e.stopPropagation();
          var id = el.dataset.del;
          UI.dialog({
            title: '删除扩展包', msg: '删除后其语法/组件不再可用。', danger: true, okText: '删除',
            onOk: function () { var r = Packs.remove(id); UI.toast(r.ok ? '已删除' : (r.err || '失败')); draw(); }
          });
        };
      });
      var ths = Packs.themes();
      if (ths.length) {
        var curTheme = (DB.cfg() || {}).themePack || '';
        body.insertAdjacentHTML('beforeend', '<div class="st-grp">主题</div><div class="rows">' +
          '<div class="row tap" data-theme=""><div class="t"><div class="nm">默认主题</div>' +
          '<div class="ds">取消扩展主题，恢复跟随外观设置</div></div><div class="arw">' + (curTheme ? '应用' : '当前') + '</div></div>' +
          ths.map(function (t) {
            return '<div class="row tap" data-theme="' + esc(t.name) + '"><div class="t"><div class="nm">' + esc(t.name) + '</div>' +
              '<div class="ds">来自 ' + esc(t.pack) + '</div></div><div class="arw">' + (curTheme === t.name ? '当前' : '应用') + '</div></div>';
          }).join('') + '</div>');
        $$('[data-theme]', body).forEach(function (el) {
          el.onclick = function () {
            var n = el.dataset.theme;
            if (!n) Packs.clearTheme(); else Packs.applyTheme(n);
            UI.toast(n ? '主题已应用' : '已恢复默认主题');
            draw();
          };
        });
      }
      var pgs = Packs.pages();
      if (pgs.length) {
        body.insertAdjacentHTML('beforeend', '<div class="st-grp">页面</div><div class="rows">' +
          pgs.map(function (p) {
            return '<div class="row tap" data-packpage="' + esc(p.key) + '"><div class="t"><div class="nm">' + esc(p.title) + '</div>' +
              '<div class="ds">来自 ' + esc(p.pack) + '</div></div><div class="arw">›</div></div>';
          }).join('') + '</div>');
        $$('[data-packpage]', body).forEach(function (el) {
          el.onclick = function () { App.go(el.dataset.packpage); };
        });
      }

      body.insertAdjacentHTML('beforeend', '<div class="st-grp">开发</div><div class="rows">' +
        '<div class="row tap" data-packsdoc><div class="t"><div class="nm">扩展包文档与示例</div>' +
        '<div class="ds">manifest / code / 贡献点 / 文档地址</div></div><div class="arw">›</div></div></div>');
      var docEl = $('[data-packsdoc]', body);
      if (docEl) docEl.onclick = function () {
        var sample = '{\n  "manifest": {\n    "id": "my.pack",\n    "name": "示例",\n    "version": "1.0.0",\n    "engines": { "jiexi": ">=1.8.0" },\n    "permissions": [],\n    "contributes": { "components": ["my-card"] }\n  },\n  "code": "api.addComponent(\'my-card\', (it) => \'<div>\' + it.title + \'</div>\')"\n}';
        UI.sheet('<div class="sheet-hd">扩展包文档</div>' +
          '<div class="st-note">使用步骤：1）写 manifest；2）写 code，调用 api.addSyntax / addComponent / addParserTemplate / addTheme / addPage / addLayout；3）把 JSON 放到 https 地址；4）回到扩展包页点“安装”从 URL 拉取。</div><div class="st-note">manifest 必须有 id / version / engines.jiexi / contributes。code 会与 App 同上下文执行，只安装可信来源。</div>' +
          '<div class="st-grp">最小示例</div><pre class="mono" style="white-space:pre-wrap;font-size:12px">' + esc(sample) + '</pre>' +
          '<div class="st-note">文档：docs/PLUGINS.md；也可以在 GitHub 仓库查看最新版本。</div>' +
          '<div class="btn-row"><button class="btn ghost" data-doccopy>复制文档地址</button>' +
          '<button class="btn" data-docopen>打开 GitHub 文档</button></div>', {
            onOpen: function (pb) {
              var u = 'https://github.com/qixidalao/World-Analysis/blob/main/docs/PLUGINS.md';
              $('[data-doccopy]', pb).onclick = function () { try { navigator.clipboard.writeText(u) } catch (e) { } UI.toast('已复制文档地址'); };
              $('[data-docopen]', pb).onclick = function () { UI.closeSheet(); App.go('packdocs'); };
            }
          });
      };

      var insBtn = $('[data-install]', body);
      if (insBtn) insBtn.onclick = function () {
        UI.sheet('<div class="d1-pad"><div class="d1-sheet-h">安装扩展包</div>' +
          '<div class="d1-note">粘贴 {"manifest":{...},"code":"..."}。manifest 必须有 id/version/engines.jiexi/contributes。</div>' +
          '<input class="input" data-pack-url placeholder="https://example.com/pack.json">' +
          '<div class="d1-steprow"><button class="btn ghost" data-pack-fetch>从 URL 拉取</button></div>' +
          '<textarea class="input" rows="8" data-pack-json placeholder="{&quot;manifest&quot;:{...},&quot;code&quot;:&quot;...&quot;}"></textarea>' +
          '<div class="d1-steprow"><button class="btn ghost" data-c>取消</button><button class="btn pri" data-ok>安装</button></div></div>', {
          onOpen: function (pb) {
            $('[data-c]', pb).onclick = function () { UI.closeSheet() };
            var pf = $('[data-pack-fetch]', pb);
            if (pf) pf.onclick = function () {
              var u = String($('[data-pack-url]', pb).value || '').trim();
              if (!/^https?:\/\//i.test(u)) { UI.toast('请输入 http(s) URL'); return }
              UI.toast('正在拉取…');
              Promise.resolve(Net.request('GET', u)).then(function (r) {
                if (!r || (r.status && r.status >= 400)) { UI.toast('拉取失败'); return; }
                var txt = r.txt || r.text || '';
                $('[data-pack-json]', pb).value = txt;
                UI.toast('已拉取，确认后点安装');
              }, function (e) { UI.toast('拉取失败：' + (e.message || e)); });
            };
            $('[data-ok]', pb).onclick = function () {
              var obj;
              try { obj = JSON.parse($('[data-pack-json]', pb).value || '{}') } catch (e) { UI.toast('JSON 解析失败'); return }
              function installNow() {
                var r = Packs.install(obj);
                if (!r.ok) { UI.toast(r.err || '安装失败'); return }
                UI.closeSheet(); UI.toast(r.upgraded ? '已升级' : '已安装'); draw();
              }
              var perms = (obj.manifest && obj.manifest.permissions) || [];
              if (!perms.length) { installNow(); return; }
              UI.sheet('<div class="st-grp">权限确认</div><div class="st-note">扩展包声明了以下权限，安装后代码仍与 App 同上下文：</div>' +
                '<div class="rows">' + perms.map(function (p) { return '<div class="row"><div class="t"><div class="nm mono">' + esc(String(p)) + '</div></div></div>'; }).join('') + '</div>' +
                '<div class="btn-row"><button class="btn ghost" data-pc>取消</button><button class="btn" data-pi>确认安装</button></div>', {
                onOpen: function (p2) {
                  $('[data-pc]', p2).onclick = function () { UI.closeSheet(); };
                  $('[data-pi]', p2).onclick = function () { installNow(); };
                }
              });
            };
          }
        });
      };
    }
    draw();
  }

  /* ================= P-15 Python ================= */
  function renderSettingsPy(root) {
    var pyOk = !!(window.Py && Py.available());
    var pi = pyOk ? (Py.info() || {}) : {};
    var ver = pyOk ? Py.versionText() : '';
    var c = DB.cfg();
    var py = c.py || {};
    var autoMount = py.autoMount === false ? false : true;
    var installed = [];
    try {
      if (pyOk && window.Native && Native.pipList) {
        var _pl = JSON.parse(Native.pipList() || '{}');
        installed = (_pl && _pl.packages) || [];
      }
    } catch (e) { }
    if (!installed.length) installed = DB.installed() || [];
    var userDir = (pi && pi.userDir) ? pi.userDir : 'files/py/';
    var plannedPath = [userDir, 'assets/python/'];
    var sysInfo = (pyOk && window.Py && Py.sysPath) ? Py.sysPath() : null;
    var paths = (sysInfo && sysInfo.ok && Array.isArray(sysInfo.items) && sysInfo.items.length) ? sysInfo.items : plannedPath;

    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: 'Python' }));
    var body = document.createElement('div');
    body.innerHTML = [
      '<div class="st-note">' + (pyOk
        ? '<b>CPython ' + esc(ver) + ' 已内置</b>：可执行、语法检查、测试抓取；脚本保存在 ' + esc(userDir) + '。'
        : '<b>未接入</b>：当前 APK 没有打包 Python 运行时；仅记录配置，不能执行 Python 脚本。') + '</div>',
      '<div class="st-grp">解释器</div>',
      '<div class="rows">',
      UI.row({ title: '解释器信息', desc: pyOk ? 'ABI ' + esc(pi.abi || '') : '未内置 Python', right: pyOk ? esc(ver) : '未接入' }),
      UI.row({ title: '模块管理', desc: pyOk ? '预编译模块 / 安装记录' : '安装记录来自 DB.installed，不是真实解释器', right: installed.length + ' 个', arrow: true, act: 'modules' }),
      UI.row({ title: 'sys.path', desc: pyOk ? '当前解释器路径' : '未接入时不可用', right: paths.length + ' 项', arrow: true, act: 'syspath' }),
      '</div>',
      '<div class="st-grp">行为</div>',
      UI.switchRow({
        title: '自动挂载已装包',
        desc: pyOk ? '启动后自动加载已安装模块（可能增加启动时间）' : '解释器未接入，开关仅记录',
        on: autoMount, act: 'automount'
      }),
      '<div class="rows">',
      UI.row({ title: '脚本目录', desc: pyOk ? '多文件站点目录' : '未接入', right: esc(userDir) }),
      '</div>',
      '<div class="st-grp">危险操作</div>',
      '<div class="rows">',
      UI.row({ title: '重置解释器', desc: '清空 Python 相关配置（不影响站点与脚本）', right: '', arrow: true, danger: true, act: 'reset' }),
      '</div>',
      '<div class="st-note">' + (pyOk
        ? 'Python 脚本通过 Chaquopy 在本地运行，不经过远程服务。'
        : '接入内置 Python 后，终端会切回 >>>，pip 才能真实安装模块。') + '</div>'
    ].join('');
    root.appendChild(body);

    var m = $('[data-act=modules]', body);
    if (m) m.onclick = function () { goFirst(['module', 'modules'], '模块页未注册') };

    var sp = $('[data-act=syspath]', body);
    if (sp) sp.onclick = function () {
      UI.sheet('<div class="st-grp">sys.path</div>' +
        '<div class="st-note">' + (pyOk ? '当前解释器路径。' : '解释器未接入，以下路径尚不可用。') + '</div>' +
        paths.map(function (p) {
          return '<div class="row"><div class="t"><div class="nm mono">' + esc(p) + '</div>' +
            '<div class="ds">' + (pyOk ? '可写' : '未挂载') + '</div></div></div>';
        }).join(''));
    };

    bindSwitch(body, 'automount', function (on) {
      DB.setCfg({ py: { autoMount: on } });
      Log.info('Python 自动挂载开关 ' + (on ? '开' : '关'));
      if (!pyOk) UI.toast('仅记录，Python 未接入');
    });

    var rs = $('[data-act=reset]', body);
    if (rs) rs.onclick = function () {
      UI.dialog({
        title: '重置解释器',
        msg: '将清空 Python 相关配置（自动挂载、sys.path 记录），不影响站点、脚本、收藏与历史。',
        okText: '重置', cancelText: '取消', danger: true,
        onOk: function () {
          DB.setCfg({ py: { autoMount: true } });
          Log.ok('Python 配置已重置');
          UI.toast('已重置配置');
          App.refresh();
        }
      });
    };
  }

  /* ================= P-16 存储 ================= */
  function renderSettingsStorage(root) {
    var t = storageTotals();
    var total = Math.max(1, t.total);
    var colOf = {};
    CATS.forEach(function (c) { colOf[c[0]] = c[2] });

    var bar = CATS.map(function (c) {
      var b = t[c[0]] || 0;
      if (!b) return '';
      return '<i style="width:' + (b / total * 100).toFixed(2) + '%;background:' + colOf[c[0]] + '"></i>';
    }).join('');
    var legend = CATS.map(function (c) {
      var b = t[c[0]] || 0;
      return '<div class="st-lg"><i class="dt" style="background:' + colOf[c[0]] + '"></i>' +
        '<span class="nm">' + esc(c[1]) + '</span>' +
        '<span class="v">' + fmtSize(b) + ' · ' + (t.total ? Math.round(b / t.total * 100) : 0) + '%</span></div>';
    }).join('');

    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '存储' }));
    var body = document.createElement('div');
    body.innerHTML = [
      '<div class="st-grp">占用 · ' + fmtSize(t.total) + '（' + t.keys + ' 个键）</div>',
      '<div class="st-bar">' + (bar || '') + '</div>',
      '<div class="st-lg-wrap">' + legend + '</div>',
      '<div class="st-note">按 localStorage 各键的 UTF-8 字节数估算（WebView 配额约 5 MB）。' +
      '当前只统计 localStorage；已装包在 files、HLS 分片在 IndexedDB，均不计入这里；「其它」= 配置 / 收藏 / 历史 / 进度。</div>',

      '<div class="st-grp">清理</div>',
      '<div class="st-btnwrap"><button class="btn danger" data-clear-all>清理全部缓存</button></div>',
      '<div class="st-btnwrap">' +
      '<button class="btn ghost" data-clear-img>清图片</button>' +
      '<button class="btn ghost" data-clear-video>清视频</button>' +
      '<button class="btn ghost" data-clear-log>清日志</button>' +
      '</div>',
      '<div class="st-note">「清理全部缓存」只清图片 / 视频 / 页面缓存，保留日志与已装模块记录。</div>',

      '<div class="st-grp">导出</div>',
      '<div class="btn-row">' +
      '<button class="btn" data-export-log>导出日志</button>' +
      '<button class="btn" data-export-scripts>导出脚本包</button>' +
      '</div>',
      '<div class="rows">',
      UI.row({ title: '查看日志', desc: '内存 500 条 + 落盘 400 条', right: '打开', arrow: true, act: 'logs' }),
      '</div>',
      '<div class="st-note">导出为<b>复制文本到剪贴板</b>（未接系统分享；文件写入由终端/脚本负责），' +
      '不是 zip 分享）。脚本包包含站点配置与请求头，可能含 Cookie，分享前自行检查。</div>'
    ].join('');
    root.appendChild(body);
    var estEl = document.createElement('div');
    estEl.className = 'st-note';
    estEl.textContent = 'WebView 总占用统计中…';
    body.appendChild(estEl);
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        estEl.textContent = 'WebView 总占用约 ' + fmtSize(e.usage || 0) +
          (e.quota ? ' / 配额 ' + fmtSize(e.quota) : '') +
          '；包含 IndexedDB 分片与浏览器缓存，不包含 files 已装包。';
      }, function () { estEl.textContent = ''; });
    } else { estEl.textContent = ''; }


    var navLog = $('[data-act=logs]', body);
    if (navLog) navLog.onclick = function () { App.go('logs') };

    var all = $('[data-clear-all]', body);
    if (all) all.onclick = function () {
      var bytes = (t.img || 0) + (t.video || 0) + (t.page || 0);
      UI.dialog({
        title: '清理全部缓存',
        msg: '将清理图片 / 视频 / 页面缓存，共可释放 ' + fmtSize(bytes) + '；日志与已装模块记录保留。不可恢复。',
        okText: '清理', cancelText: '取消', danger: true,
        onOk: function () {
          var r = clearCats(['img', 'video', 'page']);
          Log.ok('清理全部缓存 ' + r.n + ' 项 · ' + fmtSize(r.freed));
          UI.toast('已清缓存');
          App.refresh();
        }
      });
    };

    var ci = $('[data-clear-img]', body);
    if (ci) ci.onclick = function () {
      var r = clearCats(['img']);
      UI.toast('已清图片');
      Log.ok('清理图片缓存 ' + fmtSize(r.freed));
      App.refresh();
    };
    var cv = $('[data-clear-video]', body);
    if (cv) cv.onclick = function () {
      var r = clearCats(['video']);
      UI.toast('已清视频');
      Log.ok('清理视频缓存 ' + fmtSize(r.freed));
      App.refresh();
    };
    var cl = $('[data-clear-log]', body);
    if (cl) cl.onclick = function () {
      UI.dialog({
        title: '清理日志',
        msg: '将清空内存与落盘的运行日志，不可恢复。',
        okText: '清理', cancelText: '取消', danger: true,
        onOk: function () {
          Log.clear();
          DB.clearLogs();
          UI.toast('已清日志');
          App.refresh();
        }
      });
    };

    var el = $('[data-export-log]', body);
    if (el) el.onclick = function () {
      var rows = logsMerged();
      if (!rows.length) return UI.toast('暂无日志');
      copyText(logsText(), '已复制日志');
    };
    var es = $('[data-export-scripts]', body);
    if (es) es.onclick = function () {
      var json = DB.exportAll();
      Log.ok('导出脚本包 ' + fmtSize(byteLen(json)));
      copyText(json, '已复制脚本包');
    };
  }

  /* ================= P-17 关于 ================= */
  function engineInfo() {
    var ua = navigator.userAgent || '';
    var m = ua.match(/Chrome\/(\d+(?:\.\d+)*)/);
    return 'Chromium ' + (m ? m[1] : '未知');
  }
  function hlsInfo() {
    var v = window.Hls && window.Hls.version ? window.Hls.version : '';
    return v ? 'hls.js ' + v : 'hls.js 未加载';
  }

  function renderSettingsAbout(root) {
    var lic = [
      ['hls.js', 'Apache-2.0', '已内置（assets/hls.min.js）', hlsInfo()],
      ['OkHttp', 'Apache-2.0', '内置 Java 网络层', '已打包'],
      ['Okio', 'Apache-2.0', 'OkHttp 依赖', '已打包'],
      ['Chaquopy', 'MIT', '视安装包是否内置 Python', '按包']
    ];

    var _pyOk = !!(window.Py && Py.available());
    lic = lic.map(function (x) {
      if (x[0] === 'Chaquopy') return ['Chaquopy', 'MIT', _pyOk ? '内置 CPython 运行时' : '未包含 Python 运行时', _pyOk ? '已内置' : '未打包'];
      return x;
    });

    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '关于' }));
    var body = document.createElement('div');
    body.innerHTML = [
      '<div class="st-about-hd"><div class="st-about-ico">🧩</div>' +
      '<div><div class="st-about-nm">界析 · 世界解析器</div>' +
      '<div class="st-about-ds">' + VERSION + ' · WebView 前端</div></div></div>',
      '<div class="st-grp">构建</div>',
      '<div class="rows">',
      UI.row({ title: '版本', desc: '当前安装包版本', right: VERSION }),
      UI.row({ title: 'build', desc: 'build.ps1 直编（aapt2 + javac + d8）', right: '#' + ((window.App && App.info && App.info.versionCode) || 0) }),
      UI.row({ title: '签名指纹', desc: 'apkdev.jks 自签（debug 用），非发布签名；指纹需 Native 桥读取，当前不可用', right: 'debug 签名' }),
      UI.row({ title: '引擎', desc: 'WebView 内核（系统自带）· ' + hlsInfo(), right: engineInfo() }),
      '</div>',
      '<div class="st-grp">运行时</div>',
      '<div class="rows">',
      (function () { var ok = !!(window.Py && Py.available()); return UI.row({ title: 'Python', desc: ok ? '内置 CPython，可执行/检查脚本' : '当前 APK 无 Python 解释器；终端 shell 仍可用', right: ok ? Py.versionText() : '未接入' }); })(),
      (function () { var ok = !!(window.Py && Py.available()); var v = ok ? Py.versionText() : ''; return UI.row({ title: 'Chaquopy', desc: ok ? '内置 CPython，可执行/检查脚本' : '当前安装包未内置 Python 运行时', right: ok ? v : '未接入' }); })(),
      UI.row({ title: 'AGP', desc: '仅 Gradle 工程配置，当前 APK 由 build.ps1 直编', right: '8.1.4' }),
      '</div>',
      '<div class="st-grp">其它</div>',
      '<div class="rows">',
      UI.row({ title: '开源许可', desc: 'hls.js · OkHttp · Okio · Chaquopy', right: lic.length + ' 项', arrow: true, act: 'lic' }),
      UI.row({ title: '反馈', desc: '模块商店内反馈，或复制联系邮箱', right: '反馈', act: 'mail' }),
      UI.row({ title: '项目主页', desc: '未发布', right: '—' }),
      '</div>',
      '<div class="st-about-foot">解析器 ' + VERSION + ' · 解析规则与扩展包由用户自行配置，安装前确认来源可信</div>'
    ].join('');
    root.appendChild(body);

    var updHtml = UI.row({ title: '检查更新', desc: '从发布通道读取版本与下载地址', right: '检查', arrow: true, act: 'upd' });
    var foot = body.querySelector('.st-about-foot');
    if (foot) foot.insertAdjacentHTML('beforebegin', updHtml); else body.insertAdjacentHTML('beforeend', updHtml);
    var upd = $('[data-act=upd]', body);
    if (upd) upd.onclick = function () {
      UI.toast('正在检查更新…');
      Promise.resolve(Net.request('GET', 'https://cloud.lenv.top/pub/jiexi/version.json')).then(function (r) {
        var txt = (r && (r.txt || r.text)) || '';
        if (!txt) throw new Error('空响应');
        var o = JSON.parse(txt);
        var cur = Number((App.info && App.info.versionCode) || 0);
        var nxt = Number(o.versionCode || 0);
        if (!nxt || nxt <= cur) { UI.toast('已是最新 ' + VERSION); return; }
        UI.sheet('<div class="sh-h">发现新版本</div><div class="st-note">' +
          esc(o.versionName || nxt) + '（#' + nxt + '）<br>' + esc(o.notes || '') + '</div>' +
          '<div class="btn-row">' + (o.url ? '<button class="btn" data-upd-install>下载并安装</button>' : '') + '<button class="btn ghost" data-copy-upd>复制地址</button></div>', {});
        var sheet = document.querySelector('.sheet') || document;
        var cp = $('[data-copy-upd]', sheet);
        if (cp) cp.onclick = function () { UI.toast(o.url ? '下载地址：' + o.url : '发布通道未配置下载地址'); };
        var ins = $('[data-upd-install]', sheet);
        if (ins) ins.onclick = function () {
          if (!o.url || !window.Native || !Native.updateApk) { UI.toast('当前安装包不支持应用内安装'); return; }
          UI.toast('开始下载更新包…');
          try { Native.updateApk(o.url); } catch (e) { UI.toast('下载失败：' + (e.message || e)); }
        };
      }).catch(function (e) { UI.toast('检查失败：' + (e.message || e)); });
    };

    var lk = $('[data-act=lic]', body);
    if (lk) lk.onclick = function () {
      UI.sheet('<div class="st-grp">开源许可</div>' + lic.map(function (x) {
        return '<div class="row"><div class="t"><div class="nm">' + esc(x[0]) + ' · ' + esc(x[1]) + '</div>' +
          '<div class="ds">' + esc(x[2]) + ' · ' + esc(x[3]) + '</div></div></div>';
      }).join('') +
        '<div class="st-note">hls.js / OkHttp / Okio 随 APK 分发；Chaquopy 仅在 with-python 包中。</div>');
    };
    var ml = $('[data-act=mail]', body);
    if (ml) ml.onclick = function () { copyText('feedback@rouparser.example', '已复制邮箱') };
  }

  /* ================= P-18 日志 ================= */
  function renderLogs(root) {
    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '日志' }));
    var body = document.createElement('div');
    root.appendChild(body);
    var onlyErr = false;
    var selecting = false;
    var selected = {};

    longPress(body, '.st-log-row', function (el) {
      if (selecting) return;
      copyText(el.textContent, '已复制该行');
    });

    function draw() {
      var all = logsMerged();
      var rows = onlyErr ? all.filter(function (r) { return r.lv === 'err' }) : all;
      var shown = rows.slice(-300);
      var memN = 0, diskN = 0;
      try { memN = (Log.all() || []).length } catch (e) { }
      try { diskN = (DB.logs() || []).length } catch (e) { }

      body.innerHTML = [
        '<div class="st-toolbar">',
        segHTML({ act: 'flt', cur: onlyErr ? 'err' : 'all', items: [{ v: 'all', label: '全部' }, { v: 'err', label: '只看错误' }] }),
        '<button class="btn ghost" data-copy-all>复制全部</button>',
        '<button class="btn ghost" data-select>' + (selecting ? '退出多选' : '多选') + '</button>',
        (selecting ? '<button class="btn ghost" data-selall>全选</button><button class="btn" data-copy-sel>复制选中(' + Object.keys(selected).length + ')</button>' : ''),
        '<button class="btn ghost st-clear" data-clear>清理</button>',
        '</div>',
        (shown.length ? '<div class="st-log">' + shown.map(function (r) {
          var lv = (r.lv === 'ok' || r.lv === 'info' || r.lv === 'err') ? r.lv : 'def';
          var idx = shown.indexOf(r);
          return '<div class="st-log-row lv-' + lv + '"' + (selecting ? ' data-selrow="' + idx + '"' : '') + '>' +
            (selecting ? '<input type="checkbox" data-selbox="' + idx + '"' + (selected[idx] ? ' checked' : '') + '>' : '') +
            '<span class="tm">' + hhmmss(r.t) + '</span>' +
            '<span class="ms">' + esc(r.msg) + '</span></div>';
        }).join('') + '</div>'
          : UI.stateHTML('empty', { msg: onlyErr ? '还没有错误日志' : '还没有日志', noBtn: true })),
        '<div class="st-note">数据来源：内存 ' + memN + ' 条（环形 500）+ 落盘 ' + diskN + ' 条（滚动 400），已合并去重。' +
        (rows.length > shown.length ? '当前共 ' + rows.length + ' 条，只展示最近 ' + shown.length + ' 条。' : '') +
        '长按某行可复制。</div>'
      ].join('');

      var ca = $('[data-copy-all]', body);
      if (ca) ca.onclick = function () {
        var txt = rows.map(function (r) { return hhmmss(r.t) + ' ' + r.msg }).join('\n');
        copyText(txt, '已复制 ' + rows.length + ' 条');
      };

      bindSegs(body, function (act, v) {
        if (act !== 'flt') return;
        onlyErr = v === 'err';
        draw();
      });
      var selBtn = $('[data-select]', body);
      if (selBtn) selBtn.onclick = function () { selecting = !selecting; selected = {}; draw(); };
      var selAll = $('[data-selall]', body);
      if (selAll) selAll.onclick = function () {
        shown.forEach(function (r, i) { selected[i] = true; });
        draw();
      };
      var csel = $('[data-copy-sel]', body);
      if (csel) csel.onclick = function () {
        var arr = shown.filter(function (r, i) { return selected[i]; });
        if (!arr.length) { UI.toast('先勾选日志'); return; }
        copyText(arr.map(function (r) { return hhmmss(r.t) + ' ' + r.msg }).join('\n'), '已复制 ' + arr.length + ' 条');
      };
      if (selecting) {
        $$('[data-selbox]', body).forEach(function (box) {
          box.onclick = function (e) { e.stopPropagation(); selected[box.dataset.selbox] = box.checked; draw(); };
        });
        $$('[data-selrow]', body).forEach(function (row) {
          row.onclick = function () { var i = row.dataset.selrow; selected[i] = !selected[i]; draw(); };
        });
      }
      var clr = $('[data-clear]', body);
      if (clr) clr.onclick = function () {
        UI.dialog({
          title: '清理日志',
          msg: '将清空内存与落盘的运行日志，不可恢复。',
          okText: '清理', cancelText: '取消', danger: true,
          onOk: function () {
            Log.clear();
            DB.clearLogs();
            UI.toast('已清日志');
            draw();
          }
        });
      };
    }

    draw();
  }

  /* ================= 注册 ================= */
  App.pages['settings'] = guard('settings', renderSettings);
  App.pages['settings.site'] = guard('settings.site', renderSettingsSite);
  App.pages['settings.net'] = guard('settings.net', renderSettingsNet);
  App.pages['settings.play'] = guard('settings.play', renderSettingsPlay);
  App.pages['settings.ui'] = guard('settings.ui', renderSettingsUi);
  App.pages['settings.py'] = guard('settings.py', renderSettingsPy);
App.pages['settings.packs'] = guard('settings.packs', renderSettingsPacks);
  App.pages['settings.storage'] = guard('settings.storage', renderSettingsStorage);
  App.pages['settings.about'] = guard('settings.about', renderSettingsAbout);
  App.pages['logs'] = guard('logs', renderLogs);
})();

  /* ================= 扩展包文档（读取仓库 docs 并展示） ================= */
  App.pages['packdocs'] = function (root) {
    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '扩展包文档与示例' }));
    var tabs = document.createElement('div');
    tabs.className = 'doc-tools';
    tabs.innerHTML = '<button class="btn ghost" data-doc="PLUGINS">扩展包</button>' +
      '<button class="btn ghost" data-doc="SCRIPT_API">脚本 API</button>' +
      '<button class="btn ghost" data-doc="BUILD">构建</button>' +
      '<button class="btn ghost" data-doc="EDITOR">编辑器</button>' +
      '<button class="btn ghost" data-doc="CUSTOMIZE">界面自定义</button>';
    root.appendChild(tabs);
    var body = document.createElement('div');
    body.className = 'doc-body';
    root.appendChild(body);
    body.innerHTML = '<div class="st-note">文档在线读取；访问失败请到 QQ 群 123456789。</div>';
    var fallback = '# 扩展包文档\n\n### 1. manifest\n必须包含 id / version / engines.jiexi / contributes。\n\n### 2. code\n调用 api.addSyntax / addComponent / addParserTemplate / addTheme / addPage / addLayout。\n\n### 3. 安装\n把 JSON 放到 https 地址，在 设置 → 扩展包 → 从 URL 安装。';
    function md(txt) {
      var out = [], code = false;
      String(txt || '').split('\n').forEach(function (line) {
        if (/^```/.test(line)) { code = !code; out.push(code ? '<pre class="doc-code">' : '</pre>'); return; }
        if (code) { out.push(esc(line) + '\n'); return; }
        if (/^### /.test(line)) out.push('<h3>' + esc(line.slice(4)) + '</h3>');
        else if (/^## /.test(line)) out.push('<h2>' + esc(line.slice(3)) + '</h2>');
        else if (/^# /.test(line)) out.push('<h1>' + esc(line.slice(2)) + '</h1>');
        else if (/^[-*] /.test(line)) out.push('<div class="doc-li">• ' + esc(line.slice(2)) + '</div>');
        else if (/^\s*$/.test(line)) out.push('<div style="height:6px"></div>');
        else out.push('<p>' + esc(line) + '</p>');
      });
      return out.join('');
    }
    function sampleCard(title, note, code) {
      return '<div class="st-grp">' + esc(title) + '</div>' +
        '<div class="st-note">' + esc(note) + '</div>' +
        '<pre class="doc-code">' + esc(code) + '</pre>' +
        '<div class="btn-row"><button class="btn ghost" data-copy-sample>复制代码</button></div>';
    }
    function pack(contributes, code) {
      return JSON.stringify({
        manifest: {
          id: 'my.pack', name: '我的扩展', version: '1.0.0',
          engines: { jiexi: '>=1.8.0' }, permissions: [],
          contributes: contributes || {}
        },
        code: code
      }, null, 2);
    }
    function samples() {
      var h = '<div class="st-grp">可直接使用的示例</div>';
      h += sampleCard('组件', '注册详情页组件 my-card。', pack({ components: ['my-card'] }, "api.addComponent('my-card', function (it) { return '<div class=\"card\">' + it.title + '</div>'; });"));
      h += sampleCard('规则模板', '注册一个规则模板。', pack({ parsers: ['示例列表'] }, "api.addParserTemplate({ name: '示例列表', desc: '演示', rule: { list: { url: 'https://example.com', item: 'a', title: 'a' } } });"));
      h += sampleCard('主题', '注册主题，安装后在扩展包主题里应用。', pack({ themes: ['mytheme'] }, "api.addTheme('mytheme', { accent: '#3BA7FF', bg: '#08111E' });"));
      h += sampleCard('页面', '注册可打开页面。', pack({ pages: ['mypage'] }, "api.addPage('mypage', { title: '我的页面', render: function (body) { body.innerHTML = '<h2>Hello</h2>'; } });"));
      h += sampleCard('首页布局块', '首页显示自定义布局块。', pack({ layouts: ['myblock'] }, "api.addLayout('myblock', { title: '我的布局块', render: function (el) { el.innerHTML = '<b>你好</b>'; } });"));
      h += sampleCard('自定义语法', '注册扩展名语法高亮。', pack({ syntax: ['mylang'] }, "api.addSyntax('mylang', { keywords: ['if', 'else'], types: ['int'], lineComment: '//' });"));
      h += '<div class="st-note">每个代码块都是完整 JSON。保存成 https 地址，在扩展包页从 URL 安装；同 id 更高版本会升级。</div>';
      return h;
    }
    function load(name, url) {
      body.innerHTML = '<div class="st-note">正在读取在线文档 ' + esc(name) + '…</div>';
      function fail(e) {
        body.innerHTML = '<div class="st-note">文档访问失败：' + esc((e && e.message) || e) + '<br>' +
          '请到 QQ 群 <b>123456789</b> 获取文档或反馈。</div>' +
          '<div class="btn-row"><button class="btn" data-copy-qq>复制群号</button>' +
          '<button class="btn ghost" data-retry-doc>重试</button></div>';
        var q = $('[data-copy-qq]', body);
        if (q) q.onclick = function () { try { navigator.clipboard.writeText('123456789') } catch (x) { } UI.toast('群号已复制'); };
        var rt = $('[data-retry-doc]', body);
        if (rt) rt.onclick = function () { load(name, url); };
      }
      Promise.race([
        fetch(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('请求超时')); }, 10000); })
      ]).then(function (txt) {
        try {
          body.innerHTML = '<div class="doc-wrap">' + md(txt) + '</div>' + samples();
        } catch (e) {
          body.innerHTML = '<div class="doc-wrap">' + md(txt) + '</div>';
        }
        $$('[data-copy-sample]', body).forEach(function (b) {
          b.onclick = function () {
            var pre = b.parentNode.previousElementSibling;
            try { navigator.clipboard.writeText(pre ? pre.textContent : ''); } catch (e) { }
            UI.toast('已复制');
          };
        });
      }, fail);
    }
    $$('[data-doc]', tabs).forEach(function (b) {
      b.onclick = function () {
        var n = b.dataset.doc;
        load(n, 'https://raw.githubusercontent.com/qixidalao/World-Analysis/main/docs/' + n + '.md');
      };
    });
    load('PLUGINS', 'https://raw.githubusercontent.com/qixidalao/World-Analysis/main/docs/PLUGINS.md');
  };
