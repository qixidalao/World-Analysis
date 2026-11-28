/* list.js — P-01 列表（分类 / 搜索 / 更多）
   参数：{site, url, title, more, emptyText}
     site      脚本 id（显式传，params.site 优先，其次 App.siteId）
     url       列表页地址（more 仅作缺省回退）
     title     可选显示名；没有时用返回数据里的 title
     emptyText 空态文案（搜索页传「没有找到相关内容」，默认「这个分类暂无内容」）
   数据：Engine.run(site, url) → {type:'list', title, cards:[{title,pic,desc,url}]}
   7 态：loading 骨架 / ready / empty / error（首行 + 重试 + 堆栈）/ offline（navigator.onLine === false）
         / invalid（脚本不存在、缺少 parse 等）/ partial（后续页失败：保留已有卡片 + 底部重试条）
   分页：pageNo 从 1 开始；滚动到距底 200px 自动加载下一页；rule 站点用 rule.page.param，否则 page；
         下一页 URL = url + (&|?)param=n；合并时按卡片 url 去重；无新增 → 「— 到底了 —」并停止。 */
(function () {
  'use strict';

  const PAGE_EDGE = 200;   // 距底多少像素触发自动加载
  let scrollCtl = null;    // 当前列表实例：#pageview 上同一时刻只挂一个监听，避免多层栈串页

  /* 错误只显示首行（docs/08：错误 = 「<做什么>失败：<首行错误>」） */
  function firstLine(msg) {
    const s = String(msg == null ? '' : msg).trim();
    const i = s.indexOf('\n');
    return (i >= 0 ? s.slice(0, i) : s).trim();
  }
  /* 这些错误说明脚本本身坏了 → invalid，而不是网络/解析错误 */
  function isInvalidMsg(msg) {
    return /脚本不存在|脚本为空|缺少\s*parse|语法错误/.test(String(msg || ''));
  }
  /* 分页参数名：rule 类型站点读 rule.page.param（如 fypage），其余默认 page */
  function pageParamOf(siteId) {
    const s = DB.site(siteId);
    if (s && s.type === 'rule' && s.rule && s.rule.page && s.rule.page.param) return String(s.rule.page.param);
    return 'page';
  }
  /* 构造下一页地址：已有 ? 用 &，否则用 ? */
  function nextPageUrl(base, param, n) {
    const u = String(base || '');
    if (!u) return '';
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + encodeURIComponent(param || 'page') + '=' + n;
  }
  /* 按 url 去重合并：把新增项并入 cards，返回新增项（空 url 的卡片无法跳转，直接丢弃） */
  function mergeCards(cards, incoming, seen) {
    const fresh = [];
    (incoming || []).forEach(function (c) {
      if (!c || !c.url) return;
      const u = String(c.url);
      if (seen[u]) return;
      seen[u] = 1;
      fresh.push(c);
    });
    if (cards) fresh.forEach(function (c) { cards.push(c); });
    return fresh;
  }

  /* #pageview 滚动：只有「当前栈顶 + 自己的 DOM 还在」时才触发加载 */
  function onPageScroll() {
    const c = scrollCtl;
    if (!c || c.dead) return;
    const box = $('#pageview');
    if (!box || !c.root.isConnected) return;
    const stack = App.stacks[App.tab];
    const top = stack && stack.length ? stack[stack.length - 1] : null;
    if (!top || top.key !== c.key) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight > PAGE_EDGE) return;
    c.reachBottom();
  }
  function detachScroll() {
    const box = $('#pageview');
    if (box) box.removeEventListener('scroll', onPageScroll);
    scrollCtl = null;
  }
  function attachScroll(c) {
    detachScroll();                    // 先移除上一个列表实例的监听
    scrollCtl = c;
    const box = $('#pageview');
    if (box) box.addEventListener('scroll', onPageScroll, { passive: true });
  }

  App.pages['list'] = function (root, params, st) {
    params = params || {};
    const siteId = params.site || App.siteId;         // 站点必须显式，不隐式依赖「当前站点」
    const listUrl = params.url || params.more || '';
    const emptyText = params.emptyText || '这个分类暂无内容';

    const inst = {
      key: st ? st.key : 0,
      root: root,
      dead: false,
      reachBottom: function () { loadNext(); }
    };
    if (st) st.cleanup = function () {                 // 页面离开：停掉监听与本实例
      inst.dead = true;
      if (scrollCtl === inst) detachScroll();
    };

    let cards = [];
    let seen = Object.create(null);
    let pageNo = 0;
    let loading = false;
    let ended = false;
    let failedPage = 0;
    let lastErr = '';
    let autoFills = 0;
    let title = params.title || '列表';

    root.innerHTML = '';
    const bar = UI.topbar({ title: esc(params.title || '列表') });
    root.appendChild(bar);
    const tt = $('.tt', bar);
    const body = document.createElement('div');
    body.className = 'list-body';
    body.innerHTML = UI.skeleton('list');
    root.appendChild(body);

    function setTitle(t) {
      if (!t) return;
      title = String(t);
      if (tt) tt.textContent = title;
    }
    /* 本页仍是「当前活跃页」：没被清理、DOM 还在、且位于当前 Tab 栈顶 */
    function alive() {
      if (inst.dead || !root.isConnected) return false;
      const stack = App.stacks[App.tab];
      const top = stack && stack.length ? stack[stack.length - 1] : null;
      return !!top && top.key === inst.key;
    }

    /* ---------------- 7 态渲染 ---------------- */
    function renderInvalid(msg) {
      body.innerHTML = '';
      UI.state(body, 'invalid', { msg: msg || '脚本被删除或禁用' });
    }
    function renderOffline() {
      body.innerHTML = '';
      UI.state(body, 'offline');
    }
    function renderEmpty() {
      body.innerHTML = '';
      UI.state(body, 'empty', { msg: emptyText, retry: function () { loadFirst(); } });
    }
    function renderFail(res) {
      const msg = (res && res.error) || '未知错误';
      if (isInvalidMsg(msg)) return renderInvalid(msg);
      if (navigator.onLine === false) return renderOffline();
      body.innerHTML = '';
      UI.state(body, 'error', {
        msg: firstLine(msg) || '解析失败',
        trace: (res && res.trace) || '',
        retry: function () { loadFirst(); }
      });
    }
    /* 底部状态：加载中 / 到底 / 失败重试 / 空 */
    function renderFoot(kind, msg) {
      const foot = $('#listFoot', body);
      if (!foot) return;
      if (kind === 'loading') {
        foot.innerHTML = '<span class="spin"></span><span>加载中…</span>';
      } else if (kind === 'end') {
        foot.innerHTML = '<span class="p1-end">— 到底了 —</span>';
      } else if (kind === 'fail') {
        foot.innerHTML = '<span class="p1-err">加载失败：' + esc(firstLine(msg) || '未知错误') + '</span>' +
          '<button class="btn ghost p1-retry" type="button">重试</button>';
        const btn = $('.p1-retry', foot);
        if (btn) btn.onclick = function () { retryFailed(); };
      } else {
        foot.innerHTML = '';
      }
    }
    function renderReady() {
      body.innerHTML = '<div class="pad">' +
        '<div class="p1-meta"><b>' + esc(title) + '</b><span>·</span><span>' + cards.length + ' 个结果</span></div>' +
        UI.grid(cards) +
        '</div><div class="p1-foot" id="listFoot"></div>';
      UI.bindCards(body);
      /* bindCards 默认用 App.siteId 跳详情；这里显式带上本页的 site，避免跨站点串味 */
      $$('.card[data-u]', body).forEach(function (el) {
        el.onclick = function () { App.go('detail', { url: el.dataset.u, site: siteId }); };
      });
      if (loading) renderFoot('loading');
      else if (ended) renderFoot('end');
      else if (failedPage) renderFoot('fail', lastErr);
      else renderFoot('');
    }

    /* ---------------- 首屏 ---------------- */
    async function loadFirst() {
      if (inst.dead) return;
      if (scrollCtl === inst) detachScroll();
      cards = [];
      seen = Object.create(null);
      pageNo = 0;
      loading = true;
      ended = false;
      failedPage = 0;
      lastErr = '';
      autoFills = 0;
      body.innerHTML = UI.skeleton('list');

      if (!siteId) { loading = false; return renderInvalid('还没有可用站点，先去脚本管理添加'); }
      if (!listUrl) { loading = false; return renderInvalid('缺少列表地址'); }
      const rec = DB.site(siteId);
      if (rec && rec.enabled === false) { loading = false; return renderInvalid('该站点已停用'); }
      if (navigator.onLine === false) { loading = false; return renderOffline(); }

      let res;
      const cached = App.cachePageGet(siteId, listUrl);
      if (cached) res = { ok: true, data: cached };
      else {
        try {
          res = await Engine.run(siteId, listUrl);
          if (res && res.ok && res.data) App.cachePagePut(siteId, listUrl, res.data);
        } catch (e) {
          res = { ok: false, error: e && e.message ? e.message : String(e) };
        }
      }
      if (!alive()) return;
      loading = false;
      if (!res || !res.ok) return renderFail(res);

      const d = res.data || {};
      if (!params.title && d.title) setTitle(d.title);
      if (!Array.isArray(d.cards)) {
        body.innerHTML = '';
        UI.state(body, 'error', {
          msg: '返回的不是列表（type=' + esc(d.type || '未知') + '）',
          retry: function () { loadFirst(); }
        });
        return;
      }

      mergeCards(cards, d.cards, seen);
      pageNo = 1;
      if (!cards.length) return renderEmpty();

      renderReady();
      attachScroll(inst);
      maybeFill();                       // 首屏太短时补一页，否则用户没得滚
    }

    /* ---------------- 下一页 ---------------- */
    async function loadPage(n) {
      if (loading || ended || inst.dead) return;
      loading = true;
      failedPage = 0;
      renderFoot('loading');

      const u = nextPageUrl(listUrl, pageParamOf(siteId), n);
      let res;
      try {
        res = await Engine.run(siteId, u);
      } catch (e) {
        res = { ok: false, error: e && e.message ? e.message : String(e) };
      }
      if (!alive()) { loading = false; return; }

      if (!res || !res.ok) {
        loading = false;
        failedPage = n;
        lastErr = (res && res.error) || '未知错误';
        renderFoot('fail', lastErr);
        return;
      }

      const d = res.data || {};
      if (!Array.isArray(d.cards)) {
        loading = false;
        failedPage = n;
        lastErr = '返回的不是列表';
        renderFoot('fail', lastErr);
        return;
      }

      const fresh = mergeCards(cards, d.cards, seen);
      loading = false;
      if (!fresh.length) {               // 全是已出现过的卡片 → 到底
        ended = true;
        pageNo = n;
        renderFoot('end');
        return;
      }

      pageNo = n;
      if (!params.title && d.title && title === '列表') setTitle(d.title);
      renderReady();
      maybeFill();
    }

    function loadNext() {
      if (!alive() || loading || ended || failedPage) return;
      loadPage(pageNo + 1);
    }
    /* 失败后重试「本页」，不是从头来 */
    function retryFailed() {
      if (!alive() || loading || !failedPage) return;
      loadPage(failedPage);
    }
    /* 首屏/每页加载后，如果还够不着 200px 阈值（内容太短），最多自动补 2 页 */
    function maybeFill() {
      if (!alive() || loading || ended || failedPage || autoFills >= 2) return;
      const box = $('#pageview');
      if (!box) return;
      if (box.scrollHeight - box.scrollTop - box.clientHeight > PAGE_EDGE) return;
      autoFills++;
      setTimeout(function () {
        if (!alive() || loading || ended || failedPage) return;
        loadPage(pageNo + 1);
      }, 60);
    }

    return loadFirst();
  };

  /* 纯函数暴露给离线自测脚本（见交付说明），页面本身不依赖。 */
  App.pages['list']._util = {
    nextPageUrl: nextPageUrl,
    mergeCards: mergeCards,
    pageParamOf: pageParamOf
  };
})();
