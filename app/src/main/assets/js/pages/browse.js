/* browse.js — T-2 浏览（当前站点内容页）
   数据源：Engine.run(site, homeUrl) → {type:'home', heroes, cats, sections}
   7 态：loading / ready / empty / error / offline / invalid / partial（分区级降级 + 缓存回退） */
App.tabs['browse'] = function (root) {
  const siteId = App.siteId;
  const site = siteId ? DB.site(siteId) : null;
  const cacheKey = 'cache.' + siteId + '.home';

  root.innerHTML = '';
  const bar = UI.topbar({
    back: false, html: true,
    title: '<span data-site>' + esc(site ? site.name : '未选择站点') + ' ▾</span>',
    right: [
      { i: '🔍', act: 'search' },
      { i: '⋮', act: 'more' }
    ]
  });
  root.appendChild(bar);
  const body = document.createElement('div');
  body.innerHTML = UI.skeleton('hero');
  root.appendChild(body);

  const customTabs = Array.isArray(site.tabs) ? site.tabs.filter(function (t) { return t && t.url; }) : [];
  if (customTabs.length) {
    const ch = document.createElement('div');
    ch.className = 'channels';
    ch.innerHTML = '<b class="on" data-u="">首页</b>' + customTabs.map(function (t) {
      return '<b data-u="' + esc(t.url) + '">' + esc(t.title || '频道') + '</b>';
    }).join('');
    root.insertBefore(ch, body);
    $$('[data-u]', ch).forEach(function (el) {
      el.onclick = function () {
        const u = el.dataset.u;
        if (!u) return;
        App.go('list', { site: siteId, url: u, title: el.textContent });
      };
    });
  }

  const openSitePicker = () => {
    const sites = DB.sites().filter(s => s.enabled !== false);
    if (!sites.length) { App.go('newscript'); return }
    UI.sheet(sites.map(s => `
      <div class="row tap" data-pick="${esc(s.id)}">
        <div class="ico" style="width:32px">${esc(s.icon || '🌐')}</div>
        <div class="t"><div class="nm">${esc(s.name)}${s.enabled === false ? ' <span class="dim">(停用)</span>' : ''}</div>
          <div class="ds">${esc((s.site || '').replace(/^https?:\/\//, ''))}</div></div>
        <div class="arw">${s.id === siteId ? '✓' : ''}</div>
      </div>`).join('') +
      `<div class="row tap" data-pick="__manage"><div class="t"><div class="nm">管理脚本</div></div><div class="arw">›</div></div>`,
      {
        onOpen: pb => {
          $$('[data-pick]', pb).forEach(el => el.onclick = () => {
            const id = el.dataset.pick;
            UI.closeSheet();
            if (id === '__manage') return App.go('scripts');
            App.siteId = id; DB._set('lastSite', id);
            App.renderTab();
          });
        }
      });
  };

  $('[data-site]', bar).onclick = openSitePicker;
  $('[data-act=search]', bar).onclick = () => App.go('search', { site: siteId });
  $('[data-act=more]', bar).onclick = () => {
    UI.sheet(`
      <div class="row tap" data-m="refresh"><div class="t"><div class="nm">刷新</div></div><div class="arw">↻</div></div>
      <div class="row tap" data-m="scripts"><div class="t"><div class="nm">脚本管理</div></div><div class="arw">›</div></div>
      <div class="row tap" data-m="settings"><div class="t"><div class="nm">设置</div></div><div class="arw">›</div></div>
      <div class="row tap" data-m="net"><div class="t"><div class="nm">网络设置</div><div class="ds">当前：${esc(netModeName(DB.cfg().net.mode))}</div></div><div class="arw">›</div></div>`,
      {
        onOpen: pb => {
          $$('[data-m]', pb).forEach(el => el.onclick = () => {
            const m = el.dataset.m; UI.closeSheet();
            if (m === 'refresh') load(true);
            else if (m === 'scripts') App.go('scripts');
            else if (m === 'settings') App.go('settings');
            else App.go('settings.net');
          });
        }
      });
  };

  if (!siteId || !site) {
    UI.state(body, 'invalid', { msg: '还没有可用站点', btn: '去新建脚本' });
    const b = $('[data-act=retry]', body);
    if (b) b.onclick = () => App.go('newscript');
    return;
  }
  if (site.enabled === false) {
    UI.state(body, 'invalid', { msg: '该站点已停用' });
    const b = $('[data-act=retry]', body);
    if (b) b.onclick = () => App.go('scriptDetail', { id: siteId });
    return;
  }

  let killed = false;
  const st = App.stacks[App.tab][App.stacks[App.tab].length - 1];
  if (st) st.cleanup = () => { killed = true; clearInterval(heroTimer) };
  App._tabCleanup = () => { killed = true; clearInterval(heroTimer) };

  function netModeName(m) {
    return { direct: '直连', doh: 'DoH', proxy: '代理', both: 'DoH+代理' }[m] || '直连';
  }

  /* ---------------- 渲染 ---------------- */
  let heroTimer = null;

  function renderHome(d) {
    let h = '';
    if (d.heroes && d.heroes.length) {
      h += `<div class="hero" id="hero">` + d.heroes.map((x, i) =>
        `<div class="s${i === 0 ? ' on' : ''}" data-u="${esc(x.url)}">
           <div class="bg" style="background-image:url('${esc(x.pic)}')"></div><div class="ov"></div>
           ${x.title || x.desc ? `<div class="cap">${x.title ? `<h2>${esc(x.title)}</h2>` : ''}${x.desc ? `<p>${esc(x.desc)}</p>` : ''}</div>` : ''}</div>`).join('') +
        `<div class="dots">` + d.heroes.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('') + `</div></div>`;
    }
    if (d.cats && d.cats.length) {
      h += `<div class="channels" id="channels"><b class="on" data-u="">首页</b>` +
        d.cats.map(c => `<b data-u="${esc(c.url)}">${esc(c.title)}</b>`).join('') + `</div>`;
    }
    const secs = d.sections || [];
    h += secs.map((s, i) => `<div class="sec" data-sec="${i}">
        <div class="sec-h"><h3>${esc(s.title)}</h3>${s.more ? `<s class="more" data-more="${esc(s.more)}">更多 ›</s>` : ''}</div>
        ${UI.grid(s.cards)}
      </div>`).join('');
    if (!secs.length && !(d.heroes || []).length) {
      h = UI.stateHTML('empty', { msg: '这个站点今天没内容', retry: () => load(true) });
    }
    body.innerHTML = h;
    UI.bindCards(body);

    const hero = $('#hero', body);
    if (hero) {
      if (d.heroes && d.heroes.length) Log.info('轮播 ' + d.heroes.length + ' 张: ' + d.heroes.map((x, i) => i + ':' + x.title + '@' + x.url).join(' | '));
      const sl = $$('.s', hero), dt = $$('.dots i', hero);
      let k = 0, sx = 0, sy = 0, swiping = false, moved = false;
      const show = i => {
        k = ((i % sl.length) + sl.length) % sl.length;
        sl.forEach((s, j) => s.classList.toggle('on', j === k));
        dt.forEach((d, j) => d.classList.toggle('on', j === k));
      };
      const restart = () => {
        clearInterval(heroTimer);
        if (sl.length > 1) heroTimer = setInterval(() => show(k + 1), 4000);
      };
      sl.forEach((s, i) => {
        s.onclick = () => {
          if (moved) { moved = false; return; }
          Log.info('轮播点击 #' + (i + 1) + ' ' + (s.dataset.u || '(空)'));
          App.go('detail', { url: s.dataset.u, site: siteId });
        };
      });
      dt.forEach((d, i) => d.onclick = e => { e.stopPropagation(); show(i); restart(); });
      /* 手动左右滑：横向位移 > 40px 且明显大于纵向；滑动后不触发详情点击 */
      hero.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        sx = e.clientX; sy = e.clientY; swiping = true; moved = false;
        clearInterval(heroTimer);
      });
      hero.addEventListener('pointermove', e => {
        if (!swiping) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) moved = true;
      });
      hero.addEventListener('pointerup', e => {
        if (!swiping) return;
        swiping = false;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          show(k + (dx < 0 ? 1 : -1));
          moved = true;
          setTimeout(() => { moved = false; }, 350);
        }
        restart();
      });
      hero.addEventListener('pointercancel', () => { swiping = false; restart(); });
      restart();
    }
    const ch = $('#channels', body);
    if (ch) $$('b', ch).forEach(b => b.onclick = () => {
      $$('b', ch).forEach(x => x.classList.remove('on')); b.classList.add('on');
      if (!b.dataset.u) { load(true); return }
      App.go('list', { site: siteId, url: b.dataset.u, title: b.textContent });
    });
    $$('[data-more]', body).forEach(el => el.onclick = () => App.go('list', { site: siteId, url: el.dataset.more, title: '' }));
  }

  /* ---------------- 加载 ---------------- */
  async function load(force) {
    if (!force) {
      const ttl = Number(DB.cfg().browseCache);
      if (isFinite(ttl) && ttl > 0) {
        try {
          const raw = localStorage.getItem(DB.NS + cacheKey);
          const cached = raw ? JSON.parse(raw) : null;
          if (cached && cached.d && Date.now() - cached.at < ttl * 60000) {
            renderHome(cached.d);
            return;
          }
        } catch (e) { }
      }
    }
    if (!force) body.innerHTML = UI.skeleton('hero');
    else if (!body.children.length) body.innerHTML = UI.skeleton('hero');

    const home = Engine.homeUrl(siteId) || site.site;
    const res = await Engine.run(siteId, home);
    if (killed) return;

    if (res.ok && res.data && res.data.type) {
      try { localStorage.setItem(DB.NS + cacheKey, JSON.stringify({ at: Date.now(), d: res.data })) } catch (e) { }
      renderHome(res.data);
      return;
    }

    /* 失败：先尝试缓存（降级），再报错 */
    let cached = null;
    try { const raw = localStorage.getItem(DB.NS + cacheKey); if (raw) cached = JSON.parse(raw) } catch (e) { }
    const msg = res.error || '未知错误';
    if (cached && cached.d && Date.now() - cached.at < 86400000) {
      renderHome(cached.d);
      const bar2 = UI.errbar('显示缓存内容 · ' + msg, () => load(true));
      body.insertBefore(bar2, body.firstChild);
      return;
    }
    if (navigator.onLine === false) return UI.state(body, 'offline');
    if (/脚本不存在|缺少 parse|语法错误/.test(msg)) return UI.state(body, 'invalid', { msg });
    UI.state(body, 'error', { msg, trace: res.trace, retry: () => load(true) });
    /* 网络类失败：补一个直达网络设置的入口（本网络 example.com 需代理） */
    if (/timeout|超时|Failed to fetch|SSL|Connection|refused|unable/i.test(msg)) {
      const hint = document.createElement('div');
      hint.style.cssText = 'text-align:center;padding:0 24px 24px';
      hint.innerHTML = `<button class="btn ghost" id="goNet">网络设置（被污染时切到代理）</button>`;
      body.appendChild(hint);
      $('#goNet', hint).onclick = () => App.go('settings.net');
    }
  }

  /* ---------------- 下拉刷新（只绑定一次，避免 Tab 反复渲染后重复叠加） ---------------- */
  App._browseReload = () => load(true);
  if (!App._ptrBound) {
    App._ptrBound = true;
    const box = $('#tabview');
    let sx = 0, sy = 0, dy = 0, dx = 0;
    let tracking = false, pulling = false, hintEl = null;
    const clearHint = () => { if (hintEl) { hintEl.remove(); hintEl = null } };
    /* 横滑区域（轮播 / 频道 / 横向卡片）里完全不做下拉刷新 */
    const inHScroll = el => !!(el && el.closest &&
      el.closest('.hero, .channels, .hscroll, .cats'));
    box.addEventListener('touchstart', e => {
      if (box.scrollTop > 0 || App.tab !== 'browse' || !e.touches || e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      dy = dx = 0;
      pulling = false;
      tracking = !inHScroll(e.target);
    }, { passive: true });
    box.addEventListener('touchmove', e => {
      if (!tracking || box.scrollTop > 0 || App.tab !== 'browse' || !e.touches || !e.touches[0]) return;
      dx = e.touches[0].clientX - sx;
      dy = e.touches[0].clientY - sy;
      if (!pulling) {
        /* 必须是明显的向下、且比横向位移大，才算下拉 */
        if (dy > 10 && dy > Math.abs(dx) * 1.2) pulling = true;
        else if (Math.abs(dx) > 12 && Math.abs(dx) > dy) { tracking = false; clearHint(); }
        else return;
      }
      if (dy < 0 || Math.abs(dx) > dy * 1.4) {
        pulling = false;
        tracking = false;
        clearHint();
        return;
      }
      const page = $('#tabpage');
      if (!page) return;
      if (!hintEl) {
        hintEl = document.createElement('div');
        hintEl.className = 'ptr-hint';
        page.insertBefore(hintEl, page.firstChild);
      }
      hintEl.textContent = dy > 60 ? '松手刷新' : '下拉刷新';
    }, { passive: true });
    const finish = () => {
      const should = pulling && dy > 60 && Math.abs(dx) < 50;
      tracking = false;
      pulling = false;
      if (should && hintEl) {
        hintEl.textContent = '刷新中…';
        setTimeout(() => { clearHint(); if (App.tab === 'browse' && App._browseReload) App._browseReload() }, 150);
      } else {
        clearHint();
      }
      dy = dx = 0;
    };
    box.addEventListener('touchend', finish, { passive: true });
    box.addEventListener('touchcancel', finish, { passive: true });
  }

  load(false);
};
