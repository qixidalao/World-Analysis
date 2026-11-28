/* detail.js — P-02 详情（kind: video/audio/image/novel 分发）
   数据源：Engine.run(site, url) → {type:'detail', detail:{kind,title,pic,desc,play,episodes,tags,series}} */
App.pages['detail'] = function (root, params) {
  const siteId = params.site || App.siteId;
  const url = params.url;
  root.innerHTML = '';
  const back = UI.topbar({ title: '', solid: false });
  back.style.position = 'absolute'; back.style.left = '0'; back.style.right = '0';
  back.style.zIndex = '20';
  root.appendChild(back);
  const body = document.createElement('div');
  body.innerHTML = UI.skeleton('rows');
  root.appendChild(body);

  if (!url) { UI.state(body, 'error', { msg: '缺少详情地址' }); return }

  let killed = false;
  const st = App.stacks[App.tab][App.stacks[App.tab].length - 1];
  if (st) st.cleanup = () => { killed = true };

  function openPlayer(d, epIndex) {
    const eps = d.episodes || [];
    const ep = epIndex || 0;
    const target = eps[ep] || null;
    const play = d.play || (target && target.url) || '';
    if (!play && target) { /* 选集是详情页地址时，进详情再播 */ }
    App.go('player', {
      site: siteId, url: target ? target.url : url, id: (d.id || idOfUrl(url) || url),
      ep: ep, play: play, title: d.title || '', series: d.series || '',
      episodes: eps, lines: d.lines || [], related: d.related || [], startPos: params.startPos || 0
    });
  }

  function idOfUrl(u) {
    const m = String(u || '').match(/\/(?:v|hls)\/([0-9a-zA-Z]{6,48})/);
    return m ? m[1] : '';
  }

  function render(d) {
    const eps = d.episodes || [], tags = d.tags || [], related = d.related || [];
    const prog = DB.lastProgress(siteId, idOfUrl(url) || url);
    const resumable = prog && prog.pos > 30 && DB.cfg().play.resume;
    const meta = (d.desc || '').split('\n')[0].slice(0, 90);
    const showDesc = (d.desc || '').length > 110;

    /* 脚本预设 UI：detail.blocks 存在时按组件块渲染，不再套默认详情模板 */
    if (Array.isArray(d.blocks) && d.blocks.length) {
      body.innerHTML = '<div class="cb-wrap">' + UI.blocks(d.blocks) + '</div><div style="height:24px"></div>';
      UI.bindBlocks(body, {
        play: () => openPlayer(d, 0),
        open: (u) => App.go('detail', { url: u, site: siteId })
      });
      DB.pushHist({ site: siteId, id: idOfUrl(url) || url, title: d.title, pic: d.pic, url: url });
      return;
    }

    body.innerHTML = `
      <div class="dt-hero">
        ${d.pic ? `<img src="${esc(d.pic)}" alt="" onerror="this.style.display='none'">` : `<div class="phg" style="position:absolute;inset:0"></div>`}
        <div class="dt-mask"></div>
      </div>
      <div class="dt-main">
        <h1 class="dt-title">${esc(d.title || '未命名')}</h1>
        ${meta ? `<div class="dt-meta">${esc(meta)}</div>` : ''}
        ${showDesc ? `<div class="dt-desc lines3" id="desc">${esc(d.desc)}</div><div class="dt-more" id="descMore">展开</div>` : ''}
        <button class="btn pri block dt-play" id="play" ${d.play || eps.length ? '' : 'disabled'}>
          ${d.play || eps.length ? '▶ 立即播放' : '暂无播放源'}
        </button>
        ${resumable ? `<div class="dt-resume" id="resume">上次看到 ${fmtTime(prog.pos)} · 继续播放</div>` : ''}
        <div class="dt-acts">
          <button class="btn ghost" id="fav">${DB.isFav(url) ? '♥ 已收藏' : '♡ 收藏'}</button>
          <button class="btn ghost" id="share">⤴ 分享</button>
        </div>
      </div>
      ${eps.length ? `<div class="sec"><div class="sec-h"><h3>选集</h3><s>共 ${eps.length} 集</s></div>
        <div class="eps">${eps.map((e, i) => `<b data-ep="${i}" class="${i === 0 ? 'on' : ''}">${esc(e.title || ('第' + (i + 1) + '集'))}</b>`).join('')}</div></div>` : ''}
      ${related.length ? `<div class="sec"><div class="sec-h"><h3>相关视频</h3><s>${related.length} 个</s></div>${UI.grid(related.slice(0, 6).map(x => Object.assign({ site: siteId }, x)))}</div>` : ''}
      ${tags.length ? `<div class="sec"><div class="sec-h"><h3>相关标签</h3></div>
        <div class="eps">${tags.slice(0, 16).map(t => `<b data-tag="${esc(t.url || '')}"># ${esc(t.title)}</b>`).join('')}</div></div>` : ''}
      <div style="height:24px"></div>`;

    const dm = $('#descMore', body);
    if (dm) dm.onclick = () => {
      const el = $('#desc', body);
      const open = el.classList.contains('lines3');
      el.classList.toggle('lines3', !open);
      dm.textContent = open ? '收起' : '展开';
    };
    $('#play', body).onclick = () => openPlayer(d, 0);
    const rs = $('#resume', body);
    if (rs) rs.onclick = () => {
      const ep = prog.ep || 0;
      App.go('player', {
        site: siteId, url: (eps[ep] && eps[ep].url) || url, id: idOfUrl(url) || url,
        ep: ep, play: d.play, title: d.title, series: d.series, episodes: eps, related: d.related || [], startPos: prog.pos
      });
    };
    $('#fav', body).onclick = e => {
      const on = DB.toFav({ site: siteId, title: d.title, pic: d.pic, url: url });
      e.target.textContent = on ? '♥ 已收藏' : '♡ 收藏';
      UI.toast(on ? '已收藏' : '已取消收藏');
    };
    $('#share', body).onclick = () => {
      const txt = d.title + ' ' + url;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => UI.toast('已复制链接'), () => UI.toast('复制失败'));
      else UI.toast('复制失败：请长按地址手动复制');
    };
    $$('[data-tag]', body).forEach(el => el.onclick = () => {
      const u = el.dataset.tag;
      if (u) App.go('list', { site: siteId, url: u, title: el.textContent.replace(/^#\s*/, '') });
    });
    $$('[data-ep]', body).forEach(el => el.onclick = () => {
      $$('[data-ep]', body).forEach(x => x.classList.remove('on'));
      el.classList.add('on');
      openPlayer(d, +el.dataset.ep);
    });
    UI.bindCards(body);

    DB.pushHist({ site: siteId, id: idOfUrl(url) || url, title: d.title, pic: d.pic, url: url });
  }

  async function load() {
    Log.info('详情请求 ' + url);
    let res;
    const cached = App.cachePageGet(siteId, url);
    if (cached) res = { ok: true, data: cached, cached: true };
    else {
      res = await Engine.run(siteId, url);
      if (res && res.ok && res.data) App.cachePagePut(siteId, url, res.data);
    }
    if (killed) return;
    if (!res.ok) {
      Log.err('详情失败 ' + url + ' ' + res.error);
      if (navigator.onLine === false) return UI.state(body, 'offline');
      return UI.state(body, 'error', { msg: res.error, trace: res.trace, retry: load });
    }
    const data = res.data || {};
    if (data.type === 'player') {
      return App.go('player', { site: siteId, url: url, play: data.play, title: data.title || '' });
    }
    const d = data.detail || (data.type === 'detail' ? data.detail : data);
    if (!d) return UI.state(body, 'empty', { msg: '没有解析到内容' });
    Log.info('详情结果 ' + (d.title || '(无标题)') + ' play=' + (d.play ? 'yes' : 'no') + ' eps=' + ((d.episodes || []).length));

    /* 媒体类型分发（docs/09 §1） */
    const kind = d.kind || 'video';
    if (kind === 'image' || kind === 'images') return App.replace('images', { detail: d, site: siteId });
    if (kind === 'audio') return App.replace('audio', { detail: d, site: siteId });
    if (kind === 'novel' || kind === 'book') return App.replace('book', { detail: d, site: siteId, url: url });

    render(d);
  }

  load();
};
