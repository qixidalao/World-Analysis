/* core.js — 基础设施：DOM 工具 / 路由（每 Tab 一条栈）/ 7 态状态机 / 公共 UI
   契约见 docs/dev-frontend-conventions.md。页面文件只许调用这里导出的 App / UI / DB / Net / Engine。 */

/* ---------------- 基础工具 ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const dec = s => { try { return decodeURIComponent(s) } catch (e) { return s } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 9);
const has = v => v != null && v !== '';

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
function fmtSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}
function ago(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
  return new Date(ts).toLocaleDateString();
}
const now = () => Date.now();

/* 简易时间戳日志（P-18 数据源，环形 500 条；落盘见 DB） */
const Log = {
  buf: [],
  add(level, msg) {
    const rec = { t: now(), lv: level, msg: String(msg) };
    this.buf.push(rec); if (this.buf.length > 500) this.buf.shift();
    try { DB.pushLog(rec) } catch (e) { }
    /* 同步打到 console：真机上 adb logcat 能看到 "CONSOLE" 行，便于联调 */
    try { console.log('[' + level + '] ' + rec.msg) } catch (e) { }
    return rec;
  },
  ok(m) { return this.add('ok', m) },
  info(m) { return this.add('info', m) },
  err(m) { return this.add('err', m) },
  all() { return this.buf.slice() },
  clear() { this.buf = [] }
};

