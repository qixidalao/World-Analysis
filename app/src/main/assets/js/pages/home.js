/* home.js — T-1 主页（软件门面，永不随站点变化）
   数据源：全部本地（DB.cfg / DB.sites / DB.hist），**主页不发任何网络请求**（docs/07 T-1 专属规则）。
   包含：顶栏站点切换（V-01）+ 🎨 主页自定义（V-09）/ 欢迎语 / 功能卡宫格（C-18）/
        我的站点 / 继续观看 / 公告条 / 底部署名。
   长按菜单（C-10 浮层）：站点卡（脚本小程序）/ 继续观看卡（历史）各一套操作菜单；
        手势 = 触摸按住 500ms（位移 >10px 或提前抬起不触发），桌面右键 contextmenu 等价。
   7 态：本页纯本地渲染（秒开）→ loading / offline / invalid 不适用；
        ready、empty（无站点 / 无历史）、error（整体渲染异常）、partial（单区块降级）已实现。 */
(function () {
  const VER = (window.App && App.info && App.info.version) || '0.0.0';
  const NOTICE_KEY = 'rouparser.noticeClosed';   // 公告条「已关闭」记忆（docs/07：记住关闭状态）
  const FAV_SEG_KEY = 'rouparser.favSeg';        // 与 fav.js 共用：进 T-3 时默认落到哪一段
  const LONG_MS = 500;                           // 长按判定阈值（ms），docs/07 手势规范
  const MOVE_PX = 10;                            // 位移超过 10px 视为滑动，不触发长按
  const SUPPRESS_MS = 700;                       // 长按后吞掉 click 的时间窗（防止又跳页）

  /* 只存 UI 小状态，不进 DB 配置（避免污染 cfg） */
  const LS = {
    get(k) { try { return localStorage.getItem(k) } catch (e) { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch (e) { } },
    del(k) { try { localStorage.removeItem(k) } catch (e) { } }
  };

  function firstLine(s) { return String(s == null ? '' : s).split('\n')[0].slice(0, 120) }
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function hostOf(u) { return String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '') }
  function idOfUrl(u) {
    const m = String(u || '').match(/\/(?:v|hls)\/([0-9a-zA-Z_-]{6,48})/);
    return m ? m[1] : '';
  }
  function iconHTML(s) {
    const ic = String((s && s.icon) || '');
    if (/^(https?:|data:)/.test(ic)) return '<img src="' + esc(ic) + '" alt="" onerror="this.remove()">';
    return esc(ic || '🌐');
  }
  function netModeName(m) {
    return { direct: '直连', doh: 'DoH', proxy: '代理', both: 'DoH+代理' }[m] || '直连';
  }

  /* 缓存大小估算：页面缓存 key 为 rouparser.cache.<site>.<name>（browse.js 写入），
     按 UTF-16 字符数 × 2 估算字节，只用于展示与「清理」提示。 */
  function cacheBytes() {
    let n = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf(DB.NS + 'cache.') !== 0) continue;
        const v = localStorage.getItem(k) || '';
        n += (k.length + v.length) * 2;
      }
    } catch (e) { Log.err('统计缓存失败: ' + e.message) }
    return n;
  }

  /* 播放进度：历史条目自带 pos/dur 优先，否则查 progress 表（DB.lastProgress） */
  function progressOf(it) {
    if (!it) return null;
    try {
      if (it.pos > 0) return { pos: it.pos, dur: it.dur || 0 };
      const site = it.site || App.siteId;
      const id = it.id || idOfUrl(it.url);
      if (!site || !id) return null;
      const p = DB.lastProgress(site, id);
      return p && p.pos > 0 ? p : null;
    } catch (e) { return null }
  }

  /* ---------------- 注册 Tab ---------------- */
  App.tabs['home'] = function (root) {
    root.innerHTML = '';
    try {
      renderHome(root);
      applyHomeBg(root);
    } catch (e) {
      /* boot 也会兜底，这里自己先兜：绝不白屏 */
      Log.err('主页渲染失败: ' + e.message);
      root.innerHTML = '';
      UI.state(root, 'error', { msg: '主页加载失败：' + firstLine(e.message), retry: () => App.renderTab() });
    }
  };

  function renderHome(root) {
    const cfg = DB.cfg();
    const hc = cfg.home || {};
    const sid = App.siteId || null;
    const site = sid ? DB.site(sid) : null;
    const offline = navigator.onLine === false;

    /* ---------- 顶栏：左「解析器 v1.0」，右「站点名 ▾」+ 🎨 ---------- */
    const siteLabel = (site ? site.name : '选择站点') + ' ▾';
    const offDot = site && site.enabled === false ? ' <i class="dot off"></i>' : '';
    const bar = UI.topbar({
      back: false,
      title: '界析 v' + VER,
      right: [
        { i: esc(siteLabel) + offDot, act: 'site', cls: 'sitepick' },
        { i: '🎨', act: 'custom' }
      ]
    });
    root.appendChild(bar);
    $('[data-act=site]', bar).onclick = openSitePicker;
    $('[data-act=custom]', bar).onclick = openCustomize;

    const body = el('div', 'home-body');
    root.appendChild(body);
    try {
      if (window.Packs && Packs.layouts) {
        Packs.layouts().forEach(function (l) {
          const box = el('div', 'pack-layout');
          body.insertBefore(box, body.firstChild);
          try { l.render(box); if (UI.externalLinks) UI.externalLinks(box); } catch (e) { Log.err('layout ' + l.name + ': ' + e.message); }
        });
      }
    } catch (e) { }

    /* 区块级降级（partial）：单个区块异常只降级该区块，不整页报错 */
    function safe(name, fn) {
      try {
        fn(body);
      } catch (e) {
        Log.err('主页区块「' + name + '」失败: ' + e.message);
        body.appendChild(UI.errbar('「' + name + '」加载失败：' + firstLine(e.message), () => App.renderTab()));
      }
    }

    /* 自定义顺序：home.order，未配置时用默认顺序 */
    const DEFAULT_ORDER = ['welcome', 'tiles', 'sites', 'cont', 'custom', 'notice'];
    const order = Array.isArray(hc.order) && hc.order.length
      ? hc.order.filter(k => DEFAULT_ORDER.indexOf(k) >= 0).concat(DEFAULT_ORDER.filter(k => hc.order.indexOf(k) < 0))
      : DEFAULT_ORDER;
    const blocks = {
      welcome: () => { if (hc.welcome) safe('欢迎语', renderWelcome) },
      tiles: () => { if (hc.tiles) safe('功能卡', renderTiles) },
      sites: () => { if (hc.sites) safe('我的站点', renderSites) },
      cont: () => { if (hc.cont) safe('继续观看', renderCont) },
      custom: () => {
        const code = String(hc.customCode || hc.customHtml || '').trim();
        if (!code) return;
        safe('自定义区块', function () {
          var box = el('div', 'home-custom');
          box.id = 'home-custom-block';
          body.appendChild(box);
          if (hc.customCss) {
            var st = document.createElement('style');
            st.textContent = scopeCustomCss(hc.customCss);
            box.appendChild(st);
          }
          var mode = '';
          var codeBody = code;
          var mm = code.match(/^\s*(js|javascript|py|python|html)\s*:\s*/i);
          if (mm) { mode = mm[1].toLowerCase(); codeBody = code.slice(mm[0].length); }
          else if (/^\s*return\b/i.test(code)) mode = 'js';
          if (mode === 'py' || mode === 'python') {
            if (!window.Py || !Py.available || !Py.available()) { box.innerHTML = '<div class="st-note">py 区块需要内置 Python。</div>'; return; }
            Py.eval(codeBody).then(function (r) {
              if (!r || !r.ok) { box.innerHTML = '<div class="st-note">py 区块失败：' + esc((r && r.err) || 'unknown') + '</div>'; return; }
              var v = String(r.repr || '');
              if ((v[0] === '"' && v[v.length-1] === '"') || (v[0] === "'" && v[v.length-1] === "'")) v = v.slice(1, -1);
              if (!v) { box.innerHTML = '<div class="st-note">py 区块执行成功但返回空字符串。</div>'; return; }
              box.innerHTML += v;
              if (UI.externalLinks) UI.externalLinks(box);
            });
          } else if (mode === 'js' || mode === 'javascript') {
            try {
              var fn = new Function('ctx', codeBody + '\n');
              var out = fn({ cfg: DB.cfg(), home: hc });
              if (out == null || String(out).trim() === '') {
                box.innerHTML += '<div class="st-note">JS 执行成功，但返回空字符串。</div>';
              } else {
                box.innerHTML += String(out);
              }
              if (UI.externalLinks) UI.externalLinks(box);
            } catch (e) {
              box.innerHTML += '<div class="st-note">js 区块失败：' + esc(e.message || e) + '</div>';
            }
          } else {
            box.innerHTML += codeBody.replace(/<h>([\s\S]*?)<\/h>/gi, '<h3>$1</h3>');
            if (UI.externalLinks) UI.externalLinks(box);
          }
        });
      },
      notice: () => {
        if (!hc.notice || noticeClosed()) return;
        if (offline) safe('公告', renderNotice);
        else safe('公告', renderNotice);
      }
    };
    order.forEach(k => { if (blocks[k]) blocks[k]() });

    body.appendChild(el('div', 'home-foot', '界析 v' + VER + ' · 解析规则与扩展包由用户自行配置'));
    body.appendChild(el('div', 'tab-end'));
  }

  function noticeClosed() { return LS.get(NOTICE_KEY) === '1' }

  /* ---------------- 欢迎语 ---------- */
  function renderWelcome(body) {
    const txt = String((DB.cfg().home || {}).welcomeText || '').trim()
      .replace(/^可编程解析客户端\s*·\s*/, '');   // 默认文案自带标题，去掉避免重复
    const box = el('div', 'home-wel');
    var title = String((DB.cfg().home || {}).welcomeTitle || '可编程解析客户端').trim() || '可编程解析客户端';
    box.innerHTML = '<h1>' + esc(title) + '</h1>' + (txt ? '<p>' + esc(txt) + '</p>' : '');
    body.appendChild(box);
  }

  /* ---------------- 功能卡宫格（固定 6 格：终端/模块/脚本/设置/缓存/日志） ---------------- */
  function renderTiles(body) {
    const hc = DB.cfg().home || {};
    const layout = hc.tilesLayout || '3x2';
    const cls = layout === 'cols4' ? ' cols4' : (layout === 'cols2' ? ' cols2' : '');
    let moduleN = 0;
    try {
      const r = window.Native && Native.pipList ? JSON.parse(Native.pipList()) : null;
      moduleN = (r && r.packages) ? r.packages.length : DB.installed().length;
    } catch (e) {
      try { moduleN = DB.installed().length } catch (_) { }
    }
    let scriptN = 0;
    try { scriptN = DB.stats().scripts } catch (e) { }
    const cacheN = fmtSize(cacheBytes());

    const tiles = [
      { k: 'terminal', i: '🐍', n: '终端' },
      { k: 'module', i: '📦', n: '模块', c: String(moduleN) },
      { k: 'script', i: '📜', n: '脚本', c: String(scriptN) },
      { k: 'settings', i: '⚙️', n: '设置' },
      { k: 'cache', i: '🧹', n: '缓存', c: cacheN },
      { k: 'log', i: '📋', n: '日志' }
    ];
    const box = el('div', 'tiles' + cls);
    box.innerHTML = tiles.map(t =>
      '<div class="tile" data-tile="' + t.k + '"><div class="i">' + t.i + '</div>' +
      '<div class="n">' + esc(t.n) + '</div>' +
      (t.c != null ? '<div class="cnt">' + esc(t.c) + '</div>' : '') + '</div>').join('');
    body.appendChild(box);

    $$('[data-tile]', box).forEach(node => {
      node.onclick = () => {
        const k = node.dataset.tile;
        if (k === 'terminal') return App.go('terminal');
        if (k === 'module') return App.go('module');
        if (k === 'script') return App.go('scripts');
        if (k === 'settings') return App.go('settings');
        if (k === 'log') return App.go('logs');
        if (k === 'cache') return clearCache(node);
      };
    });
  }

  /* 缓存格：直接清理（docs/07 功能卡：点进对应页；缓存格直接清理并 Toast） */
  function clearCache(tileNode) {
    const before = cacheBytes();
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(DB.NS + 'cache.') === 0) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } catch (e) {
      Log.err('清理缓存失败: ' + e.message);
      return UI.toast('清理缓存失败');
    }
    const cnt = $('.cnt', tileNode);
    if (cnt) cnt.textContent = fmtSize(cacheBytes());
    UI.toast(before > 0 ? '已清理 ' + fmtSize(before) : '无可清理缓存');
  }

  /* ---------------- 我的站点 ---------------- */
  function renderSites(body) {
    const hc = DB.cfg().home || {};
    const sites = DB.sites();
    const grid = hc.siteLayout === 'grid';

    const sec = el('div', 'sec');
    sec.innerHTML =
      '<div class="sec-h"><h3>我的站点</h3><s class="more" data-manage>管理 ›</s></div>' +
      '<div class="' + (grid ? 'site-grid' : 'site-list') + '">' + sites.map(siteCardHTML).join('') + '</div>' +
      '<div class="site-add' + (sites.length ? '' : ' big') + '" data-add>＋ 添加站点' +
      (sites.length ? '' : '<small>新建脚本后，站点会出现在这里</small>') + '</div>';
    body.appendChild(sec);

    $$('[data-site]', sec).forEach(card => {
      card.onclick = () => {
        const s = DB.site(card.dataset.site);
        if (!s) return UI.toast('站点已删除');
        if (s.enabled === false) return UI.toast('已停用');   // docs/07：停用卡点击 → Toast「已停用」
        openSite(s.id);
      };
    });
    /* 长按（含停用卡）→ 站点操作菜单；右键等价 */
    bindLongPress($$('[data-site]', sec), card => openSiteMenu(card.dataset.site));
    const mgr = $('[data-manage]', sec);
    if (mgr) mgr.onclick = () => App.go('scripts');
    const add = $('[data-add]', sec);
    if (add) add.onclick = () => App.go('newscript');
  }

  function siteCardHTML(s) {
    const on = s.enabled !== false;
    return '<div class="site' + (on ? '' : ' off') + '" data-site="' + esc(s.id) + '">' +
      '<div class="ic">' + iconHTML(s) + '</div>' +
      '<div class="t"><div class="nm">' + esc(s.name || s.id) + '</div>' +
      '<div class="ds">' + esc(hostOf(s.site) || '未设置域名') + '</div></div>' +
      '<div class="st' + (on ? ' on' : '') + '">' + (on ? '启用' : '已停用') + '</div>' +
      '<div class="arw">›</div></div>';
  }

  /* 切站点：写 lastSite（启动恢复用）+ 切到浏览 Tab 并加载该站点（docs/07 T-1 规则） */
  function openSite(id) {
    DB._set('lastSite', id);
    App.siteId = id;
    App.stacks.browse = [];        // 回浏览根，避免停在上一个站点的详情页
    App.setTab('browse');
  }

  /* V-01 站点切换浮层 */
  function openSitePicker() {
    const all = DB.sites();
    const sites = all.filter(s => s.enabled !== false);
    if (!all.length) return App.go('newscript');
    if (!sites.length) {
      UI.sheet('<div class="sheet-hd">切换站点</div><div class="d1-note" style="padding:12px">没有启用中的站点；停用站点不会出现在快捷切换里。</div>' +
        '<div class="row tap" data-pick="__manage"><div class="t"><div class="nm">管理脚本</div><div class="ds">启用站点</div></div><div class="arw">›</div></div>',
        { onOpen: pb => { const x = $('[data-pick]', pb); if (x) x.onclick = () => { UI.closeSheet(); App.go('scripts') }; } });
      return;
    }
    const rows = sites.map(s => {
      return '<div class="row tap" data-pick="' + esc(s.id) + '">' +
        '<div class="ico sico">' + iconHTML(s) + '</div>' +
        '<div class="t"><div class="nm">' + esc(s.name || s.id) + '</div>' +
        '<div class="ds">' + esc(hostOf(s.site) || '未设置域名') + '</div></div>' +
        '<div class="tag">启用</div>' +
        '<div class="arw">' + (s.id === App.siteId ? '✓' : '') + '</div></div>';
    }).join('');
    UI.sheet('<div class="sheet-hd">切换站点</div>' + rows +
      '<div class="row tap" data-pick="__manage"><div class="t"><div class="nm">管理脚本</div>' +
      '<div class="ds">新建 / 启停 / 编辑站点脚本</div></div><div class="arw">›</div></div>',
      {
        onOpen: pb => {
          $$('[data-pick]', pb).forEach(node => {
            node.onclick = () => {
              const id = node.dataset.pick;
              UI.closeSheet();
              if (id === '__manage') return App.go('scripts');
              openSite(id);
            };
          });
        }
      });
  }

  /* ---------------- 长按手势（站点卡 / 历史卡通用） ----------------
     判定：touchstart 记时；按住 ≥500ms 触发；位移 >10px 或 500ms 内抬起 → 不触发。
     触发后立刻打 suppressClick 标记，让随后的 click 被吞掉（否则会又切站点 / 又进详情）。
     桌面与无头验收：右键 contextmenu 打开同一菜单。 */
  function bindLongPress(nodes, onLong) {
    (nodes || []).forEach(node => {
      /* 包一层 click：先看长按标记，再走原来的点击逻辑 */
      const orig = node.onclick;
      node.onclick = () => {
        if (node._lpSuppress) { node._lpSuppress = false; clearTimeout(node._lpTimer); return }
        if (orig) orig.call(node);
      };
      let timer = null;
      let sx = 0, sy = 0, fired = false;

      const cancel = () => { if (timer) { clearTimeout(timer); timer = null } };
      const pointOf = e => {
        const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || null;
        return t ? { x: t.clientX || 0, y: t.clientY || 0 } : null;
      };

      node.addEventListener('touchstart', e => {
        cancel();
        fired = false;
        const p = pointOf(e);
        sx = p ? p.x : 0; sy = p ? p.y : 0;
        timer = setTimeout(() => {
          timer = null;
          fired = true;
          suppressClick(node);
          try { if (navigator.vibrate) navigator.vibrate(10) } catch (err) { }   // 轻震反馈（无桥静默）
          Log.info('长按: ' + (node.dataset.site || node.dataset.url || ''));
          onLong(node);
        }, LONG_MS);
      }, { passive: true });

      /* move 用 passive 监听：只判断位移，不抢滚动手势 */
      node.addEventListener('touchmove', e => {
        if (fired || !timer) return;
        const p = pointOf(e);
        if (!p) return;
        if (Math.abs(p.x - sx) > MOVE_PX || Math.abs(p.y - sy) > MOVE_PX) cancel();
      }, { passive: true });

      node.addEventListener('touchend', e => {
        if (fired) { fired = false; try { e.preventDefault() } catch (err) { } return }   // 已触发：压掉合成 click
        cancel();      // 500ms 内抬起 → 视为点击，交给原 click
      });
      node.addEventListener('touchcancel', () => { cancel(); fired = false });

      /* 桌面调试 / 右键：等价长按 */
      node.addEventListener('contextmenu', e => {
        e.preventDefault();
        cancel();
        suppressClick(node);
        onLong(node);
      });
    });
  }

  function suppressClick(node) {
    node._lpSuppress = true;
    clearTimeout(node._lpTimer);
    node._lpTimer = setTimeout(() => { node._lpSuppress = false }, SUPPRESS_MS);
  }

  /* ---------------- 站点操作菜单（我的站点 → 长按） ---------------- */
  function openSiteMenu(id) {
    const s = DB.site(id);
    if (!s) return UI.toast('站点已删除');
    const on = s.enabled !== false;
    UI.closeSheet();      // 每次打开前先关，避免叠层

    const rows = [
      UI.row({ icon: '▶', title: '打开站点', desc: '进入浏览页并加载该站内容', arrow: true, act: 'open' }),
      UI.row({
        icon: on ? '⏸' : '✓',
        title: on ? '停用站点' : '启用站点',
        desc: on ? '停用后点卡不再加载' : '重新启用该站点',
        arrow: true, act: 'toggle'
      }),
      UI.row({ icon: '✎', title: '编辑脚本', desc: '修改该站点的解析脚本', arrow: true, act: 'edit' }),
      UI.row({ icon: '⚙', title: '站点配置', desc: '查看站点参数与运行状态', arrow: true, act: 'cfg' }),
      UI.row({
        icon: '★', title: '设为默认站点',
        desc: '下次启动自动载入该站点',
        right: s.id === (DB._get('defaultSite', null) || DB._get('lastSite', null)) ? '当前' : '',
        arrow: true, act: 'default'
      }),
      UI.row({ icon: '🧹', title: '清理该站点缓存', desc: cacheDesc(s.id), act: 'clear' }),
      UI.row({ icon: '🗑', title: '删除站点', desc: '删除脚本与缓存，不可恢复', danger: true, act: 'del' })
    ].join('');

    UI.sheet(
      '<div class="sheet-hd lp-hd">' +
      '<div class="lp-ic">' + iconHTML(s) + '</div>' +
      '<div class="lp-t"><div class="lp-nm">' + esc(s.name || s.id) + '</div>' +
      '<div class="lp-ds">' + esc(hostOf(s.site) || '未设置域名') + ' · ' + (on ? '启用中' : '已停用') + '</div></div>' +
      '<div class="lp-tag">' + (on ? '启用' : '停用') + '</div></div>' +
      '<div class="rows">' + rows + '</div>' +
      '<div class="lp-cancel">' + UI.row({ icon: '✕', title: '取消', desc: '关闭菜单', act: 'close' }) + '</div>',
      {
        onOpen: pb => {
          /* 统一加 tap 反馈（UI.row 只在 arrow 时自带 tap） */
          $$('.row', pb).forEach(r => r.classList.add('tap'));
          $$('[data-act]', pb).forEach(row => {
            row.onclick = () => {
              const act = row.dataset.act;
              if (act === 'close') return UI.closeSheet();
              UI.closeSheet();
              if (act === 'open') return openSite(s.id);
              if (act === 'toggle') {
                App.siteToggle(s.id);
                const nowOn = (DB.site(s.id) || {}).enabled !== false;
                UI.toast(nowOn ? '已启用' : '已停用');
                return;
              }
              if (act === 'edit') return App.go('scriptEdit', { id: s.id });
              if (act === 'cfg') return App.go('scriptDetail', { id: s.id });
              if (act === 'default') {
                DB._set('defaultSite', s.id);
                return UI.toast('已设为默认');
              }
              if (act === 'clear') return clearSiteCache(s.id);
              if (act === 'del') return askDelSite(s);
            };
          });
        }
      });
  }

  function cacheDesc(id) {
    const n = siteCacheBytes(id);
    return n > 0 ? '当前缓存 ' + fmtSize(n) : '暂无缓存';
  }

  /* 该站点缓存 key：rouparser.cache.<id>.<name>（browse.js 写入） */
  function siteCacheKeys(id) {
    const out = [];
    try {
      const pre = DB.NS + 'cache.' + id + '.';
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(pre) === 0) out.push(k);
      }
    } catch (e) { Log.err('枚举站点缓存失败: ' + e.message) }
    return out;
  }

  function siteCacheBytes(id) {
    let n = 0;
    try {
      siteCacheKeys(id).forEach(k => { n += (k.length + (localStorage.getItem(k) || '').length) * 2 });
    } catch (e) { Log.err('统计站点缓存失败: ' + e.message) }
    return n;
  }

  /* 只清这个站点的缓存；顺手刷新首页「缓存」格数字 */
  function clearSiteCache(id) {
    const keys = siteCacheKeys(id);
    let bytes = 0;
    try {
      keys.forEach(k => {
        bytes += (k.length + (localStorage.getItem(k) || '').length) * 2;
        localStorage.removeItem(k);
      });
    } catch (e) { Log.err('清理站点缓存失败: ' + e.message) }

    const cnt = $('.tile[data-tile=cache] .cnt');
    if (cnt) cnt.textContent = fmtSize(cacheBytes());

    if (!keys.length) return UI.toast('没有缓存');
    UI.toast('已清理 ' + fmtSize(bytes));
  }

  function askDelSite(s) {
    const nm = s.name || s.id;
    UI.dialog({
      title: '删除站点',
      msg: '「' + nm + '」的脚本和缓存会被一并删除，删除后不可恢复。',
      okText: '删除',
      danger: true,
      onOk: () => {
        App.siteRemove(s.id);
        UI.toast('已删除');
      }
    });
  }

  /* ---------------- 继续观看（128px 横滑卡 + 进度条） ---------------- */
  function renderCont(body) {
    /* 取历史前 6 条，其中带播放进度的排前面（ES2019 起 sort 稳定，同组保持时间顺序） */
    const rows = DB.hist().slice(0, 6).map(it => ({ it: it, p: progressOf(it) }));
    rows.sort((a, b) => (b.p ? 1 : 0) - (a.p ? 1 : 0));
    if (!rows.length) return;      // 无历史 → 隐藏整块（docs/07）

    const head = el('div', 'sec');
    head.innerHTML = '<div class="sec-h"><h3>继续观看</h3><s class="more" data-all>全部 ›</s></div>';
    body.appendChild(head);
    const all = $('[data-all]', head);
    if (all) all.onclick = () => { LS.set(FAV_SEG_KEY, 'hist'); App.setTab('fav') };

    const box = el('div', 'hscroll');
    box.innerHTML = rows.map(contCardHTML).join('');
    body.appendChild(box);

    $$('[data-url]', box).forEach(node => {
      node.onclick = () => {
        const url = node.dataset.url;
        if (!url) return UI.toast('缺少详情地址');
        App.go('detail', { url: url, site: node.dataset.site || App.siteId, resume: true });
      };
    });
    /* 长按历史卡 → 历史操作菜单；右键等价 */
    bindLongPress($$('[data-url]', box), node => openHistMenu(node.dataset.url));
  }

  /* ---------------- 历史操作菜单（继续观看 → 长按） ---------------- */
  function openHistMenu(url) {
    if (!url) return UI.toast('缺少详情地址');
    const it = DB.hist().filter(x => x.url === url)[0];
    if (!it) return UI.toast('记录已删除');
    const site = it.site || App.siteId || '';

    /* 进度：优先 DB.lastProgress(site, id || url)，历史条目自带的 pos 兜底 */
    let p = null;
    const cid = it.id || it.url || '';
    try { p = (site && cid) ? DB.lastProgress(site, cid) : null } catch (e) { p = null }
    const pos = (p && p.pos) || it.pos || 0;
    const faved = DB.isFav(it.url);
    UI.closeSheet();      // 每次打开前先关，避免叠层

    const rows = [
      UI.row({
        icon: '▶', title: '继续播放',
        desc: pos > 0 ? '从 ' + fmtTime(pos) + ' 继续' : '从头开始播放',
        arrow: true, act: 'play'
      }),
      UI.row({ icon: 'ℹ', title: '查看详情', desc: '打开详情页再选集', arrow: true, act: 'detail' }),
      UI.row({
        icon: faved ? '♥' : '♡',
        title: faved ? '取消收藏' : '收藏',
        desc: faved ? '从收藏里移除' : '加入我的收藏',
        arrow: true, act: 'fav'
      }),
      UI.row({ icon: '🗑', title: '删除这条历史', desc: '只删这一条记录', danger: true, act: 'delone' }),
      UI.row({ icon: '🧹', title: '清空全部历史', desc: '共 ' + DB.hist().length + ' 条，不可恢复', danger: true, act: 'clear' })
    ].join('');

    UI.sheet(
      '<div class="sheet-hd lp-hd">' +
      (it.pic ? '<div class="lp-ic"><img src="' + esc(it.pic) + '" alt="" onerror="this.remove()"></div>' : '') +
      '<div class="lp-t"><div class="lp-nm">' + esc(it.title || '未命名') + '</div>' +
      '<div class="lp-ds">' + esc(pos > 0 ? '看到 ' + fmtTime(pos) : '未开始') + ' · ' +
      esc(ago(it.at) || '观看记录') + '</div></div></div>' +
      '<div class="rows">' + rows + '</div>' +
      '<div class="lp-cancel">' + UI.row({ icon: '✕', title: '取消', desc: '关闭菜单', act: 'close' }) + '</div>',
      {
        onOpen: pb => {
          $$('.row', pb).forEach(r => r.classList.add('tap'));
          $$('[data-act]', pb).forEach(row => {
            row.onclick = () => {
              const act = row.dataset.act;
              if (act === 'close') return UI.closeSheet();
              UI.closeSheet();
              if (act === 'play') {
                return App.go('player', {
                  site: site, url: it.url, id: it.id || it.url,
                  title: it.title || '视频', startPos: pos
                });
              }
              if (act === 'detail') {
                return App.go('detail', { url: it.url, site: site, resume: true });
              }
              if (act === 'fav') {
                const added = DB.toFav({
                  site: site, title: it.title || '', pic: it.pic || '', url: it.url
                });
                return UI.toast(added ? '已收藏' : '已取消收藏');
              }
              if (act === 'delone') {
                /* 只删这一条：过滤后整表写回（不用 clearHist） */
                DB._set('hist', DB.hist().filter(x => x.url !== it.url));
                App.renderTab();
                return UI.toast('已删除');
              }
              if (act === 'clear') return askClearAllHist();
            };
          });
        }
      });
  }

  function askClearAllHist() {
    const n = DB.hist().length;
    UI.dialog({
      title: '清空全部历史',
      msg: '共 ' + n + ' 条观看记录，清空后不可恢复。',
      okText: '清空',
      danger: true,
      onOk: () => {
        DB.clearHist();
        App.renderTab();
        UI.toast('已清空');
      }
    });
  }

  function contCardHTML(r) {
    const it = r.it || {};
    const p = r.p;
    const pct = p ? (p.dur ? Math.min(100, Math.round(p.pos / p.dur * 100)) : 0) : 0;
    const pic = it.pic
      ? '<img loading="lazy" src="' + esc(it.pic) + '" alt="" onerror="this.style.display=\'none\'">'
      : '<div class="phg phg-full"></div>';
    const meta = p ? '<div class="prog"><i style="width:' + pct + '%"></i></div>' +
      '<div class="pt">看到 ' + fmtTime(p.pos) + '</div>'
      : '<div class="pt">' + esc(ago(it.at)) + '</div>';
    return '<div class="cont" data-url="' + esc(it.url || '') + '" data-site="' + esc(it.site || '') + '">' +
      '<div class="ph">' + pic + '</div>' +
      '<div class="tt">' + esc(it.title || '未命名') + '</div>' + meta + '</div>';
  }

  /* ---------------- 公告条 ---------------- */
  function renderNotice(body) {
    const offline = navigator.onLine === false;
    const txt = offline
      ? '网络不可用 · 点此去设置网络'
      : '站点网络：' + netModeName((DB.cfg().net || {}).mode) + ' · 网络异常时点此调整';
    const box = el('div', 'notice');
    box.innerHTML = '<div class="ni">📡</div><div class="nt" data-net>' + esc(txt) + '</div>' +
      '<div class="nx" data-close>✕</div>';
    body.appendChild(box);
    $('[data-net]', box).onclick = () => App.go('settings.net');
    $('[data-close]', box).onclick = () => {
      LS.set(NOTICE_KEY, '1');
      box.remove();
      UI.toast('已隐藏公告');
    };
  }

  function applyHomeBg(root) {
    const hc = DB.cfg().home || {};
    const bg = hc.bgPath ? ('file://' + hc.bgPath) : (hc.bgData || '');
    if (!bg) {
      root.classList.remove('has-bg');
      root.style.backgroundImage = '';
      return;
    }
    root.classList.add('has-bg');
    root.style.backgroundImage = 'linear-gradient(rgba(8,11,15,.72), rgba(8,11,15,.9)), url("' + bg + '")';
    root.style.backgroundSize = 'cover';
    root.style.backgroundPosition = 'center top';
  }

  function compressImage(file, cb) {
    const fr = new FileReader();
    fr.onload = function () {
      const img = new Image();
      img.onload = function () {
        const max = 1600;
        let w = img.width, h = img.height;
        if (w > max || h > max) {
          const k = Math.min(max / w, max / h);
          w = Math.round(w * k); h = Math.round(h * k);
        }
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cb(cv.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { cb(''); };
      img.src = fr.result;
    };
    fr.onerror = function () { cb(''); };
    fr.readAsDataURL(file);
  }

  function openBgSheet() {
    const hc = DB.cfg().home || {};
    UI.sheet('<div class="sheet-hd">主页背景图</div>' +
      '<div class="rows"><div class="row"><div class="t"><div class="nm">当前</div>' +
      '<div class="ds">' + (hc.bgData ? '已缓存到本地，启动不再重复请求' : '未设置') + '</div></div></div></div>' +
      '<div class="d1-pad"><div class="d1-note">在线地址：第一次下载后缓存到本地，只有 URL 变化才重新请求。</div>' +
      '<input class="input" data-bg-url placeholder="https://…/bg.jpg" value="' + esc(hc.bgUrl && hc.bgUrl.indexOf('local:') !== 0 ? hc.bgUrl : '') + '">' +
      '<div class="d1-steprow"><button class="btn ghost" data-bg-file>选择本地图片</button>' +
      '<button class="btn pri" data-bg-url-save>缓存在线图</button></div>' +
      '<input type="file" accept="image/*" data-bg-input style="display:none">' +
      '<div class="d1-steprow"><button class="btn ghost" data-bg-clear>清除背景</button>' +
      '<button class="btn ghost" data-bg-close>关闭</button></div></div>',
      {
        onOpen: function (pb) {
          $('[data-bg-close]', pb).onclick = function () { UI.closeSheet() };
          $('[data-bg-clear]', pb).onclick = function () {
            DB.setCfg({ home: { bgUrl: '', bgData: '' } });
            UI.closeSheet(); App.renderTab(); UI.toast('已清除背景');
          };
          $('[data-bg-file]', pb).onclick = function () { $('[data-bg-input]', pb).click() };
          $('[data-bg-input]', pb).onchange = function (e) {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            UI.toast('正在压缩…');
            compressImage(f, function (data) {
              if (!data) { UI.toast('图片读取失败'); return }
              var nm = 'local_' + Date.now();
              var saved = null;
              try { if (window.Native && Native.saveImageData) { var raw = Native.saveImageData(nm, data); saved = raw ? JSON.parse(raw) : null; } } catch (e) { }
              if (saved && saved.ok && saved.path) DB.setCfg({ home: { bgUrl: 'local:' + nm, bgPath: saved.path, bgData: '' } });
              else DB.setCfg({ home: { bgUrl: 'local:' + nm, bgPath: '', bgData: data } });
              UI.closeSheet(); App.renderTab(); UI.toast('本地背景已保存');
            });
          };
          $('[data-bg-url-save]', pb).onclick = function () {
            const u = String($('[data-bg-url]', pb).value || '').trim();
            if (!/^https?:\/\//i.test(u)) { UI.toast('请输入 http(s) 图片地址'); return }
            if (hc.bgUrl === u && (hc.bgPath || hc.bgData)) { UI.closeSheet(); UI.toast('地址未变，使用已缓存图片'); return }
            if (!(window.Native && Native.imgFetch)) { UI.toast('当前版本不支持后台下载'); return }
            var token = 'bg_' + Date.now();
            window.__imgFetch = function (id, raw) {
              if (id !== token) return;
              var j = null;
              try { j = JSON.parse(raw || '{}'); } catch (e) { }
              if (j && j.ok && j.path) {
                DB.setCfg({ home: { bgUrl: u, bgPath: j.path, bgData: '' } });
                UI.closeSheet(); App.renderTab(); UI.toast('已缓存到本地');
              } else {
                UI.toast('下载失败：' + ((j && j.err) || 'unknown'));
              }
            };
            UI.toast('已开始下载，完成后自动应用…');
            try { Native.imgFetch(u, 'bg_' + Date.now(), token); }
            catch (e) { UI.toast('下载失败'); }
          };
        }
      });
  }

  /* ---------------- V-09 主页自定义（5 开关 + 2 组布局，即时生效） ---------------- */
  function scopeCustomCss(css) {
    return String(css || '').replace(/(^|\})\s*([^{}@]+?)\s*\{/g, function (all, pre, sel) {
      if (/^\s*@/.test(sel) || /:root|^html|^body/.test(sel)) return all;
      var parts = sel.split(',').map(function (x) {
        x = x.trim().replace(/^\.home-custom\b/, '');
        return x ? '#home-custom-block ' + x : '#home-custom-block';
      });
      return pre + ' ' + parts.join(', ') + ' {';
    });
  }

  function openCustomize() {
    const hc = DB.cfg().home || {};
    const orderNames = { welcome: '欢迎语', tiles: '功能卡', sites: '我的站点', cont: '继续观看', custom: '自定义区块', notice: '公告' };
    const orderNow = Array.isArray(hc.order) && hc.order.length
      ? hc.order.filter(k => orderNames[k]).concat(Object.keys(orderNames).filter(k => hc.order.indexOf(k) < 0))
      : Object.keys(orderNames);
    const orderRows = orderNow.map(function (k, i) {
      return '<div class="row"><div class="t"><div class="nm">' + orderNames[k] + '</div></div>' +
        '<button class="btn mini" data-mv="' + k + '" data-dir="-1"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button class="btn mini" data-mv="' + k + '" data-dir="1"' + (i === orderNow.length - 1 ? ' disabled' : '') + '>↓</button></div>';
    }).join('');
    const sw = (title, key) => UI.switchRow({ title: title, on: !!hc[key], act: 'h_' + key });
    const seg = (key, items) => '<div class="seg lg" data-segkey="' + key + '">' +
      items.map(x => '<b data-v="' + x.v + '" class="' + ((hc[key] || x.d) === x.v ? 'on' : '') + '">' +
        x.n + '</b>').join('') + '</div>';

    UI.sheet(
      '<div class="sheet-hd">主页自定义</div>' +
      '<div class="rows"><div class="grp">显示模块</div>' +
      sw('欢迎语', 'welcome') + sw('功能卡', 'tiles') + sw('我的站点', 'sites') +
      sw('继续观看', 'cont') + sw('公告', 'notice') + '</div>' +
      '<div class="sh-grp">布局变量</div>' +
      '<div class="d1-pad"><input class="input" id="homeHeroH" type="number" placeholder="轮播高度 dp" value="' + esc(DB.cfg().heroH || 200) + '">' +
      '<input class="input" id="homeGridCols" type="number" placeholder="卡片列数 2/3" value="' + esc(DB.cfg().gridCols || 2) + '"></div>' +
      '<div class="sh-grp">欢迎语</div>' +
      '<div class="d1-pad"><input class="input" id="homeWelcomeTitle" placeholder="标题" value="' + esc(hc.welcomeTitle || '可编程解析客户端') + '">' +
      '<textarea class="input" id="homeWelcomeText" rows="3" placeholder="欢迎语内容，可留空">' + esc(hc.welcomeText || '') + '</textarea></div>' +
      '<div class="sh-grp">自定义区块</div>' +
      '<div class="d1-pad"><div class="home-code-wrap">' +
      '<div class="home-code-tools"><button class="btn ghost mini home-code-edit" id="homeCodeEdit">编辑器</button>' +
      '<button class="btn ghost mini home-css-edit" id="homeCssEdit">CSS</button></div>' +
      '<textarea class="input" id="homeCustomCode" rows="7" placeholder="直接写 HTML；JS 以 js: 开头并 return HTML；Python 以 py: 开头并返回字符串。">' + esc(hc.customCode || hc.customHtml || '') + '</textarea></div>' +
      '<div class="home-save-return">' +
      '<label><input type="radio" name="homeSaveReturn" value="home"' + ((hc.saveReturn || 'current') === 'home' ? ' checked' : '') + '>主页</label>' +
      '<label><input type="radio" name="homeSaveReturn" value="settings"' + (hc.saveReturn === 'settings' ? ' checked' : '') + '>设置页</label>' +
      '<label><input type="radio" name="homeSaveReturn" value="current"' + ((hc.saveReturn || 'current') === 'current' ? ' checked' : '') + '>当前页</label></div>' +
      '<button class="btn ghost block" id="homeSaveText">保存区块脚本</button></div>' +
      '<div class="sh-grp">模块顺序</div><div class="rows">' + orderRows + '</div>' +
      '<div class="sh-grp">功能卡布局</div>' +
      seg('tilesLayout', [{ v: '3x2', n: '3×2', d: '3x2' }, { v: 'cols4', n: '一行四个' }, { v: 'cols2', n: '两行两列' }]) +
      '<div class="sh-grp">站点布局</div>' +
      seg('siteLayout', [{ v: 'list', n: '列表卡片', d: 'list' }, { v: 'grid', n: '网格卡片' }]) +
      '<div class="sh-grp">背景</div>' +
      '<div class="rows"><div class="row tap" data-bg><div class="t"><div class="nm">主页背景图</div>' +
      '<div class="ds">本地或在线；缓存后不重复请求</div></div><div class="arw">›</div></div></div>' +
      '<div class="sh-act"><button class="btn pri block" data-done>完成</button></div>',
      {
        onOpen: pb => {
          /* 开关：点一下立即写配置 + 重渲染主页（浮层在 #sheet 里，不受重渲染影响） */
          $$('.row[data-act]', pb).forEach(row => {
            const act = row.dataset.act || '';
            if (act.indexOf('h_') !== 0) return;
            row.onclick = () => {
              const key = act.slice(2);
              const on = !DB.cfg().home[key];
              const patch = { home: {} };
              patch.home[key] = on;
              DB.setCfg(patch);
              const swEl = $('.switch', row);
              if (swEl) swEl.classList.toggle('on', on);
              if (key === 'notice' && on) LS.del(NOTICE_KEY);   // 重新打开公告时清掉「已关闭」
              App.renderTab();
            };
          });
          function afterEditorSave() {
            var dest = (DB.cfg().home || {}).saveReturn || 'current';
            if (dest === 'home') { UI.closeSheet(); App.setTab('home'); App.home(); }
            else if (dest === 'settings') { UI.closeSheet(); App.go('settings'); }
          }
          $$('input[name=homeSaveReturn]', pb).forEach(function (r) {
            r.onchange = function () {
              if (!r.checked) return;
              DB.setCfg({ home: { saveReturn: r.value } });
            };
          });
          var saveText = $('#homeSaveText', pb);
          if (saveText) saveText.onclick = function () {
            DB.setCfg({ heroH: Math.max(120, Math.min(320, +($('#homeHeroH', pb).value || 200))), gridCols: (+($('#homeGridCols', pb).value || 2) === 3 ? 3 : 2), home: {
              welcomeTitle: String($('#homeWelcomeTitle', pb).value || '').trim(),
              welcomeText: String($('#homeWelcomeText', pb).value || '').trim(),
              customCode: String($('#homeCustomCode', pb).value || ''),
              customHtml: ''
            } });
            App.invalidateHome();
            if (App.tab === 'home') App.renderTab();
            UI.toast('主页已保存');
            afterEditorSave();
          };
          var codeEdit = $('#homeCodeEdit', pb);
          if (codeEdit) codeEdit.onclick = function () {
            var cur = String($('#homeCustomCode', pb).value || '');
            var lang = /^py:/i.test(cur) ? 'py' : (/^js:/i.test(cur) ? 'js' : 'html');
            UI.openCodeEditor({
              title: '编辑自定义区块', value: cur, lang: lang,
              filename: lang === 'py' ? 'main.py' : (lang === 'html' ? 'index.html' : 'index.js'),
              onSave: function (v) {
                DB.setCfg({ home: { customCode: v, customHtml: '' } });
                var box = $('#homeCustomCode', pb); if (box) box.value = v;
                App.invalidateHome();
                if (App.tab === 'home') App.renderTab();
                UI.toast('自定义区块已保存');
              }
            });
          };
          var cssEdit = $('#homeCssEdit', pb);
          if (cssEdit) cssEdit.onclick = function () {
            UI.openCodeEditor({
              title: '编辑此区块 CSS',
              value: String((DB.cfg().home || {}).customCss || ''),
              lang: 'css', filename: 'style.css',
              onSave: function (v) {
                DB.setCfg({ home: { customCss: v } });
                App.invalidateHome();
                if (App.tab === 'home') App.renderTab();
                UI.toast('区块 CSS 已保存');
              }
            });
          };
          /* 模块顺序：上移/下移，立即写 home.order */
          $$('[data-mv]', pb).forEach(function (btn) {
            btn.onclick = function () {
              const k = btn.dataset.mv, dir = +(btn.dataset.dir || 0);
              const cur = DB.cfg().home || {};
              let arr = Array.isArray(cur.order) && cur.order.length ? cur.order.slice() : Object.keys(orderNames);
              arr = arr.filter(x => orderNames[x]).concat(Object.keys(orderNames).filter(x => arr.indexOf(x) < 0));
              const i = arr.indexOf(k), j = i + dir;
              if (i < 0 || j < 0 || j >= arr.length) return;
              const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
              DB.setCfg({ home: { order: arr } });
              App.renderTab();
              UI.closeSheet();
              setTimeout(openCustomize, 80);
            };
          });
          /* 布局二选一 / 三选一 */
          $$('[data-segkey]', pb).forEach(box => {
            const key = box.dataset.segkey;
            $$('b', box).forEach(b => {
              b.onclick = () => {
                $$('b', box).forEach(x => x.classList.remove('on'));
                b.classList.add('on');
                const patch = {};
                patch[key] = b.dataset.v;
                const p2 = { home: patch };
                DB.setCfg(p2);
                App.renderTab();
              };
            });
          });
          const done = $('[data-done]', pb);
          if (done) done.onclick = () => { UI.closeSheet(); App.renderTab(); };
          const bgRow = $('[data-bg]', pb);
          if (bgRow) bgRow.onclick = function () { UI.closeSheet(); openBgSheet(); };
        }
      });
  }

  /* 供 T-4「我的 → 主页布局」复用同一个 V-09 浮层（个人中心/设置复用同一个 V-09 浮层） */
  App.tabs['home'].openCustomize = openCustomize;

})();
