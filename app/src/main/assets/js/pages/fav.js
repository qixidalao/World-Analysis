/* fav.js — T-3 收藏（收藏 / 历史 两段切换）
   数据源：本地 DB.fav() / DB.hist() / DB.lastProgress()，**不发网络请求**。
   收藏段：两列网格（C-05/C-06），点 → 详情，长按 → 取消收藏（二次确认）。
   历史段：行式列表（缩略图 92×58 + 标题 + 「看到 12:34」+ ▶ 继续），清空需二次确认。
   7 态：本页纯本地数据 → loading / offline / invalid 不适用；
        ready、empty（无收藏 / 无历史）、error（渲染异常）、partial（缩略图失败降级为占位块）已实现。 */
(function () {
  const SEG_KEY = 'rouparser.favSeg';   // 记住上次分段；与 home.js「继续观看 → 全部」共用
  const LONG_PRESS = 480;               // 长按判定阈值（ms）

  const LS = {
    get(k) { try { return localStorage.getItem(k) } catch (e) { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch (e) { } }
  };

  function firstLine(s) { return String(s == null ? '' : s).split('\n')[0].slice(0, 120) }
  function idOfUrl(u) {
    const m = String(u || '').match(/\/(?:v|hls)\/([0-9a-zA-Z_-]{6,48})/);
    return m ? m[1] : '';
  }
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
  App.tabs['fav'] = function (root) {
    root.innerHTML = '';
    try {
      render(root);
    } catch (e) {
      Log.err('收藏页渲染失败: ' + e.message);
      root.innerHTML = '';
      UI.state(root, 'error', { msg: '收藏页加载失败：' + firstLine(e.message), retry: () => App.renderTab() });
    }
  };

  function render(root) {
    const seg = LS.get(SEG_KEY) === 'hist' ? 'hist' : 'fav';
    const fav = DB.fav();
    const hist = DB.hist();
    const isHist = seg === 'hist';

    /* 顶栏：标题随分段变化；「清空」只对历史段有意义（DB.clearHist） */
    const right = isHist && hist.length ? [{ i: '清空', act: 'clear', cls: 'txtico', on: askClearHist }] : [];
    root.appendChild(UI.topbar({ back: false, title: isHist ? '历史' : '收藏', right: right }));

    const body = document.createElement('div');
    root.appendChild(body);
    body.innerHTML =
      '<div class="seg lg"><b data-seg="fav" class="' + (isHist ? '' : 'on') + '">收藏 ' + fav.length + '</b>' +
      '<b data-seg="hist" class="' + (isHist ? 'on' : '') + '">历史 ' + hist.length + '</b></div>' +
      '<div data-pane></div><div class="tab-end"></div>';

    $$('[data-seg]', body).forEach(b => {
      b.onclick = () => {
        const next = b.dataset.seg;
        if (next === seg) return;
        LS.set(SEG_KEY, next);
        App.renderTab();      // 重渲染（顶栏「清空」按钮也跟着变）
      };
    });

    const pane = $('[data-pane]', body);
    if (isHist) renderHist(pane, hist);
    else renderFav(pane, fav);
  }

  /* ---------------- 收藏段：两列网格 + 长按取消 ---------------- */
  function renderFav(pane, fav) {
    if (!fav.length) {
      UI.state(pane, 'empty', { title: '还没有收藏', msg: '看到喜欢的就点个♥，这里会攒起来', btn: '去逛逛', retry: () => App.setTab('browse') });
      return;
    }
    pane.innerHTML = '<div class="pad">' + UI.grid(fav) + '</div>';
    UI.bindCards(pane);                 // 点卡片 → App.go('detail', {url, site})
    bindLongPress(pane, fav);
  }

  function bindLongPress(pane, fav) {
    $$('.card[data-u]', pane).forEach(el => {
      const orig = el.onclick;
      /* 长按后短时间吞掉这次 click，避免弹完确认框又跳详情 */
      el.onclick = () => {
        if (el._longPress) { el._longPress = false; return }
        if (orig) orig();
      };
      let timer = null;
      const stop = () => clearTimeout(timer);
      el.addEventListener('touchstart', () => {
        stop();
        timer = setTimeout(() => {
          el._longPress = true;
          setTimeout(() => { el._longPress = false }, 700);
          askRemove(el.dataset.u, fav);
        }, LONG_PRESS);
      }, { passive: true });
      el.addEventListener('touchend', stop);
      el.addEventListener('touchmove', stop, { passive: true });
      el.addEventListener('touchcancel', stop);
      /* 桌面调试：右键等价长按 */
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        el._longPress = true;
        setTimeout(() => { el._longPress = false }, 700);
        askRemove(el.dataset.u, fav);
      });
    });
  }

  function askRemove(url, fav) {
    const it = (fav || DB.fav()).filter(x => x.url === url)[0] || {};
    UI.dialog({
      title: '取消收藏',
      msg: '「' + (it.title || '这个视频') + '」将从收藏里移除',
      okText: '取消收藏',
      danger: true,
      onOk: () => {
        DB.toFav({ url: url });       // toFav 是切换语义：已收藏 → 移除
        UI.toast('已取消收藏');
        App.renderTab();
      }
    });
  }

  /* ---------------- 历史段：行式列表 ---------------- */
  function renderHist(pane, hist) {
    if (!hist.length) {
      UI.state(pane, 'empty', { title: '暂无观看记录', msg: '看过的内容会出现在这里，方便继续', btn: '去逛逛', retry: () => App.setTab('browse') });
      return;
    }
    pane.innerHTML = hist.map(histRowHTML).join('');
    $$('[data-u]', pane).forEach(row => {
      row.onclick = () => openDetail(row);
      const pl = $('[data-play]', row);
      if (pl) pl.onclick = e => { e.stopPropagation(); openDetail(row); };
    });
  }

  function histRowHTML(it) {
    const p = progressOf(it);
    const pct = p && p.dur ? Math.min(100, Math.round(p.pos / p.dur * 100)) : 0;
    const pic = it.pic
      ? '<img loading="lazy" src="' + esc(it.pic) + '" alt="" onerror="this.style.display=\'none\'">'
      : '<div class="phg phg-full"></div>';
    const meta = p
      ? '看到 ' + fmtTime(p.pos) + (p.dur ? ' / ' + fmtTime(p.dur) : '')
      : '未开始 · ' + ago(it.at);
    return '<div class="hrow" data-u="' + esc(it.url || '') + '" data-site="' + esc(it.site || '') +
      '" data-pos="' + (p ? p.pos : 0) + '">' +
      '<div class="pic">' + pic + (p ? '<div class="prog"><i style="width:' + pct + '%"></i></div>' : '') + '</div>' +
      '<div class="t"><div class="nm lines2">' + esc(it.title || '未命名') + '</div>' +
      '<div class="ds">' + esc(meta) + '</div></div>' +
      '<div class="pl" data-play>▶</div></div>';
  }

  /* 点行 / 点 ▶：统一进详情；有进度时传 {resume:true, startPos}，详情页优先续播 */
  function openDetail(row) {
    const url = row.dataset.u;
    if (!url) return UI.toast('缺少详情地址');
    const pos = +row.dataset.pos || 0;
    const params = { url: url, site: row.dataset.site || App.siteId };
    if (pos > 0) { params.resume = true; params.startPos = pos }
    App.go('detail', params);
  }

  function askClearHist() {
    const n = DB.hist().length;
    UI.dialog({
      title: '清空历史',
      msg: '清空后不可恢复，共 ' + n + ' 条观看记录',
      okText: '清空',
      danger: true,
      onOk: () => {
        DB.clearHist();
        UI.toast('已清空历史');
        App.renderTab();
      }
    });
  }
})();