/* ---------------- 路由 ---------------- */
const App = {
  tab: 'home',
  TABS: ['home', 'browse', 'fav', 'mine'],
  stacks: { home: [], browse: [], fav: [], mine: [] },
  pages: {},          // name -> render(root, params)
  tabs: {},           // tab -> render(root)
  siteId: null,       // 当前站点（站点层）
  _seq: 0,
  _covered: null,     // 压栈时暂存的 Tab 根节点（返回时原样放回，不重渲染）
  _homeDirty: false,
  /* 状态树：所有跨页面状态都从这里派生；改站点只走 afterSiteChange */
  stateTree: {
    sites: {
      list: { source: 'DB.sites()', owner: 'scripts/home/settings' },
      enabled: { source: 'site.enabled !== false' },
      active: { source: 'App.siteId', rule: '必须为空或启用站点', derive: 'ensureActiveSite()' },
      switcher: { depends: ['sites.enabled', 'sites.active'], filter: 'only enabled' }
    },
    home: {
      cards: { depends: ['sites.list'] },
      background: { source: 'DB.cfg().home.bgData', cache: 'data URL' },
      dirty: { source: 'App._homeDirty' }
    },
    settings: {
      browseCache: { source: 'DB.cfg().browseCache', default: 30, range: '0..1440' },
      python: { source: 'Py.info()', default: '未接入' }
    },
    editor: {
      files: { source: 'site.files', entry: 'site.entry' },
      config: { source: 'site.config/config.json/config.js' },
      dirty: { source: 'site script' }
    }
  },

  /* 第 2 层页面：压栈 */
  go(name, params) {
    if (!this.pages[name]) { console.warn('no page', name); return }
    const st = this.stacks[this.tab];
    const box = $('#pageview');
    if (st.length) {
      const top = st[st.length - 1];
      top.scroll = box.scrollTop || 0;
      if (!top.node) top.node = box.firstElementChild;
    } else {
      /* 从 Tab 进入页面：暂存 Tab 的 DOM 和滚动位置 */
      this._covered = {
        tab: this.tab,
        node: $('#tabview').firstElementChild,
        scroll: $('#tabview').scrollTop || 0
      };
    }
    this._seq++;
    st.push({ name, params: params || {}, key: this._seq, scroll: 0 });
    Log.info('→ ' + name + (params && (params.url || params.id) ? ' ' + (params.url || ('#' + params.id)) : ''));
    this.renderPage();
  },
  /* 返回上一层 */
  back() {
    /* 编辑器未保存守卫：返回 true 表示它已经处理（弹确认框） */
    if (typeof window.__editGuard === 'function' && window.__editGuard()) return true;
    const st = this.stacks[this.tab];
    if (!st.length) return false;
    const top = st[st.length - 1];
    try { top.cleanup && top.cleanup() } catch (e) { }
    if (st.length) st[st.length - 1].cleanup = null;
    st.pop();
    this.renderPage();
    if (!st.length) this.renderTab();
    return true;
  },
  /* 替换栈顶（详情→另一详情 之类） */
  replace(name, params) {
    const st = this.stacks[this.tab];
    if (st.length) {
      const top = st[st.length - 1];
      try { top.cleanup && top.cleanup() } catch (e) { }
      st.pop();
    }
    this._seq++;
    st.push({ name, params: params || {}, key: this._seq, scroll: 0 });
    this.renderPage();
  },
  /* 清空当前 Tab 栈回到根 */
  /* 应用结构树：给自检/调试/文档用，所有信息从同一处派生 */
  tree() {
    let packs = null;
    try { packs = window.Packs ? Packs.audit() : null; } catch (e) { }
    return {
      app: {
        info: this.info || {},
        tabs: Object.keys(this.tabs || {}),
        pages: Object.keys(this.pages || {}),
        packs: packs,
        state: this.stateTree
      },
      runtime: {
        native: !!window.Native,
        python: (window.Py && Py.available && Py.available()) ? Py.info() : null,
        webview: navigator.userAgent
      }
    };
  },

  /* 当前站点必须始终是启用站点；没有启用站点则为空 */
  ensureActiveSite() {
    const cur = this.siteId ? DB.site(this.siteId) : null;
    if (cur && cur.enabled !== false) return cur;
    const first = (DB.sites() || []).filter(s => s.enabled !== false)[0] || null;
    this.siteId = first ? first.id : null;
    DB._set('lastSite', this.siteId || '');
    return first;
  },

  /* 所有站点变更的唯一入口：DB 写入后刷新当前站点、主页、浏览顶栏 */
  afterSiteChange(reason, preferId) {
    this.refreshSites(preferId);
    const d = DB._get('defaultSite', null);
    const ds = d ? DB.site(d) : null;
    if (!ds || ds.enabled === false) DB._set('defaultSite', this.siteId || '');
    this._lastSiteChange = { reason: reason || '', at: Date.now() };
    try { Log.info('站点状态变更 ' + (reason || '') + ' → ' + (this.siteId || '(none)')); } catch (e) { }
    if (this.tab === 'home' && !this.stacks.home.length) this.renderTab();
  },
  siteSetEnabled(id, on) {
    DB.saveSite({ id: id, enabled: !!on });
    this.afterSiteChange((on ? 'enable:' : 'disable:') + id, on ? id : null);
  },
  siteToggle(id) {
    DB.toggleSite(id);
    const s = DB.site(id);
    this.afterSiteChange('toggle:' + id, s && s.enabled !== false ? id : null);
  },
  siteRemove(id) {
    DB.delSite(id);
    try { Engine.invalidate(id); } catch (e) { }
    this.afterSiteChange('remove:' + id);
  },
  /* 结构化自检：返回 {ok, checks:{domain:{...}}}；控制和数据不同步时可直接定位 */
  auditState() {
    const sites = DB.sites() || [];
    const enabled = sites.filter(s => s.enabled !== false);
    const active = this.siteId ? DB.site(this.siteId) : null;
    const ids = {};
    let dup = false;
    sites.forEach(s => { if (ids[s.id]) dup = true; ids[s.id] = 1; });
    const homeCards = (this.tab === 'home') ? $$('#tabview [data-site]', document) : [];
    const homeIds = homeCards.map(el => el.dataset.site);
    const checks = {
      sites: {
        activeExists: !this.siteId || !!active,
        activeEnabled: !active || active.enabled !== false,
        hasEnabledWhenSites: !sites.length || enabled.length > 0 ? true : this.siteId == null,
        idsUnique: !dup,
        activeInEnabled: !active || enabled.some(s => s.id === active.id),
        homeMatchesActiveWhenHome: this.tab !== 'home' || !active || homeIds.indexOf(active.id) >= 0
      },
      home: {
        disabledCardsVisible: homeCards.filter(el => {
          const s = DB.site(el.dataset.site);
          return s && s.enabled === false;
        }).length === homeCards.length ? 'all' : 'some'
      },
      settings: {
        cacheTtlValid: (() => { const v = Number(DB.cfg().browseCache); return isFinite(v) && v >= 0 && v <= 1440; })(),
        pythonReady: !!(window.Py && Py.available())
      },
      editor: {
        filesSaved: true
      }
    };
    const flat = [];
    Object.keys(checks).forEach(k => {
      const group = checks[k];
      if (typeof group === 'object') Object.keys(group).forEach(k2 => {
        if (typeof group[k2] === 'boolean') flat.push({ key: k + '.' + k2, ok: group[k2] });
      });
    });
    const bad = flat.filter(x => !x.ok);
    return { ok: bad.length === 0, at: Date.now(), checks: checks, failures: bad };
  },

  /* 列表/详情页 TTL 缓存，沿用 browseCache 分钟数 */
  cachePageKey(site, url) {
    return 'cache.page.' + String(site || '') + '.' + encodeURIComponent(String(url || ''));
  },
  cachePageGet(site, url) {
    try {
      const ttl = Number(DB.cfg().browseCache);
      if (isFinite(ttl) && ttl <= 0) return null;
      const raw = localStorage.getItem(DB.NS + this.cachePageKey(site, url));
      const c = raw ? JSON.parse(raw) : null;
      if (!c || !c.d) return null;
      if (isFinite(ttl) && Date.now() - c.at > ttl * 60000) return null;
      return c.d;
    } catch (e) { return null; }
  },
  cachePagePut(site, url, d) {
    try {
      if (!d) return;
      localStorage.setItem(DB.NS + this.cachePageKey(site, url), JSON.stringify({ at: Date.now(), d: d }));
    } catch (e) { }
  },

  /* 启停/删除站点后：重选当前站点并刷新主页、浏览页顶栏 */
  refreshSites(preferId) {
    const prefer = preferId ? DB.site(preferId) : null;
    if (prefer && prefer.enabled !== false) {
      this.siteId = prefer.id;
    } else {
      const cur = this.siteId ? DB.site(this.siteId) : null;
      if (!cur || cur.enabled === false) {
        const first = (DB.sites() || []).filter(s => s.enabled !== false)[0];
        this.siteId = first ? first.id : null;
      }
    }
    DB._set('lastSite', this.siteId || '');
    this.stacks.browse = [];
    this.invalidateHome();
    if (this.tab === 'browse' && !this.stacks.browse.length) this.renderTab();
  },

  /* 站点启停/删除/改名后，主页缓存必须失效 */
  invalidateHome() {
    this._homeDirty = true;
    if (this._covered && this._covered.tab === 'home') this._covered = null;
    if (this.tab === 'home' && !this.stacks.home.length) this.renderTab();
  },

  home() {
    this._homeDirty = true;
    const st = this.stacks[this.tab];
    for (let i = 0; i < st.length; i++) { try { st[i].cleanup && st[i].cleanup() } catch (e) { } }
    this.stacks[this.tab] = [];
    this._covered = null;
    this.renderPage();
    this.renderTab();
  },

  setTab(t) {
    if (!this.TABS.includes(t)) return;
    if (this.tab === t) {
      // 再点当前 Tab：滚到顶部（第二次）
      const el = this.stacks[t].length ? $('#pageview') : $('#tabview');
      el.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    this.tab = t;
    Log.info('tab ' + t);
    this.renderTab();
    this.renderPage();
    $$('#tabbar .tb').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  },

  renderTab() {
    const box = $('#tabview');
    if (this.tab === 'home' || this.tab === 'browse') this.ensureActiveSite();
    if (this.tab === 'home' && this._homeDirty) {
      this._homeDirty = false;
      this._covered = null;
    }
    const st = this.stacks[this.tab];
    box.style.display = st.length ? 'none' : 'block';
    if (st.length) return;
    /* 从页面返回：把之前暂存的 Tab DOM 原样放回，不重新请求、不回到顶部 */
    if (this._covered && this._covered.tab === this.tab && this._covered.node) {
      const cov = this._covered;
      this._covered = null;
      box.replaceChildren(cov.node);
      box.scrollTop = cov.scroll || 0;
      return;
    }
    if (typeof this._tabCleanup === 'function') { try { this._tabCleanup() } catch (e) { } this._tabCleanup = null }
    const fn = this.tabs[this.tab];
    if (!fn) { box.innerHTML = ''; return }
    box.innerHTML = '<div class="page fade-in" id="tabpage"></div>';
    const root = $('#tabpage');
    try {
      const r = fn(root, this);
      if (r && r.catch) r.catch(e => { Log.err('tab ' + this.tab + ': ' + e.message); root.innerHTML = UI.stateHTML('error', { msg: e.message }) });
    } catch (e) { Log.err('tab ' + this.tab + ': ' + e.message); root.innerHTML = UI.stateHTML('error', { msg: e.message }) }
  },

  renderPage() {
    const box = $('#pageview');
    const st = this.stacks[this.tab];
    box.style.display = st.length ? 'block' : 'none';
    /* 第 2 层页面压在 Tab 之上：隐藏底部 Tab，退出页面时恢复 */
    const tb = $('#tabbar');
    if (tb) tb.style.display = st.length ? 'none' : 'flex';
    const app = $('#app');
    if (app) app.style.bottom = st.length ? '0' : 'var(--tabbar-h)';
    if (!st.length) { box.innerHTML = ''; return }
    const top = st[st.length - 1];
    /* 已有缓存的页面 DOM：直接放回，不再执行页面函数（避免返回时重复请求/重建） */
    if (top.node) {
      box.replaceChildren(top.node);
      box.scrollTop = top.scroll || 0;
      return;
    }
    const prevScroll = top.scroll || 0;
    box.innerHTML = '<div class="page fade-in"></div>';
    const root = box.firstElementChild;
    top.node = root;
    const def = this.pages[top.name];
    if (!def) { box.innerHTML = UI.stateHTML('error', { msg: '页面不存在: ' + top.name }); return }
    const r = def(root, top.params, top);
    const done = () => { if (box.firstElementChild === root) box.scrollTop = prevScroll; };
    if (r && r.catch) {
      r.catch(e => {
        Log.err(top.name + ': ' + e.message);
        root.innerHTML = UI.stateHTML('error', { msg: e.message, retry: () => App.refresh() });
      }).then(done);
    } else done();
  },

  /* 页面里请求刷新（下拉/重试） */
  refresh() {
    const st = this.stacks[this.tab];
    if (st.length) {
      const top = st[st.length - 1];
      top.node = null;
      top.scroll = 0;
      this.renderPage();
    } else {
      this._covered = null;
      this.renderTab();
    }
  }
};

/* ---------------- 7 态状态机（docs/06 §5） ---------------- */
const UI = {
  components: {},
  registerComponent(type, def) {
    const t = String(type || '').trim();
    if (!t) return false;
    this.components[t] = (typeof def === 'function') ? { render: def } : def;
    return true;
  },

  /* 骨架：按页面类型给结构骨架 */
  skeleton(kind) {
    if (kind === 'hero') return `<div class="sk hero-sk"></div><div class="sec"><div class="grid">${'<div class="sk card-sk"></div>'.repeat(4)}</div></div>`;
    if (kind === 'list') return `<div class="pad" style="padding-top:12px"><div class="grid">${'<div class="sk card-sk"></div>'.repeat(6)}</div></div>`;
    if (kind === 'rows') return `<div class="pad" style="padding-top:12px">${'<div class="sk line" style="height:52px"></div>'.repeat(5)}</div>`;
    return `<div class="pad" style="padding-top:16px"><div class="sk line" style="width:46%"></div>${'<div class="sk card-sk" style="margin-bottom:12px"></div>'.repeat(3)}</div>`;
  },
  /* 7 态渲染（返回 HTML 字符串） */
  stateHTML(kind, o = {}) {
    if (kind === 'loading') return this.skeleton(o.kind);
    const map = {
      empty: { ico: '🗂', tt: '什么都没有', ds: o.msg || '这里还没有内容', btn: o.btn || '刷新' },
      error: { ico: '⚠️', tt: '出错了', ds: o.msg || '未知错误', btn: '重试' },
      offline: { ico: '📵', tt: '网络不可用', ds: '检查 Wi-Fi / 移动数据，或去设置网络', btn: '去设置网络' },
      invalid: { ico: '🔌', tt: '该站点脚本已失效', ds: o.msg || '脚本被删除或禁用', btn: '去脚本管理' }
    };
    const c = map[kind] || map.empty;
    return `<div class="empty"><div class="e-ico">${c.ico}</div>
      <div class="e-tt">${esc(o.title || c.tt)}</div><div class="e-ds">${esc(c.ds)}</div>
      ${o.noBtn ? '' : `<button class="btn ghost" data-act="retry">${esc(c.btn)}</button>`}
      ${kind === 'error' && o.trace ? `<div class="mono dim" style="font-size:11px;text-align:left;max-height:120px;overflow:auto;margin-top:8px;white-space:pre-wrap">${esc(o.trace)}</div>` : ''}
    </div>`;
  },
  /* 把状态渲染进元素并绑定按钮 */
  state(el, kind, o = {}) {
    el.innerHTML = this.stateHTML(kind, o);
    const b = $('[data-act=retry]', el);
    if (b) b.onclick = () => {
      if (kind === 'offline') return App.go('settings.net');
      if (kind === 'invalid') return App.go('scripts');
      (o.retry || (() => App.refresh()))();
    };
  },
  /* 区块级降级：错误条 */
  errbar(msg, retry, el) {
    const d = document.createElement('div');
    d.className = 'errbar';
    d.innerHTML = `<b>加载失败</b><span>${esc(msg || '')}</span><span class="x">重试</span>`;
    d.onclick = e => { if (e.target.classList.contains('x') || retry) retry && retry() };
    return d;
  },

  /* ---------- 顶栏 ---------- */
  topbar(o = {}) {
    const back = o.back === false ? '' : `<div class="ico" data-back>‹</div>`;
    const right = (o.right || []).map(r => `<div class="ico ${r.cls || ''}" data-act="${r.act || ''}">${r.i || ''}${r.dot ? '<i class="bdot"></i>' : ''}</div>`).join('');
    const el = document.createElement('div');
    el.className = 'topbar' + (o.solid === false ? '' : '');
    el.innerHTML = `${back}<div class="tt">${o.html ? (o.title || '') : esc(o.title || '')}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</div>${right}`;
    const b = $('[data-back]', el);
    if (b) b.onclick = () => App.back();
    (o.right || []).forEach(r => {
      if (r.act) { const n = $(`[data-act="${r.act}"]`, el); if (n) n.onclick = r.on }
    });
    return el;
  },
  tabs(active) {
    return `<div id="tabbarInner"></div>`;
  },

  /* ---------- 浮层 / 弹窗 / Toast ---------- */
  sheet(html, o = {}) {
    const s = $('#sheet');
    $('.pbody', s).innerHTML = html;
    s.classList.add('on');
    $('.mask', s).onclick = () => this.closeSheet();
    if (o.onOpen) setTimeout(() => o.onOpen($('.pbody', s)), 30);
    return $('.pbody', s);
  },
  closeSheet() { $('#sheet').classList.remove('on') },

  dialog(o = {}) {
    const d = $('#dialog');
    d.innerHTML = `<div class="mask"></div><div class="box">
      <h4>${esc(o.title || '确认')}</h4><p>${esc(o.msg || '')}</p>
      <div class="acts">${o.cancel === false ? '' : `<button class="btn ghost" data-no>${esc(o.cancelText || '取消')}</button>`}
      <button class="btn ${o.danger ? 'danger' : 'pri'}" data-yes>${esc(o.okText || '确定')}</button></div></div>`;
    d.classList.add('on');
    $('.mask', d).onclick = () => this.closeDialog();
    $('[data-no]', d) && ($('[data-no]', d).onclick = () => this.closeDialog());
    $('[data-yes]', d).onclick = () => { this.closeDialog(); o.onOk && o.onOk() };
    if (o.onOpen) o.onOpen(d);
  },
  closeDialog() { $('#dialog').classList.remove('on') },

  _tt: null,
  toast(msg, ms = 1600) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.classList.remove('on'), ms);
  },

  /* ---------- 头像（emoji 或 自定义图片 URL） ---------- */
  /* 用法：UI.avatarHTML(cfg.profile.avatar) —— emoji 直接显示；URL 走 <img>，
     加载失败时自动回退到 emoji（.av-fb），并带上 data-avfail 供调用方统计。 */
  avatarHTML(v, fb) {
    const val = String(v == null ? '' : v).trim();
    const fallback = fb || '🐍';
    const emoji = esc(fallback);
    if (!val) return '<span class="av-emoji">' + emoji + '</span>';
    if (!/^(https?:\/\/|data:image\/)/i.test(val)) {
      return '<span class="av-emoji">' + esc(val) + '</span>';
    }
    return '<img class="av-img" src="' + esc(val) + '" alt="" onerror="this.style.display=\'none\';this.dataset.avfail=\'1\';var f=this.parentNode&&this.parentNode.querySelector(\'.av-fb\');if(f)f.style.display=\'flex\';">' +
      '<span class="av-fb" style="display:none">' + emoji + '</span>';
  },
  avatarIsUrl(v) {
    return /^(https?:\/\/|data:image\/)/i.test(String(v == null ? '' : v).trim());
  },
  /* ---------- 卡片 / 网格 ---------- */
  card(it, i) {
    const letter = `<div class="phfb"><span>${esc((it.title || '?').slice(0, 1))}</span></div>`;
    const img = it.pic
      ? `<img loading="lazy" src="${esc(it.pic)}" alt="" onerror="this.style.display='none'">`
      : '';
    return `<div class="card" data-u="${esc(it.url || '')}" data-site="${esc(it.site || App.siteId || '')}"><div class="ph">${letter}${img}${it.desc ? `<em>${esc(it.desc)}</em>` : ''}</div><div class="tt">${esc(it.title || '未命名')}</div></div>`;
  },
  grid(cards, cls = '') {
    return `<div class="grid ${cls}">${(cards || []).map((c, i) => this.card(c, i)).join('')}</div>`;
  },

  /* ---------- 组件块（脚本预设 UI，docs/02 §2.6） ----------
     blocks: [{type:'image'|'title'|'text'|'badge'|'chips'|'divider'|'spacer'|'row'|'grid'|'button'|...}]
     只接受白名单字段；颜色只允许 #hex/rgb()/rgba()/var(--x)。 */
  _num(v, lo, hi, dflt) {
    v = Number(v);
    if (!isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  },
  _color(v) {
    const s = String(v == null ? '' : v).trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
    if (/^rgba?\(\s*[\d.,%\s]+\)$/.test(s)) return s;
    if (/^var\(--[-\w]+\)$/.test(s)) return s;
    return '';
  },
  _cbCommon(b) {
    const st = [];
    const n = (k, lo, hi, dflt, unit) => {
      if (b[k] == null) return;
      st.push('--cb-' + k + ':' + this._num(b[k], lo, hi, dflt) + (unit || 'px'));
    };
    n('mt', 0, 80, 0); n('mb', 0, 80, 10); n('padding', 0, 40, 0);
    ['tl', 'tr', 'bl', 'br'].forEach(k => n('r' + k, 0, 60, 0));
    if (b.bg) st.push('--cb-bg:' + this._color(b.bg));
    if (b.border) {
      const w = this._num(b.border, 0, 10, 1);
      const c = this._color(b.borderColor) || 'var(--line)';
      st.push('--cb-border:' + w + 'px solid ' + c);
    }
    if (b.radius != null) {
      const r = this._num(b.radius, 0, 60, 12);
      const hasCorner = ['radiusTL', 'radiusTR', 'radiusBL', 'radiusBR'].some(k => b[k] != null);
      if (!hasCorner) st.push('--cb-radius:' + r + 'px');
      else {
        const g = (k, d) => b[k] == null ? d : this._num(b[k], 0, 60, d);
        st.push('--cb-radius:' + g('radiusTL', r) + 'px ' + g('radiusTR', r) + 'px ' + g('radiusBL', r) + 'px ' + g('radiusBR', r) + 'px');
      }
    }
    if (b.shadow && b.shadow !== 'none') {
      const sh = { sm: '0 2px 8px #0004', md: '0 6px 18px #0006', lg: '0 12px 34px #0008' }[b.shadow];
      if (sh) st.push('--cb-shadow:' + sh);
    }
    if (b.width === 'half') st.push('width:calc(50% - 4px)');
    if (b.width === 'third') st.push('width:calc(33.33% - 6px)');
    if (b.align === 'center' || b.align === 'right') st.push('text-align:' + b.align);
    return st.length ? ' style="' + st.join(';') + '"' : '';
  },
  _cbWrap(t, b, inner) {
    return `<div class="cb cb-${t}"${this._cbCommon(b)}>${inner}</div>`;
  },
  blocks(list) {
    if (!Array.isArray(list)) return '';
    return list.map(b => this.block(b)).join('');
  },
  block(b) {
    if (!b || typeof b !== 'object') return '';
    const t = String(b.type || 'text');
    if (this.components[t] && typeof this.components[t].render === 'function') {
      try {
        const inner = this.components[t].render(b);
        if (inner != null) return this._cbWrap(t, b, String(inner));
      } catch (e) {
        try { Log.err('pack component ' + t + ': ' + e.message); } catch (x) { }
      }
    }
    const txt = esc(b.text == null ? '' : b.text);
    const linkAttr = (u) => u ? ` data-cb-url="${esc(u)}"` : '';
    switch (t) {
      case 'image': {
        const src = esc(b.url || b.src || '');
        const fit = ['cover', 'contain', 'fill', 'none', 'scale-down'].includes(b.fit) ? b.fit : 'cover';
        const pos = ['center', 'top', 'bottom', 'left', 'right'].includes(b.position) ? b.position : 'center';
        const ratio = this._num(b.ratio, 0.3, 4, 1.5);
        const h = b.height != null ? this._num(b.height, 20, 600, 120) : null;
        const minH = b.minHeight != null ? this._num(b.minHeight, 0, 600, 0) : null;
        const maxH = b.maxHeight != null ? this._num(b.maxHeight, 20, 800, 400) : null;
        const st = ['--cb-fit:' + fit, '--cb-pos:' + pos, '--cb-ratio:' + ratio];
        if (h != null) st.push('--cb-h:' + h + 'px'); else st.push('--cb-h:auto');
        if (minH != null) st.push('--cb-minh:' + minH + 'px');
        if (maxH != null) st.push('--cb-maxh:' + maxH + 'px');
        const overlay = b.overlay ? '<span class="cb-ov"></span>' : '';
        const capBelow = b.captionPos === 'below';
        const cap = b.caption ? `<figcaption class="cb-cap${capBelow ? ' below' : ''}" style="${b.captionColor ? 'color:' + this._color(b.captionColor) : ''}">${esc(b.caption)}</figcaption>` : '';
        const inner = `<figure class="cb-img${capBelow ? ' cap-below' : ''}"${linkAttr(b.link)}>` +
          `<div class="cb-imgbox" style="${st.join(';')}">${src ? `<img loading="${b.lazy === false ? 'eager' : 'lazy'}" src="${src}" alt="${esc(b.alt || '')}" onerror="this.style.display='none'">` : '<div class="phg"></div>'}${overlay}</div>${cap}</figure>`;
        return this._cbWrap('image', b, inner);
      }
      case 'avatar': {
        const size = this._num(b.size, 20, 120, 48);
        const r = b.radius == null ? '999px' : this._num(b.radius, 0, 60, 12) + 'px';
        const src = esc(b.url || b.src || '');
        const fallback = `<span>${esc((b.fallback || '?').slice(0, 2))}</span>`;
        return this._cbWrap('avatar', b, `<div class="cb-avatar${b.ring ? ' ring' : ''}"${linkAttr(b.link)} style="width:${size}px;height:${size}px;border-radius:${r}">${src ? `<img src="${src}" alt="${esc(b.alt || '')}" onerror="this.style.display='none'">` : ''}${fallback}</div>`);
      }
      case 'hero': {
        const src = esc(b.url || b.src || '');
        const h = this._num(b.height, 100, 600, 200);
        return this._cbWrap('hero', b, `<div class="cb-hero"${linkAttr(b.link)} style="height:${h}px">` +
          (src ? `<img src="${src}" alt="">` : '<div class="phg"></div>') +
          `<span class="cb-ov"></span><div class="cb-hero-c">${b.title ? `<div class="cb-hero-t">${esc(b.title)}</div>` : ''}${b.desc ? `<div class="cb-hero-d">${esc(b.desc)}</div>` : ''}</div></div>`);
      }
      case 'title': {
        const sz = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'].includes(b.size) ? b.size : 'lg';
        const w = ['400', '600', '700', '800', '900'].includes(String(b.weight)) ? b.weight : '';
        return this._cbWrap('title', b, `<div class="cb-title ${sz}" style="${w ? 'font-weight:' + w : ''}${b.color ? ';color:' + this._color(b.color) : ''}">${txt}</div>`);
      }
      case 'text': {
        const sz = ['xs', 'sm', 'md', 'lg'].includes(b.size) ? b.size : 'md';
        return this._cbWrap('text', b, `<div class="cb-text ${sz}${b.muted ? ' dim' : ''}" style="--lines:${this._num(b.lines, 1, 30, 6)}${b.color ? ';color:' + this._color(b.color) : ''}${b.lineHeight ? ';line-height:' + this._num(b.lineHeight, 1, 3, 1.6) : ''}">${txt}</div>`);
      }
      case 'badge':
        return this._cbWrap('badge', b, `<span class="cb-badge">${txt}</span>`);
      case 'chips':
        return this._cbWrap('chips', b, `<div class="cb-chips">${(b.items || []).map(x => `<span>${esc(typeof x === 'string' ? x : (x.text || x.title || ''))}</span>`).join('')}</div>`);
      case 'divider': {
        const w = this._num(b.thickness, 1, 6, 1);
        return this._cbWrap('divider', b, `<div class="cb-div${b.dashed ? ' dashed' : ''}" style="height:${w}px${b.inset ? ';margin-left:' + this._num(b.inset, 0, 80, 0) + 'px' : ''}"></div>`);
      }
      case 'spacer':
        return `<div style="height:${this._num(b.height, 0, 300, 12)}px"></div>`;
      case 'row':
        return this._cbWrap('row', b, `<div class="cb-row" style="--gap:${this._num(b.gap, 0, 40, 8)}px">${this.blocks(b.items)}</div>`);
      case 'grid':
        return this._cbWrap('grid', b, `<div class="cb-grid" style="--cols:${this._num(b.cols, 1, 6, 2)};--gap:${this._num(b.gap, 0, 40, 8)}px">${this.blocks(b.items)}</div>`);
      case 'button': {
        const style = ['pri', 'ghost', 'soft', 'danger'].includes(b.style) ? b.style : 'ghost';
        const size = ['sm', 'md', 'lg'].includes(b.size) ? b.size : 'md';
        const act = b.action === 'play' ? ' data-cb-play="1"' : '';
        return this._cbWrap('button', b, `<button class="btn ${style} cb-btn ${size}${b.block === false ? '' : ' block'}"${act}${linkAttr(b.url)}${b.disabled ? ' disabled' : ''}>${esc(b.icon || '')} ${txt || '打开'}</button>`);
      }
      case 'meta': {
        const cols = this._num(b.cols, 1, 4, 2);
        return this._cbWrap('meta', b, `<div class="cb-meta" style="--cols:${cols}">${(b.items || []).map(x => `<div class="cb-meta-i"><span class="k">${esc(x.label || '')}</span><span class="v">${esc(x.value == null ? '' : x.value)}</span></div>`).join('')}</div>`);
      }
      case 'stats': {
        const cols = this._num(b.cols, 1, 4, 3);
        return this._cbWrap('stats', b, `<div class="cb-stats" style="--cols:${cols}">${(b.items || []).map(x => `<div class="cb-stat"><b>${esc(x.value == null ? '' : x.value)}</b>${x.unit ? `<i>${esc(x.unit)}</i>` : ''}<span>${esc(x.label || '')}</span></div>`).join('')}</div>`);
      }
      case 'progress': {
        const val = this._num(b.value, 0, 1e9, 0);
        const max = this._num(b.max, 1, 1e9, 100);
        const pct = Math.max(0, Math.min(100, val / max * 100));
        const col = this._color(b.color) || 'var(--accent)';
        return this._cbWrap('progress', b, `<div class="cb-prog-h"><span>${esc(b.label || '')}</span><b>${b.showValue === false ? '' : Math.round(pct) + '%'}</b></div>` +
          `<div class="cb-prog" style="height:${this._num(b.height, 2, 20, 6)}px"><i style="width:${pct.toFixed(1)}%;background:${col}"></i></div>`);
      }
      case 'rating': {
        const max = this._num(b.max, 1, 10, 5);
        const val = this._num(b.value, 0, max, 0);
        const full = Math.round(val);
        const stars = Array.from({ length: max }, (_, i) => `<span class="${i < full ? 'on' : ''}">★</span>`).join('');
        return this._cbWrap('rating', b, `<div class="cb-rating" style="color:${this._color(b.color) || '#f5a524'}">${stars}${b.showValue !== false ? `<b>${val.toFixed(1)}</b>` : ''}</div>`);
      }
      case 'notice': {
        const typ = ['info', 'warn', 'err', 'ok'].includes(b.kind) ? b.kind : 'info';
        return this._cbWrap('notice', b, `<div class="cb-notice ${typ}">${b.icon ? `<span class="i">${esc(b.icon)}</span>` : ''}<span>${txt}</span></div>`);
      }
      case 'link':
        return this._cbWrap('link', b, `<div class="cb-link"${linkAttr(b.url)}><span>${esc(b.icon || '↗')} ${txt || esc(b.url || '')}</span><b>›</b></div>`);
      case 'list': {
        const arr = b.items || [];
        return this._cbWrap('list', b, `<div class="cb-list">${arr.map(x => {
          const u = x.url || '';
          return `<div class="cb-li"${linkAttr(u)}>${x.pic ? `<img src="${esc(x.pic)}" alt="">` : ''}<div class="t"><div class="n">${esc(x.title || '')}</div>${x.desc ? `<div class="d">${esc(x.desc)}</div>` : ''}</div><b>›</b></div>`;
        }).join('')}</div>`);
      }
      case 'gallery': {
        const imgs = b.items || b.images || [];
        return this._cbWrap('gallery', b, `<div class="cb-gallery" style="--cols:${this._num(b.cols, 1, 6, 3)};--gap:${this._num(b.gap, 0, 30, 6)}px">${imgs.map(x => {
          const u = typeof x === 'string' ? x : (x.url || x.src || '');
          return `<div class="cb-g"${linkAttr(typeof x === 'object' ? x.link : '')} style="border-radius:${this._num(b.radius, 0, 40, 8)}px;aspect-ratio:${this._num(b.ratio, 0.3, 4, 1)}"><img src="${esc(u)}" alt=""></div>`;
        }).join('')}</div>`);
      }
      case 'quote':
        return this._cbWrap('quote', b, `<div class="cb-quote">${txt}${b.author ? `<s>— ${esc(b.author)}</s>` : ''}</div>`);
      case 'section':
        return this._cbWrap('section', b, `${b.title ? `<div class="cb-sec-h">${esc(b.title)}${b.more ? `<s>${esc(b.more)}</s>` : ''}</div>` : ''}<div class="cb-sec-b">${this.blocks(b.items)}</div>`);
      default:
        return this._cbWrap('text', b, `<div class="cb-text">${txt}</div>`);
    }
  },
  bindBlocks(root, ctx) {
    $$('[data-cb-url]', root).forEach(el => {
      el.onclick = () => {
        const u = el.dataset.cbUrl;
        if (!u) return;
        if (ctx && ctx.open) ctx.open(u);
        else App.go('detail', { url: u, site: App.siteId });
      };
    });
    $$('[data-cb-play]', root).forEach(el => {
      el.onclick = () => { if (ctx && ctx.play) ctx.play() };
    });
  },  bindCards(root) {
    $$('.card[data-u]', root).forEach(el => {
      el.onclick = () => { const u = el.dataset.u; if (u) App.go('detail', { url: u, site: el.dataset.site || App.siteId }) };
    });
  },

  /* ---------- 设置行 ---------- */
  row(o) {
    const right = o.right != null ? `<div class="v">${esc(o.right)}</div>` : '';
    const arrow = o.arrow ? '<div class="arw">›</div>' : '';
    const cls = 'row' + (o.arrow ? ' tap' : '') + (o.danger ? ' danger' : '');
    return `<div class="${cls}" ${o.act ? `data-act="${o.act}"` : ''}>${o.icon ? `<div class="ico" style="width:28px">${o.icon}</div>` : ''}
      <div class="t"><div class="nm">${esc(o.title)}</div>${o.desc ? `<div class="ds">${esc(o.desc)}</div>` : ''}</div>${right}${arrow}</div>`;
  },
  switchRow(o) {
    return `<div class="row" data-act="${o.act || ''}"><div class="t"><div class="nm">${esc(o.title)}</div>${o.desc ? `<div class="ds">${esc(o.desc)}</div>` : ''}</div>
      <div class="switch ${o.on ? 'on' : ''}" data-sw="${o.act || ''}"><i></i></div></div>`;
  },

  /* ---------- 时间/尺寸徽标 ---------- */
  badge(t) { return `<span class="tag">${esc(t)}</span>` },

  /* ---------- 主题 ---------- */
  applyTheme() {
    const c = DB.cfg();
    document.documentElement.dataset.theme = c.theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.motion = c.motion === 'off' ? 'off' : 'on';
    if (c.accent) document.documentElement.style.setProperty('--accent', c.accent);
    if (c.heroH) document.documentElement.style.setProperty('--hero-h', c.heroH + 'px');
    const fixed = { font: (c.fontScale || 100) / 100 };
    document.documentElement.style.fontSize = '';
    document.body.style.zoom = '';
    if (fixed.font !== 1) {
      // 字号缩放：整体缩放（保持布局不截断，按 docs/08 §8）
      document.documentElement.style.setProperty('--font-scale', fixed.font);
      document.body.style.transformOrigin = '0 0';
    }
    this.applyUserCss();
    this.applySyntaxColors();
  },

  applySyntaxColors() {
    const def = { kw: '#FF7B72', str: '#A5D6A7', num: '#F0B37E', com: '#6E7B87', fn: '#82AAFF', punct: '#93A1AD', key: '#7DD3FC', type: '#7DD3FC', const: '#C4B5FD', bi: '#FBBF24' };
    const cur = DB.cfg().syntaxColors || {};
    Object.keys(def).forEach(function (k) {
      const v = cur[k] || def[k];
      document.documentElement.style.setProperty('--ce-' + k, v);
    });
  },

  externalLinks(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('a[href]').forEach(function (a) {
      if (a.dataset.extbound) return;
      a.dataset.extbound = '1';
      a.addEventListener('click', function (e) {
        var u = a.getAttribute('href') || '';
        if (!/^https?:\/\//i.test(u)) {
          try { u = new URL(u, 'https://example.com/').href; } catch (x) { }
        }
        e.preventDefault();
        if (window.Native && Native.openUrl) { try { Native.openUrl(u); return; } catch (x) { } }
        try { window.open(u, '_blank'); } catch (x) { UI.toast('无法打开链接：' + u); }
      });
    });
  },

  openCodeEditor(opt) {
    opt = opt || {};
    const ov = document.createElement('div');
    ov.className = 'code-overlay';
    const tb = this.topbar({
      title: opt.title || '编辑',
      right: [{ i: '保存', act: 'save', on: save }]
    });
    const oldBack = tb.querySelector('[data-back]');
    if (oldBack) oldBack.onclick = function () { close() };

    const filebar = document.createElement('div');
    filebar.className = 'code-filebar';
    filebar.innerHTML = '<span class="star">★</span><b>' + esc(opt.filename || 'index.js') + '</b>';

    const tools = document.createElement('div');
    tools.className = 'd1-edtools';
    tools.innerHTML = '<b data-e="undo">撤销</b><b data-e="redo">重做</b><i></i>' +
      [['{ }', '{}'], ['( )', '()'], ['[ ]', '[]'], ['" "', '""'], ["' '", "''"],
       [':', ':'], [';', ';'], ['=', '='], ['#', '#'], ['$', '$'], ['|', '|'], ['&&', '&&'], ['->', '->'], ['_', '_']]
        .map(function (x) { return '<b data-e="sym" data-s="' + esc(x[1]) + '">' + esc(x[0]) + '</b>'; }).join('');

    const host = document.createElement('div');
    host.className = 'code-overlay-host';
    ov.appendChild(tb);
    ov.appendChild(filebar);
    ov.appendChild(tools);
    ov.appendChild(host);
    document.body.appendChild(ov);

    let ed = null, ta = null;
    try {
      ed = window.CodeEditor(host, { value: opt.value || '', lang: opt.lang || 'js', onChange: function () { } });
    } catch (e) {
      host.innerHTML = '<textarea class="input" spellcheck="false" wrap="off" style="height:100%;border-radius:0"></textarea>';
      ta = host.querySelector('textarea');
      ta.value = opt.value || '';
      ed = { getValue: function () { return ta.value }, undo: function () { return false }, redo: function () { return false }, wrap: function (a, b) { ta.value += a + b; }, insert: function (t) { ta.value += t; } };
    }
    tools.querySelectorAll('[data-e]').forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.e;
        if (k === 'undo') { if (!ed.undo || !ed.undo()) UI.toast('没有可撤销的编辑'); return; }
        if (k === 'redo') { if (!ed.redo || !ed.redo()) UI.toast('没有可重做的编辑'); return; }
        var s = b.dataset.s || '';
        if (s === '{}' || s === '()' || s === '[]') { ed.wrap(s.charAt(0), s.charAt(1)); return; }
        if (s === '""') { ed.wrap('"', '"'); return; }
        if (s === "''") { ed.wrap("'", "'"); return; }
        if (ed.insert) ed.insert(s);
      };
    });

    function close() {
      ov.remove();
      window.__codeOverlayBack = null;
    }
    function save() {
      const v = ed && ed.getValue ? ed.getValue() : '';
      close();
      if (opt.onSave) opt.onSave(v);
    }
    window.__codeOverlayBack = function () { close(); return true; };
    return { close: close, editor: ed };
  },

  applyUserCss() {
    try {
      const css = String(((DB.cfg().ui || {}).css) || '');
      let el = document.getElementById('rou-user-css');
      if (!css) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('style'); el.id = 'rou-user-css'; document.head.appendChild(el); }
      el.textContent = css;
    } catch (e) { }
  }
};

window.App = App;
window.UI = UI;
App.info = { version: '1.10.35', versionCode: 91, packageName: 'com.rou.parser' };
try {
  if (window.Native && Native.appInfo) {
    const j = JSON.parse(Native.appInfo() || '{}');
    if (j && j.versionName) j.version = j.versionName;
    App.info = Object.assign(App.info, j || {});
  }
} catch (e) { }

/* 全局错误上抛到日志（不弹窗打断）；同时写到 document.title 便于自动化验收抓取 */
window.addEventListener('error', e => {
  Log.err('JS: ' + (e.message || e.error));
  document.title = 'ERR ' + String(e.message || e.error).slice(0, 80);
});
window.addEventListener('unhandledrejection', e => {
  const m = (e.reason && (e.reason.message || e.reason)) || 'unknown';
  Log.err('Promise: ' + m);
  document.title = 'ERR ' + String(m).slice(0, 80);
});

/* 长按/右键菜单：输入框与可编辑区域保留系统菜单（粘贴/选择），其余一律不弹
   —— 避免长按页面出现“复制/全选/网页搜索/分享”的原生工具栏 */
document.addEventListener('contextmenu', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
}, true);
