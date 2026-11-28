/* boot.js — 启动：种子站点 / 主题 / Tab 接线 / 返回键 / 深度同步 */
(function () {
  Engine.init();

  /* 首次启动：写入内置站点（脚本源码留空 = 永远用 index.html 里的最新内置版；
     用户在 P-05 编辑保存后会写入 site.script，从此以用户的为准） */
  const BUILTIN_VER = 3;
  if (!DB.sites().length) {
    DB.saveSite({
      id: 'demo_site', name: '示例站点', site: 'https://example.com', icon: '🌐', group: '示例',
      type: 'js', enabled: true, script: '', scriptVer: BUILTIN_VER, referer: 'https://example.com/'
    });
  }
  const sites = DB.sites();
  const enabledSites = sites.filter(function (x) { return x.enabled !== false; });
  const lastSite = DB._get('lastSite', null);
  const defaultSite = DB._get('defaultSite', null);
  let pick = null;
  if (DB.site(defaultSite) && DB.site(defaultSite).enabled !== false) pick = defaultSite;
  else if (DB.site(lastSite) && DB.site(lastSite).enabled !== false) pick = lastSite;
  else if (enabledSites[0]) pick = enabledSites[0].id;
  App.siteId = pick;
  if (!defaultSite && pick) DB._set('defaultSite', pick);
  if (App.siteId) DB._set('lastSite', App.siteId);

  /* 配置 → 主题 / 网络 */
  UI.applyTheme();
  Net.config(DB.netCfg());

  /* 底部 Tab */
  $$('#tabbar .tb').forEach(el => {
    el.onclick = () => App.setTab(el.dataset.tab);
  });

  window.__backRoot = function () {
    if (App.tab !== 'home') { App.setTab('home'); return true; }
    return false;
  };
  window.__audit = function () { return App.auditState(); };
  window.__tree = function () { return App.tree(); };

  /* 返回键：浮层 → 页面栈 → 交给系统 */
  window.__back = function () {
    if ($('#dialog').classList.contains('on')) { UI.closeDialog(); return true }
    if (typeof window.__codeOverlayBack === 'function') { try { if (window.__codeOverlayBack()) return true } catch (e) { } }
    if ($('#sheet').classList.contains('on')) { UI.closeSheet(); return true }
    /* 播放器横屏时先退出横屏（页面自己注册的钩子） */
    if (typeof window.__playerBack === 'function') { try { if (window.__playerBack()) return true } catch (e) { } }
    /* 终端文件面板打开时先关面板 */
    if (typeof window.__termBack === 'function') { try { if (window.__termBack()) return true } catch (e) { } }
    if (App.stacks[App.tab].length) { App.back(); return true }
    return false;
  };

  /* 屏幕方向：0 竖屏锁定 / 1 横屏 / 2 跟随系统（无桥时静默降级） */
  App.orient = function (mode) {
    try { if (window.Native && window.Native.orient) window.Native.orient(mode) } catch (e) { }
  };
  App.isLandscape = function () {
    return (window.innerWidth > window.innerHeight) || (screen.orientation && screen.orientation.type && screen.orientation.type.indexOf('landscape') === 0);
  };

  /* 深度同步：供 Java onBackPressed 判断是否消费返回 */
  App.syncDepth = function () {
    const n = App.stacks[App.tab].length
      + ($('#sheet').classList.contains('on') ? 1 : 0)
      + ($('#dialog').classList.contains('on') ? 1 : 0);
    window.__depth = n;
    try { if (window.Native && window.Native.depth) window.Native.depth(n) } catch (e) { }
  };
  const _renderPage = App.renderPage.bind(App), _renderTab = App.renderTab.bind(App);
  App.renderPage = function () { _renderPage(); App.syncDepth() };
  App.renderTab = function () { _renderTab(); App.syncDepth() };

  /* 扩展包注册（1.8.0）：语法/组件/主题贡献点 */
  try { if (window.Packs) Packs.init(); } catch (e) { Log.err('packs init: ' + e.message) }
  try { var _tp = DB.cfg().themePack; if (_tp && window.Packs) Packs.applyTheme(_tp); } catch (e) { }

  /* 首屏 */
  App.renderTab();
  App.renderPage();
  App.syncDepth();

  /* 调试路由：index.html#go=module / #go=detail&url=...（桌面联调与 adb extras 复用） */
  try {
    const h = location.hash.replace(/^#/, '');
    if (h) {
      const q = new URLSearchParams(h);
      const page = q.get('go');
      if (page) {
        const p = {};
        q.forEach((v, k) => { if (k !== 'go') p[k] = v });
        if (App.TABS.includes(page)) App.setTab(page);
        else App.go(page, p);
      }
    }
  } catch (e) { Log.err('route: ' + e.message) }

  Log.ok('界析 启动 · ' + (window.Native ? 'Java 桥已就绪' : 'WebView 直连模式'));
  if (window.Native && window.Native.ready) { try { window.Native.ready() } catch (e) { } }
})();
