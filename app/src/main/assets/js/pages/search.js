/* search.js — P-03 搜索
   参数：{site, q}
     site 脚本 id（显式传，params.site 优先，其次 App.siteId）
     q    可选初始关键词（只回填输入框，等用户回车/点搜索再提交）
   职责：搜索框 + 历史 + 热门；结果统一走 P-01（App.replace('list', {...})），本页不渲染结果。
   7 态：loading（热门块骨架）/ ready / empty（无历史且无热门：提示输入关键词）
         / error（热门失败静默隐藏 = partial，不让整页报错）/ offline（无历史时整页离线态，有历史时顶部提示 + 历史可用）
         / invalid（无站点/站点停用/脚本损坏）/ partial（历史可用但热门加载失败被隐藏） */
(function () {
  'use strict';

  function firstLine(msg) {
    const s = String(msg == null ? '' : msg).trim();
    const i = s.indexOf('\n');
    return (i >= 0 ? s.slice(0, i) : s).trim();
  }
  function isInvalidMsg(msg) {
    return /脚本不存在|脚本为空|缺少\s*parse|语法错误/.test(String(msg || ''));
  }
  /* DB 没有「删单条历史」接口：用公开 API 重建（保持原有顺序：最旧先 pushSearch） */
  function removeHist(kw) {
    const keep = DB.searchHist().filter(function (x) { return x !== kw; });
    DB.clearSearch();
    for (let i = keep.length - 1; i >= 0; i--) DB.pushSearch(keep[i]);
  }

  App.pages['search'] = function (root, params, st) {
    params = params || {};
    const siteId = params.site || App.siteId;          // 站点显式，不依赖隐式「当前站点」
    const inst = { key: st ? st.key : 0, root: root, dead: false };
    if (st) st.cleanup = function () { inst.dead = true; };

    root.innerHTML = '';

    /* ---------- 顶部：搜索框 + 搜索按钮 + 取消 ---------- */
    const top = document.createElement('div');
    top.className = 'p3-top';
    top.innerHTML =
      '<div class="p3-field">' +
      '<input class="input p3-inp" id="p3kw" type="search" inputmode="search" autocomplete="off" ' +
      'placeholder="搜索内容 / 演员" autofocus>' +
      '<button class="p3-go" type="button">搜索</button>' +
      '</div>' +
      '<div class="p3-cancel" role="button">取消</div>';
    root.appendChild(top);

    const input = $('.p3-inp', top);
    if (params.q) input.value = String(params.q);
    $('.p3-cancel', top).onclick = function () { App.back(); };
    $('.p3-go', top).onclick = function () { submit(input.value); };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(input.value); }
    });
    /* Android WebView 的 autofocus 不一定生效，补一次聚焦（页面被替换时 input 已脱离文档，focus 无害） */
    setTimeout(function () { try { input.focus(); } catch (e) { } }, 80);

    const body = document.createElement('div');
    body.className = 'p3-body';
    body.innerHTML = '<div id="p3hint"></div><div id="p3hist"></div><div id="p3hot"></div><div id="p3empty"></div>';
    root.appendChild(body);

    const rec = siteId ? DB.site(siteId) : null;
    /* 没有任何站点：只保留可返回的搜索栏，主体 invalid（去脚本管理由 UI.state 绑定） */
    if (!siteId) {
      body.innerHTML = '';
      UI.state(body, 'invalid', { msg: '还没有可用站点，先去脚本管理添加' });
      return;
    }
    if (rec && rec.enabled === false) {
      body.innerHTML = '';
      UI.state(body, 'invalid', { msg: '该站点已停用' });
      return;
    }

    let cats = [];            // 热门标签（来自站点首页 cats）
    let hotState = 'loading'; // loading | ready | hidden | invalid
    let hotErr = '';

    function alive() {
      if (inst.dead || !root.isConnected) return false;
      const stack = App.stacks[App.tab];
      const top = stack && stack.length ? stack[stack.length - 1] : null;
      return !!top && top.key === inst.key;
    }

    /* ---------- 提交：统一交给 P-01 ---------- */
    function submit(raw) {
      const kw = String(raw == null ? '' : raw).trim();
      if (!kw) { UI.toast('输入关键词'); try { input.focus(); } catch (e) { } return; }
      if (!siteId) { UI.toast('还没有可用站点'); return; }
      const s = DB.site(siteId);
      if (s && s.enabled === false) { UI.toast('站点已停用'); return; }
      const url = Engine.searchUrl(siteId, kw);
      if (!url) { UI.toast('站点不支持搜索'); return; }
      DB.pushSearch(kw);
      Log.info('搜索：' + kw);
      App.replace('list', {
        site: siteId,
        url: url,
        title: '搜索：' + kw,
        emptyText: '没有找到相关内容'
      });
    }

    /* ---------- 离线提示（有历史时保留历史，只在顶部提示） ---------- */
    function renderHint() {
      const box = $('#p3hint', body);
      if (!box) return;
      if (navigator.onLine === false && DB.searchHist().length) {
        box.innerHTML = '<div class="p3-hint"><span>📵 网络不可用</span><b data-net>去设置网络</b></div>';
        const b = $('[data-net]', box);
        if (b) b.onclick = function () { App.go('settings.net'); };
      } else {
        box.innerHTML = '';
      }
    }

    /* ---------- 搜索历史（单条删除 + 清空二次确认） ---------- */
    function renderHist() {
      const box = $('#p3hist', body);
      if (!box) return;
      const hist = DB.searchHist();
      if (!hist.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="sec"><div class="sec-h"><h3>搜索历史</h3>' +
        '<s class="more" data-clear>清空</s></div><div class="p3-hist">' +
        hist.map(function (k, i) {
          return '<div class="p3-hrow" data-i="' + i + '">' +
            '<span class="p3-hico">🕘</span><span class="p3-htxt">' + esc(k) + '</span>' +
            '<span class="p3-hdel" data-del="' + i + '">✕</span></div>';
        }).join('') + '</div></div>';

      $$('.p3-hrow', box).forEach(function (el) {
        const kw = hist[+el.dataset.i];
        el.onclick = function () { input.value = kw; submit(kw); };
        const x = $('[data-del]', el);
        if (x) x.onclick = function (e) {
          e.stopPropagation();
          removeHist(kw);
          renderAll();
        };
      });
      const clr = $('[data-clear]', box);
      if (clr) clr.onclick = function (e) {
        e.stopPropagation();
        UI.dialog({
          title: '清空搜索历史',
          msg: '清空后无法恢复',
          okText: '清空',
          danger: true,
          onOk: function () {
            DB.clearSearch();
            renderAll();
            UI.toast('已清空');
          }
        });
      };
    }

    /* ---------- 热门标签（Engine.homeUrl → cats；失败隐藏 = partial） ---------- */
    function renderHot() {
      const box = $('#p3hot', body);
      if (!box) return;
      if (hotState === 'loading') {
        box.innerHTML = '<div class="sec"><div class="sec-h"><h3>热门</h3></div><div class="p3-chips">' +
          '<div class="sk p3-chip-sk"></div>'.repeat(4) + '</div></div>';
      } else if (hotState === 'ready' && cats.length) {
        box.innerHTML = '<div class="sec"><div class="sec-h"><h3>热门</h3></div><div class="p3-chips">' +
          cats.map(function (c, i) {
            return '<b class="p3-chip" data-i="' + i + '">' + esc(c.title) + '</b>';
          }).join('') + '</div></div>';
        $$('.p3-chip', box).forEach(function (el) {
          const c = cats[+el.dataset.i];
          el.onclick = function () {
            if (c.url) {
              App.go('list', { site: siteId, url: c.url, title: c.title || '', emptyText: '没有找到相关内容' });
            } else {
              input.value = c.title || '';
              submit(c.title);
            }
          };
        });
      } else if (hotState === 'invalid') {
        box.innerHTML = '';
        UI.state(box, 'invalid', { msg: hotErr || '该站点脚本已失效' });
      } else {
        box.innerHTML = '';
      }
    }

    /* ---------- 空态 / 离线态（整页唯一主体为空时） ---------- */
    function updateEmpty() {
      const box = $('#p3empty', body);
      if (!box) return;
      const hist = DB.searchHist();
      if (hotState === 'loading' || cats.length || hotState === 'invalid' || hist.length) {
        box.innerHTML = '';
        return;
      }
      if (navigator.onLine === false) UI.state(box, 'offline');
      else UI.state(box, 'empty', { msg: '输入关键词开始搜索', noBtn: true });
    }

    function renderAll() {
      /* 本页数据都在本地（历史），只有热门是远程；这里兜底极端的渲染/存储异常 → error 态 */
      try {
        renderHint();
        renderHist();
        renderHot();
        updateEmpty();
      } catch (e) {
        body.innerHTML = '';
        UI.state(body, 'error', {
          msg: firstLine(e && e.message) || '搜索页渲染失败',
          trace: (e && e.stack) || '',
          retry: function () { App.refresh(); }
        });
      }
    }

    /* ---------- 拉热门 ---------- */
    async function loadHot() {
      if (navigator.onLine === false) {
        hotState = 'hidden';
        renderAll();
        return;
      }
      const home = Engine.homeUrl(siteId) || ((DB.site(siteId) || {}).site || '');
      if (!home) {
        hotState = 'hidden';
        renderAll();
        return;
      }
      let res;
      try {
        res = await Engine.run(siteId, home);
      } catch (e) {
        res = { ok: false, error: e && e.message ? e.message : String(e) };
      }
      if (!alive()) return;

      if (res && res.ok && res.data && Array.isArray(res.data.cats)) {
        cats = res.data.cats.filter(function (c) { return c && c.title; }).slice(0, 20);
        hotState = cats.length ? 'ready' : 'hidden';
      } else {
        const msg = (res && res.error) || '';
        if (res && res.ok) hotState = 'hidden';          // 结构不对：静默隐藏（partial）
        else if (isInvalidMsg(msg)) { hotErr = firstLine(msg); hotState = 'invalid'; }
        else hotState = 'hidden';                        // 网络/解析失败：隐藏热门块，不整页报错
      }
      renderAll();
    }

    renderAll();
    loadHot();                                           // 不 return Promise：避免页面被 replace 后 core 再改滚动
  };

  App.pages['search']._util = {
    removeHist: removeHist,
    isInvalidMsg: isInvalidMsg
  };
})();
