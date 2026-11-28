/* data.js — 本地持久化（localStorage）。key 规范见 docs/06 §6.2、文件格式见 docs/11 §4。
   所有页面只通过 DB.* 读写，不要直接碰 localStorage。 */
const DB = {
  NS: 'rouparser.',
  _cache: {},
  _get(k, dflt) {
    if (k in this._cache) return this._cache[k];
    let v = dflt;
    try { const raw = localStorage.getItem(this.NS + k); if (raw != null) v = JSON.parse(raw) } catch (e) { }
    this._cache[k] = v;
    return v;
  },
  _set(k, v) {
    this._cache[k] = v;
    try { localStorage.setItem(this.NS + k, JSON.stringify(v)) } catch (e) { Log.err('存储失败: ' + e.message) }
    return v;
  },

  /* ---------------- 配置 ---------------- */
  DEFAULTS: {
    theme: 'dark', accent: '#FF5A3C', motion: 'on', heroH: 200, gridCols: 2, fontScale: 100, radius: 12,
    browseCache: 30,
    net: { mode: 'doh', proxy: '', doh: 'https://223.5.5.5/resolve', timeout: 20, retry: 1, qps: 3, conc: 4 },
    play: { decoder: 'auto', cache: 128, rate: 1, longPress: 2, gestureLight: true, gestureVol: true, gestureSeek: true, resume: true, bgPlay: false, ratio: 'fit' },
    home: { welcome: true, tiles: true, sites: true, cont: true, notice: true, tilesLayout: '3x2', siteLayout: 'list', welcomeText: '可编程解析客户端 · 一个脚本一个站点' },
    profile: { nick: '', avatar: '🐍', joinedAt: 0 },
    playPref: 'auto'
  },
  cfg() {
    const c = this._get('cfg', null);
    if (!c) return this._set('cfg', JSON.parse(JSON.stringify(this.DEFAULTS)));
    // 合并默认值（新增字段向后兼容）
    const d = JSON.parse(JSON.stringify(this.DEFAULTS));
    const merge = (a, b) => { for (const k in b) { if (a[k] == null) a[k] = b[k]; else if (typeof b[k] === 'object' && b[k] && !Array.isArray(b[k])) merge(a[k], b[k]) } return a };
    const out = JSON.parse(JSON.stringify(c));
    const fill = (a, b) => { for (const k in b) { if (a[k] == null) a[k] = b[k]; else if (typeof b[k] === 'object' && b[k] && !Array.isArray(b[k])) { if (typeof a[k] !== 'object' || !a[k]) a[k] = {}; fill(a[k], b[k]); } } return a };
    return fill(out, d);
  },
  setCfg(patch) {
    const c = this.cfg();
    const merge = (a, b) => { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) { a[k] = a[k] || {}; merge(a[k], b[k]) } else a[k] = b[k] } return a };
    this._set('cfg', merge(c, patch));
    UI.applyTheme();
    Net.config(this.netCfg());
    return this.cfg();
  },
  netCfg() {
    const n = this.cfg().net;
    return { mode: n.mode, proxy: n.proxy, doh: n.doh, timeout: n.timeout, ua: this.cfg().ua || '' };
  },

  /* ---------------- 站点（脚本） ---------------- */
  sites() { return this._get('sites', []) },
  site(id) { return this.sites().find(s => s.id === id) || null },
  saveSite(s) {
    const list = this.sites();
    const i = list.findIndex(x => x.id === s.id);
    s.updatedAt = now();
    if (i < 0) { s.createdAt = s.createdAt || now(); list.push(s) } else list[i] = Object.assign(list[i], s);
    this._set('sites', list);
    return s;
  },
  delSite(id) {
    this._set('sites', this.sites().filter(s => s.id !== id));
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(this.NS + 'cache.' + id + '.')) localStorage.removeItem(k) } catch (e) { }
  },
  toggleSite(id) {
    const s = this.site(id); if (!s) return;
    const on = s.enabled !== false;
    this.saveSite({ id: id, enabled: !on });
  },
  enabledSites() { return this.sites().filter(s => s.enabled !== false) },

  /* ---------------- 收藏 / 历史 ---------------- */
  fav() { return this._get('fav', []) },
  isFav(url) { return this.fav().some(x => x.url === url) },
  toFav(it) {
    const list = this.fav();
    const i = list.findIndex(x => x.url === it.url);
    if (i >= 0) { list.splice(i, 1); this._set('fav', list); return false }
    list.unshift(Object.assign({ at: now() }, it));
    this._set('fav', list.slice(0, 500));
    return true;
  },
  hist() { return this._get('hist', []) },
  pushHist(it) {
    const list = this.hist();
    const i = list.findIndex(x => x.url === it.url);
    if (i >= 0) list.splice(i, 1);
    list.unshift(Object.assign({ at: now() }, it));
    this._set('hist', list.slice(0, 500));
  },
  clearHist() { this._set('hist', []) },

  /* 播放进度：key = site|contentId|ep */
  progress(site, id, ep = 0) {
    const m = this._get('progress', {});
    return m[[site, id, ep].join('|')] || null;
  },
  setProgress(site, id, ep, pos, dur) {
    const m = this._get('progress', {});
    m[[site, id, ep].join('|')] = { pos, dur, at: now() };
    const keys = Object.keys(m);
    if (keys.length > 800) keys.slice(0, keys.length - 800).forEach(k => delete m[k]);
    this._set('progress', m);
  },
  lastProgress(site, id) {
    const m = this._get('progress', {});
    const rows = Object.keys(m).filter(k => k.startsWith(site + '|' + id + '|')).map(k => ({ k, v: m[k] }));
    rows.sort((a, b) => b.v.at - a.v.at);
    return rows[0] ? { ep: +rows[0].k.split('|')[2], ...rows[0].v } : null;
  },

  /* 片头尾：key = site|seriesId|ep */
  intro(site, series, ep) {
    const m = this._get('intro', {});
    return m[[site, series, ep].join('|')] || null;
  },
  setIntro(site, series, ep, v) {
    const m = this._get('intro', {});
    m[[site, series, ep].join('|')] = Object.assign({ at: now() }, v);
    this._set('intro', m);
  },

  /* ---------------- 搜索历史 / 日志 / 装包 ---------------- */
  searchHist() { return this._get('searchHist', []) },
  pushSearch(kw) {
    const l = this.searchHist().filter(x => x !== kw);
    l.unshift(kw); this._set('searchHist', l.slice(0, 20));
  },
  clearSearch() { this._set('searchHist', []) },

  pushLog(rec) {
    const l = this._get('logs', []);
    l.push(rec);
    this._set('logs', l.slice(-400));
  },
  logs() { return this._get('logs', []) },
  clearLogs() { this._set('logs', []) },

  installed() { return this._get('installed', []) },
  setInstalled(l) { this._set('installed', l) },

  /* ---------------- 通用统计 ---------------- */
  stats() {
    const h = this.hist();
    let sec = 0;
    for (const k in (this._get('progress', {}))) sec += (this._get('progress', {})[k].pos || 0);
    return {
      videos: new Set(h.map(x => x.url)).size,
      hours: (sec / 3600),
      hist: h.length,
      sites: this.sites().length,
      scripts: this.sites().filter(s => s.type !== 'rule').length
    };
  },

  exportAll() {
    return JSON.stringify({
      v: 1, at: now(), cfg: this.cfg(), sites: this.sites(), fav: this.fav(),
      hist: this.hist(), progress: this._get('progress', {}), intro: this._get('intro', {})
    });
  },
  importAll(txt) {
    const o = JSON.parse(txt);
    if (o.cfg) this._set('cfg', o.cfg);
    if (o.sites) this._set('sites', o.sites);
    if (o.fav) this._set('fav', o.fav);
    if (o.hist) this._set('hist', o.hist);
    if (o.progress) this._set('progress', o.progress);
    if (o.intro) this._set('intro', o.intro);
    UI.applyTheme();
  }
};
