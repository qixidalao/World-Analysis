/* media.js — P-21 图片查看器 / P-22 音频播放器 / P-23 阅读器
   规格：docs/09 §1-§4（数据结构、手势、TTS）、docs/07 P-21/22/23、docs/08（token）
   三个页面都是独立全屏覆盖层（position:fixed，z-index 低于 #sheet=80 / #dialog=90 / #toast=95），
   进入路由：detail.js 里 kind=image/audio/novel 时 App.replace('images'|'audio'|'book', {...})。 */
(function () {
  'use strict';

  /* ================= 通用小工具 ================= */
  function firstLine(s) { return String(s == null ? '' : s).split('\n')[0].slice(0, 120) }

  function normImages(list) {
    const out = [];
    (list || []).forEach(function (it) {
      if (!it) return;
      if (typeof it === 'string') { out.push({ url: it, thumb: it }); return }
      const url = it.url || it.src || it.big || '';
      if (!url) return;
      out.push({ url: url, thumb: it.thumb || it.thumbnail || it.small || url, w: it.w, h: it.h });
    });
    return out;
  }

  function normItems(list) {
    const out = [];
    (list || []).forEach(function (it) {
      if (!it) return;
      if (typeof it === 'string') { out.push({ title: '', url: it }); return }
      const url = it.url || it.src || it.play || '';
      if (!url) return;
      out.push({ title: it.title || '', url: url, duration: it.duration || 0 });
    });
    return out;
  }

  function normChapters(list) {
    const out = [];
    (list || []).forEach(function (it, i) {
      if (!it) return;
      if (typeof it === 'string') { out.push({ title: '第' + (i + 1) + '章', url: it }); return }
      out.push({ title: it.title || ('第' + (i + 1) + '章'), url: it.url || it.src || '' });
    });
    return out;
  }

  /* 稳定短 hash：阅读进度 / bookId 用 */
  function hashStr(s) {
    let h = 5381;
    const t = String(s || '');
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
    return 'b' + Math.abs(h).toString(36);
  }

  /* ==== 纯函数区：HTML → 纯文本（离线可测） ==== */
  function htmlToText(html) {
    let s = String(html == null ? '' : html);
    if (s.indexOf('<') < 0) return s.replace(/\r\n/g, '\n').trim();
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|section|article|h[1-6]|li|blockquote|tr)>/gi, '\n\n');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#0*39;/g, "'").replace(/&#x27;/gi, "'")
      .replace(/&amp;/gi, '&');
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }
  /* ==== 纯函数区结束 ==== */

  function copyText(txt, okMsg, failMsg) {
    const ok = function () { UI.toast(okMsg || '已复制') };
    const bad = function () { UI.toast(failMsg || '复制失败') };
    const fallback = function () {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, String(txt).length);
        const good = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        if (good) ok(); else bad();
      } catch (e) { bad() }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(ok, fallback);
      return;
    }
    fallback();
  }

  function statusState(el, text) {
    el.innerHTML = '<i class="spin"></i><span>' + esc(text) + '</span>';
    el.classList.add('on');
  }
  function hideState(el) { el.classList.remove('on'); el.innerHTML = '' }

  /* ============================================================
     P-21 图片查看器
     参数：{images:[{url,thumb}], index} 或 {detail:{images,...}}
     手势：左右滑翻页（scroll-snap）、双指缩放、双击放大、下滑关闭
     ============================================================ */
  App.pages['images'] = function (root, params, st) {
    params = params || {};
    const d = params.detail || {};
    const list = normImages(params.images || d.images || d.pics || []);
    const title = params.title || d.title || '';
    let cur = clamp(parseInt(params.index, 10) || parseInt(d.index, 10) || 0, 0, Math.max(0, list.length - 1));

    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'im-wrap';
    wrap.innerHTML = `
      ${list.length ? `<div class="im-track" id="imTrack">${list.map(function (it, i) {
        return `<div class="im-slide" data-i="${i}">
          ${it.thumb && it.thumb !== it.url ? `<img class="im-thumb" src="${esc(it.thumb)}" alt="">` : ''}
          <img class="im-full" src="${esc(it.url)}" alt="" draggable="false">
          <div class="im-err">图片加载失败</div>
        </div>`;
      }).join('')}</div>` : `<div class="im-empty">${UI.stateHTML('empty', { msg: '这个图集没有图片', noBtn: true })}</div>`}
      <div class="im-top">
        <div class="im-ico" data-back>‹</div>
        <div class="im-title">${esc(title)}</div>
        <div class="im-ico"></div>
      </div>
      <div class="im-foot">
        <span class="im-page" id="imPage">${list.length ? (cur + 1) + ' / ' + list.length : '0 / 0'}</span>
        <div class="im-acts">
          <button class="pl-btn" data-save>保存</button>
          <button class="pl-btn" data-share>分享</button>
        </div>
      </div>
    `;
    root.appendChild(wrap);

    const track = document.getElementById('imTrack');
    const pageEl = document.getElementById('imPage');
    let zoom = { scale: 1, tx: 0, ty: 0 };
    let pinch = null;
    let touch = null;
    let closing = 0;
    let lastTap = 0;

    function fullImg() {
      if (!track) return null;
      return $('.im-slide[data-i="' + cur + '"] .im-full', track);
    }
    function applyZoom() {
      const im = fullImg();
      if (!im) return;
      im.style.transform = zoom.scale > 1.01
        ? 'translate3d(' + zoom.tx + 'px,' + zoom.ty + 'px,0) scale(' + zoom.scale + ')'
        : '';
      track.classList.toggle('zoomed', zoom.scale > 1.01);
    }
    function zoomAnim(on) {
      const im = fullImg();
      if (im) im.style.transition = on ? '' : 'none';
    }
    function resetZoom() {
      zoom = { scale: 1, tx: 0, ty: 0 };
      const im = fullImg();
      if (im) { im.style.transform = ''; im.style.transition = '' }
      if (track) track.classList.remove('zoomed');
    }
    function preload(i) {
      if (i < 0 || i >= list.length) return;
      const im = new Image();
      im.src = list[i].url;
    }
    function updatePage() {
      if (!track || !list.length) return;
      const w = track.clientWidth || 1;
      const i = clamp(Math.round(track.scrollLeft / w), 0, list.length - 1);
      if (i !== cur) {
        resetZoom();
        cur = i;
        preload(cur + 1);
        preload(cur - 1);
      }
      pageEl.textContent = (cur + 1) + ' / ' + list.length;
    }

    if (track) {
      $$('.im-slide', track).forEach(function (s) {
        const full = $('.im-full', s);
        if (!full) return;
        full.addEventListener('load', function () { full.classList.add('loaded') });
        full.addEventListener('error', function () { s.classList.add('err') });
        if (full.complete && full.naturalWidth) full.classList.add('loaded');
      });

      track.addEventListener('scroll', function () { updatePage() }, { passive: true });
      setTimeout(function () {
        if (!track) return;
        track.scrollLeft = cur * track.clientWidth;
        pageEl.textContent = (cur + 1) + ' / ' + list.length;
        preload(cur + 1);
        preload(cur - 1);
      }, 30);

      track.addEventListener('touchstart', function (e) {
        if (e.touches.length === 2) {
          if (touch) touch = null;
          pinch = {
            d: Math.max(1, dist(e.touches)),
            s: zoom.scale,
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2
          };
          zoomAnim(false);
          e.preventDefault();
          return;
        }
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        touch = { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, t: Date.now(), moved: false, dir: '' };
        closing = 0;
        zoomAnim(false);
        if (zoom.scale > 1.01) track.classList.add('zoomed');
      }, { passive: false });

      track.addEventListener('touchmove', function (e) {
        if (pinch && e.touches.length === 2) {
          const dd = Math.max(1, dist(e.touches));
          zoom.scale = clamp(pinch.s * dd / pinch.d, 1, 4);
          if (zoom.scale <= 1.01) { zoom.tx = 0; zoom.ty = 0 }
          applyZoom();
          e.preventDefault();
          return;
        }
        if (!touch || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
        if (!touch.moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) touch.moved = true;
        if (!touch.moved) return;
        if (!touch.dir) touch.dir = Math.abs(dy) > Math.abs(dx) ? 'close' : 'page';
        if (zoom.scale > 1.01) {
          const w = track.clientWidth, h = track.clientHeight;
          const mx = (zoom.scale - 1) * w / 2, my = (zoom.scale - 1) * h / 2;
          zoom.tx = clamp(zoom.tx + (t.clientX - touch.lx), -mx, mx);
          zoom.ty = clamp(zoom.ty + (t.clientY - touch.ly), -my, my);
          touch.lx = t.clientX;
          touch.ly = t.clientY;
          applyZoom();
          e.preventDefault();
        } else if (touch.dir === 'close') {
          /* 下滑关闭（位移 >120px 关闭，否则弹回） */
          closing = Math.max(0, dy);
          wrap.style.transform = 'translateY(' + closing + 'px)';
          wrap.style.opacity = String(1 - Math.min(0.45, closing / 700));
          e.preventDefault();
        }
      }, { passive: false });

      track.addEventListener('touchend', function (e) {
        if (pinch) {
          if (e.touches.length < 2) {
            pinch = null;
            zoomAnim(true);
            if (zoom.scale <= 1.01) resetZoom();
            else applyZoom();
          }
          return;
        }
        if (!touch) return;
        const t = touch;
        touch = null;
        zoomAnim(true);
        if (zoom.scale > 1.01) { applyZoom(); return }
        if (closing > 120) { App.back(); return }
        if (closing > 0) {
          wrap.style.transform = '';
          wrap.style.opacity = '';
          closing = 0;
        }
        if (!t.moved && Date.now() - t.t < 300) {
          const now = Date.now();
          if (now - lastTap < 300) {
            lastTap = 0;
            toggleZoom(t.x, t.y);
          } else lastTap = now;
        }
      }, { passive: true });

      track.addEventListener('touchcancel', function () {
        pinch = null;
        touch = null;
        closing = 0;
        wrap.style.transform = '';
        wrap.style.opacity = '';
        zoomAnim(true);
      });
    }

    function dist(touches) {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function toggleZoom(x, y) {
      if (!track) return;
      if (zoom.scale > 1.01) { resetZoom(); return }
      const w = track.clientWidth, h = track.clientHeight;
      const cx = x - track.getBoundingClientRect().left - w / 2;
      const cy = y - track.getBoundingClientRect().top - h / 2;
      const s = 2.5;
      zoom.scale = s;
      zoom.tx = clamp(-cx * (s - 1), -(s - 1) * w / 2, (s - 1) * w / 2);
      zoom.ty = clamp(-cy * (s - 1), -(s - 1) * h / 2, (s - 1) * h / 2);
      zoomAnim(false);
      applyZoom();
      setTimeout(function () { zoomAnim(true) }, 30);
    }

    $('[data-back]', wrap).onclick = function () { App.back() };
    $('[data-save]', wrap).onclick = function () {
      /* 真正写相册要 Java 侧 MediaStore，WebView 版本不假装成功写库 */
      UI.toast('保存未接入');
    };
    $('[data-share]', wrap).onclick = function () {
      const it = list[cur];
      if (!it) return UI.toast('没有可复制的链接');
      copyText(it.url, '已复制链接', '复制失败');
    };

    if (st) {
      st.cleanup = function () {
        pinch = null;
        touch = null;
        zoom = { scale: 1, tx: 0, ty: 0 };
      };
    }
  };

  /* ============================================================
     P-22 音频播放器
     参数：{title, artist, cover, items:[{title,url}]} 或 {detail:{...}}
     <audio> 直链（m4a/mp3）；MediaSession/通知栏需要系统层，未接，UI 不假称支持
     ============================================================ */
  App.pages['audio'] = function (root, params, st) {
    params = params || {};
    if (typeof window.__rouAudioCleanup === 'function') {
      try { window.__rouAudioCleanup() } catch (e) { }
    }
    const d = params.detail || {};
    let items = normItems(params.items || d.items || []);
    const pUrl = params.url || d.play || '';
    if (!items.length && pUrl) items = [{ title: params.title || d.title || '', url: pUrl }];
    const title = params.title || d.title || '未命名音频';
    const artist = params.artist || d.artist || '';
    const cover = params.cover || d.cover || d.pic || '';
    const RATES = [1, 1.25, 1.5, 2, 0.75];
    let cur = 0;
    let seekHold = false;
    let sleepTimer = 0;
    let sleepMin = 0;
    let cleaned = false;

    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'au-wrap';
    wrap.innerHTML = `
      <div class="au-top">
        <div class="pl-ico" data-back>‹</div>
        <div class="au-top-t">音频播放</div>
        <div class="pl-ico" data-more>⋮</div>
      </div>
      <div class="au-cover">
        ${cover ? `<img src="${esc(cover)}" alt="">` : `<div class="au-noimg">🎧</div>`}
      </div>
      <div class="au-meta">
        <div class="au-title" id="auTitle">${esc(title)}</div>
        <div class="au-artist" id="auArtist">${esc(artist || (items.length > 1 ? items.length + ' 首' : ''))}</div>
      </div>
      <div class="au-prog">
        <input class="slider au-seek" id="auSeek" type="range" min="0" max="1000" value="0">
        <div class="au-times"><span id="auCur">0:00</span><span id="auDur">0:00</span></div>
      </div>
      <div class="au-ctl">
        <button class="au-btn" id="auPrev" aria-label="上一首">⏮</button>
        <button class="au-btn big" id="auPlay" aria-label="播放">▶</button>
        <button class="au-btn" id="auNext" aria-label="下一首">⏭</button>
      </div>
      <div class="au-foot">
        <button class="pl-btn" id="auRate">倍速 1×</button>
        <button class="pl-btn" id="auTimer">定时 关</button>
        <button class="pl-btn" id="auList">列表 ${items.length}</button>
      </div>
      <div class="au-err" id="auErr"><b>播放失败</b><span id="auErrMsg"></span><button class="btn ghost" data-retry>重试</button></div>
      <div class="au-empty" id="auEmpty"></div>
      <audio id="auAudio" preload="metadata"></audio>
    `;
    root.appendChild(wrap);

    const audio = document.getElementById('auAudio');
    const titleEl = document.getElementById('auTitle');
    const artistEl = document.getElementById('auArtist');
    const seek = document.getElementById('auSeek');
    const tCur = document.getElementById('auCur');
    const tDur = document.getElementById('auDur');
    const playBtn = document.getElementById('auPlay');
    const rateBtn = document.getElementById('auRate');
    const timerBtn = document.getElementById('auTimer');
    const listBtn = document.getElementById('auList');
    const errEl = document.getElementById('auErr');
    const errMsg = document.getElementById('auErrMsg');
    const emptyEl = document.getElementById('auEmpty');

    if (!items.length) {
      emptyEl.innerHTML = UI.stateHTML('empty', { msg: '这个内容没有音频地址', noBtn: true });
    }

    function showErr(msg) {
      errMsg.textContent = String(msg || '源不可用');
      errEl.classList.add('on');
    }
    function hideErr() { errEl.classList.remove('on') }
    function toast(m) { UI.toast(m) }
    function rateText(r) { return (Math.round(r * 100) / 100) + '×' }

    function setItem(i, autoplay) {
      if (!items.length) return;
      if (i < 0) i = items.length - 1;
      if (i >= items.length) i = 0;
      cur = i;
      hideErr();
      const it = items[i];
      audio.src = it.url;
      audio.load();
      titleEl.textContent = it.title || title;
      artistEl.textContent = artist || (it.title ? title : (items.length > 1 ? items.length + ' 首' : ''));
      seek.value = '0';
      tCur.textContent = '0:00';
      tDur.textContent = '0:00';
      playBtn.textContent = '▶';
      if (autoplay) playIt();
    }
    function playIt() {
      const p = audio.play();
      if (p && p.catch) p.catch(function (e) {
        /* 自动播放被拦：不弹错误条，提示点按即可（浏览器策略） */
        if (e && (e.name === 'NotAllowedError' || /denied|not allowed/i.test(e.message || ''))) return UI.toast('点按播放');
        showErr('播放失败：' + firstLine(e.message));
      });
    }
    function togglePlay() {
      if (audio.paused) playIt();
      else audio.pause();
    }
    function rateSet(r) {
      audio.playbackRate = r;
      rateBtn.textContent = '倍速 ' + rateText(r);
    }
    function cycleRate() {
      const curRate = audio.playbackRate || 1;
      let i = RATES.indexOf(curRate);
      if (i < 0) i = 0;
      rateSet(RATES[(i + 1) % RATES.length]);
      toast('倍速 ' + rateText(audio.playbackRate));
    }
    function setSleep(min) {
      clearTimeout(sleepTimer);
      sleepTimer = 0;
      sleepMin = min;
      if (!min) { timerBtn.textContent = '定时 关'; return }
      timerBtn.textContent = '定时 ' + min + '分';
      toast('定时 ' + min + ' 分钟');
      sleepTimer = setTimeout(function () {
        try { audio.pause() } catch (e) { }
        timerBtn.textContent = '定时 关';
        sleepMin = 0;
        toast('定时关闭已生效');
      }, min * 60 * 1000);
    }

    function openTimer() {
      UI.sheet(`<div class="sh-h">定时关闭</div>
        <div class="rows">
          ${UI.row({ title: '关闭', right: sleepMin ? '' : '当前', arrow: true, act: 't0' })}
          ${UI.row({ title: '15 分钟', arrow: true, act: 't15' })}
          ${UI.row({ title: '30 分钟', arrow: true, act: 't30' })}
          ${UI.row({ title: '60 分钟', arrow: true, act: 't60' })}
        </div>
        <div class="sh-note">到点自动暂停；退出页面会清除定时。</div>`, {
        onOpen: function (pb) {
          $$('[data-act]', pb).forEach(function (r) {
            r.onclick = function () {
              UI.closeSheet();
              setSleep(parseInt(String(r.dataset.act).slice(1), 10) || 0);
            };
          });
        }
      });
    }
    function openList() {
      if (!items.length) return toast('没有播放列表');
      UI.sheet(`<div class="sh-h">播放列表 <span class="sh-d">共 ${items.length} 首</span></div>
        <div class="rows">${items.map(function (it, i) {
          return `<div class="row tap" data-i="${i}"><div class="t"><div class="nm">${esc(it.title || ('第' + (i + 1) + ' 首'))}</div>
            ${it.url ? `<div class="ds">${esc(String(it.url).slice(0, 48))}</div>` : ''}</div>
            <div class="v">${i === cur ? '播放中' : '›'}</div></div>`;
        }).join('')}</div>`, {
        onOpen: function (pb) {
          $$('[data-i]', pb).forEach(function (r) {
            r.onclick = function () {
              UI.closeSheet();
              setItem(parseInt(r.dataset.i, 10) || 0, true);
            };
          });
        }
      });
    }
    function openMore() {
      UI.sheet(`<div class="sh-h">更多</div>
        <div class="rows">
          ${UI.row({ title: '倍速', right: rateText(audio.playbackRate || 1), arrow: true, act: 'rate' })}
          ${UI.row({ title: '定时关闭', right: sleepMin ? sleepMin + ' 分钟' : '关', arrow: true, act: 'timer' })}
          ${UI.row({ title: '播放列表', right: items.length + ' 首', arrow: true, act: 'list' })}
          ${UI.row({ title: '后台播放', desc: '后台/锁屏播放需要系统媒体会话（后续接入）', right: '暂不支持' })}
        </div>
        <div class="sh-note">当前版本在页面内播放；切走或锁屏会暂停。</div>`, {
        onOpen: function (pb) {
          const r1 = $('[data-act="rate"]', pb), r2 = $('[data-act="timer"]', pb), r3 = $('[data-act="list"]', pb);
          if (r1) r1.onclick = function () { UI.closeSheet(); cycleRate() };
          if (r2) r2.onclick = function () { UI.closeSheet(); openTimer() };
          if (r3) r3.onclick = function () { UI.closeSheet(); openList() };
        }
      });
    }

    $('[data-back]', wrap).onclick = function () { App.back() };
    $('[data-more]', wrap).onclick = openMore;
    playBtn.onclick = togglePlay;
    document.getElementById('auPrev').onclick = function () { setItem(cur - 1, true) };
    document.getElementById('auNext').onclick = function () { setItem(cur + 1, true) };
    rateBtn.onclick = cycleRate;
    timerBtn.onclick = openTimer;
    listBtn.onclick = openList;
    $('[data-retry]', errEl).onclick = function () { hideErr(); setItem(cur, true) };
    const coverImg = $('.au-cover img', wrap);
    if (coverImg) coverImg.addEventListener('error', function () { coverImg.classList.add('hide') });

    seek.addEventListener('input', function () {
      seekHold = true;
      const dur = audio.duration || 0;
      tCur.textContent = fmtTime((parseInt(seek.value, 10) || 0) / 1000 * dur);
    });
    seek.addEventListener('change', function () {
      const dur = audio.duration || 0;
      if (dur > 0) { try { audio.currentTime = (parseInt(seek.value, 10) || 0) / 1000 * dur } catch (e) { } }
      seekHold = false;
    });

    audio.addEventListener('loadedmetadata', function () {
      tDur.textContent = fmtTime(audio.duration || 0);
    });
    audio.addEventListener('durationchange', function () {
      tDur.textContent = fmtTime(audio.duration || 0);
    });
    audio.addEventListener('timeupdate', function () {
      const dur = audio.duration || 0;
      if (!seekHold && dur > 0) seek.value = String(Math.round((audio.currentTime || 0) / dur * 1000));
      tCur.textContent = fmtTime(audio.currentTime || 0);
    });
    audio.addEventListener('play', function () { playBtn.textContent = '⏸'; hideErr() });
    audio.addEventListener('pause', function () { playBtn.textContent = '▶' });
    audio.addEventListener('ended', function () {
      if (items.length > 1) setItem(cur + 1, true);
      else playBtn.textContent = '▶';
    });
    audio.addEventListener('error', function () {
      if (cleaned) return;
      showErr('音频源不可用或格式不支持');
    });

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(sleepTimer);
      try { audio.pause() } catch (e) { }
      try { audio.removeAttribute('src'); audio.load() } catch (e) { }
      if (window.__rouAudioCleanup === cleanup) window.__rouAudioCleanup = null;
    }
    if (st) st.cleanup = cleanup;
    window.__rouAudioCleanup = cleanup;

    playBtn.textContent = '▶';
    if (items.length) setItem(clamp(parseInt(params.index, 10) || 0, 0, items.length - 1), false);
    rateSet(RATES.indexOf(DB.cfg().play.rate) >= 0 ? DB.cfg().play.rate : 1);
  };

  /* ============================================================
     P-23 阅读器
     参数：{book:{title,author,chapters:[{title,url}],content}, site} 或 {detail:{...}}
     TODO(docs/09 §4)：要求自绘分页（按屏幕尺寸+字号算每页字数，左右翻页）；
     本版先用「按屏高滚动 + 上一章/下一章」最简版，分页与当前句高亮后续补。
     ============================================================ */
  App.pages['book'] = function (root, params, st) {
    params = params || {};
    if (typeof window.__rouBookCleanup === 'function') {
      try { window.__rouBookCleanup() } catch (e) { }
    }
    const site = params.site || App.siteId || '';
    const b = params.book || params.detail || {};
    const chapters = normChapters(params.chapters || b.chapters || []);
    const title = b.title || params.title || '未命名';
    const author = b.author || '';
    const bookId = b.id || params.bookId || params.url || hashStr(title + '|' + author);

    /* 阅读设置走 DB.cfg().reader（持久化），默认 18px / 1.8 / 夜间 */
    let rc = Object.assign({ fontSize: 18, lineHeight: 1.8, bg: 'night' }, DB.cfg().reader || {});
    rc.fontSize = clamp(parseInt(rc.fontSize, 10) || 18, 14, 26);
    rc.lineHeight = clamp(parseFloat(rc.lineHeight) || 1.8, 1.4, 2.0);
    if (['night', 'white', 'beige', 'green'].indexOf(rc.bg) < 0) rc.bg = 'night';

    const initContent = b.content || params.content || '';
    const contentIdx = clamp(parseInt(b.chapterIndex != null ? b.chapterIndex : params.chapterIndex, 10) || 0, 0, Math.max(0, chapters.length - 1));
    const lastProg = DB.lastProgress(site, bookId);
    let startIdx = params.chapterIndex != null ? contentIdx : (lastProg && chapters[lastProg.ep] ? lastProg.ep : contentIdx);
    if (!chapters.length) startIdx = 0;

    let cur = -1;
    const initText = initContent ? htmlToText(initContent) : '';
    let text = initText;
    let seq = 0;
    let saveT = 0;
    let cleaned = false;
    let ttsOn = false;
    let ttsToken = 0;

    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'rd-wrap rd-bg-' + rc.bg;
    wrap.innerHTML = `
      <div class="rd-top">
        <div class="rd-ico" data-back>‹</div>
        <div class="rd-head"><div class="rd-title">${esc(title)}</div><div class="rd-sub" id="rdSub">${esc(author || '')}</div></div>
        <button class="rd-txt" data-toc>目录</button>
        <button class="rd-txt" data-set>AA</button>
        <button class="rd-txt" id="rdTTS" data-tts>朗读</button>
      </div>
      <div class="rd-body" id="rdBody">
        <div class="rd-text" id="rdText"></div>
        <div class="rd-state" id="rdState"></div>
      </div>
      <div class="rd-foot">
        <button class="btn ghost" id="rdPrev">‹ 上一章</button>
        <button class="btn ghost" id="rdToc2">目录</button>
        <button class="btn ghost" id="rdNext">下一章 ›</button>
      </div>
    `;
    root.appendChild(wrap);

    const rdBody = document.getElementById('rdBody');
    const rdText = document.getElementById('rdText');
    const rdState = document.getElementById('rdState');
    const rdSub = document.getElementById('rdSub');
    const rdPrev = document.getElementById('rdPrev');
    const rdNext = document.getElementById('rdNext');
    const ttsBtn = document.getElementById('rdTTS');

    function applyStyle() {
      rdText.style.fontSize = rc.fontSize + 'px';
      rdText.style.lineHeight = String(rc.lineHeight);
      wrap.className = 'rd-wrap rd-bg-' + rc.bg;
    }
    function saveCfg() {
      DB.setCfg({ reader: { fontSize: rc.fontSize, lineHeight: rc.lineHeight, bg: rc.bg } });
    }
    function chapterTitle(i) {
      return chapters[i] && chapters[i].title ? chapters[i].title : '';
    }
    function updateNav() {
      rdSub.textContent = author ? author : '';
      if (chapters.length && cur >= 0) {
        const t = chapterTitle(cur);
        rdSub.textContent = (author ? author + ' · ' : '') + (t || ('第' + (cur + 1) + '章'));
      }
      rdPrev.disabled = !chapters.length || cur <= 0;
      rdNext.disabled = !chapters.length || cur >= chapters.length - 1;
    }
    function savePos() {
      if (cur < 0) return;
      DB.setProgress(site, bookId, cur, Math.round(rdBody.scrollTop), Math.max(1, Math.round(rdBody.scrollHeight)));
    }

    /* 章节正文：优先脚本 parse_chapter，其次 <article>/.content/<p> 拼接 */
    async function fetchChapter(url, idx) {
      const r = await Net.request('GET', url, { site: site, headers: Net.headersFor(site) });
      const html = r.txt || '';
      let mod = null;
      try { mod = Engine.get(site) } catch (e) { mod = null }
      if (mod && typeof mod.parse_chapter === 'function') {
        try {
          const d2 = await mod.parse_chapter(url, html);
          let t = typeof d2 === 'string' ? d2 : (d2 && (d2.content || d2.text || d2.html || d2.body)) || '';
          if (t && t !== html) return htmlToText(t);
        } catch (e) { Log.err('parse_chapter 失败: ' + firstLine(e.message)) }
      }
      /* 通用正文解析：article / .content / #content / .chapter-content / 全部 <p> */
      let seg = '';
      const pick = [/<article[^>]*>([\s\S]*?)<\/article>/i, /<div[^>]+class="[^"]*(?:content|chapter|article|read)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]+id="(?:content|chapter|article|booktext)"[^>]*>([\s\S]*?)<\/div>/i];
      for (let i = 0; i < pick.length; i++) {
        const m = html.match(pick[i]);
        if (m && m[1] && htmlToText(m[1]).length > 40) { seg = m[1]; break }
      }
      if (!seg) {
        const ps = html.match(/<p[^>]*>[\s\S]*?<\/p>/gi);
        if (ps && ps.length) seg = ps.join('\n');
      }
      if (!seg) seg = html;
      const t = htmlToText(seg);
      if (!t) throw new Error('这一章没有解析到正文');
      return t;
    }

    function showState(txt) {
      rdState.innerHTML = '<i class="spin"></i><span>' + esc(txt) + '</span>';
      rdState.classList.add('on');
    }
    function hideState() { rdState.classList.remove('on'); rdState.innerHTML = '' }

    async function openChapter(i, restore, silent) {
      if (!chapters.length) {
        if (text) { cur = 0; rdText.textContent = text; updateNav(); return }
        rdText.textContent = '';
        showState('这本书还没有章节');
        return;
      }
      if (i < 0 || i >= chapters.length) { UI.toast(i < 0 ? '已经是第一章' : '已经是最后一章'); return }
      if (i === cur && !silent) return;
      const my = ++seq;
      stopTTS();
      savePos();
      cur = i;
      updateNav();
      rdText.textContent = '';
      rdBody.scrollTop = 0;
      let t = '';
      if (i === contentIdx && initText) t = initText;
      if (!t) {
        if (!chapters[i].url) { showState('这一章没有地址'); return }
        showState('加载正文…');
        try {
          t = await fetchChapter(chapters[i].url, i);
        } catch (e) {
          if (my !== seq) return;
          hideState();
          rdText.textContent = '';
          showState('章节加载失败：' + firstLine(e.message));
          return;
        }
        if (my !== seq) return;
      }
      hideState();
      text = t;
      rdText.textContent = t;
      if (restore && restore.pos > 0) rdBody.scrollTop = restore.pos;
      else rdBody.scrollTop = 0;
      savePos();
    }

    /* 目录抽屉 */
    function openToc() {
      if (!chapters.length) return UI.toast('没有目录');
      UI.sheet(`<div class="sh-h">目录 <span class="sh-d">共 ${chapters.length} 章</span></div>
        <div class="rows">${chapters.map(function (c, i) {
          return `<div class="row tap ${i === cur ? 'on' : ''}" data-ch="${i}"><div class="t"><div class="nm">${esc(c.title)}</div></div><div class="v">${i === cur ? '当前' : ''}</div></div>`;
        }).join('')}</div>`, {
        onOpen: function (pb) {
          $$('[data-ch]', pb).forEach(function (r) {
            r.onclick = function () {
              UI.closeSheet();
              openChapter(parseInt(r.dataset.ch, 10) || 0, null);
            };
          });
        }
      });
    }

    /* 阅读设置：字号 14–26 / 行距 1.4–2.0 / 4 套背景 */
    function openSettings() {
      UI.sheet(`<div class="sh-h">阅读设置</div>
        <div class="rd-set">
          <div class="rd-set-row"><span>字号</span><b id="rdFs">${rc.fontSize}px</b></div>
          <input class="slider" id="rdFsRange" type="range" min="14" max="26" step="1" value="${rc.fontSize}">
          <div class="rd-set-row"><span>行距</span><b id="rdLh">${rc.lineHeight.toFixed(1)}</b></div>
          <input class="slider" id="rdLhRange" type="range" min="1.4" max="2" step="0.1" value="${rc.lineHeight}">
          <div class="rd-set-row"><span>背景</span><b id="rdBg">${bgLabel(rc.bg)}</b></div>
          <div class="rd-bgs">
            ${['night', 'white', 'beige', 'green'].map(function (k) {
              return `<b data-bg="${k}" class="rd-bg-${k} ${k === rc.bg ? 'on' : ''}">${bgLabel(k)}</b>`;
            }).join('')}
          </div>
        </div>`, {
        onOpen: function (pb) {
          const fs = $('#rdFsRange', pb), lh = $('#rdLhRange', pb);
          if (!fs || !lh) return;   /* 浮层内容已被下一次 UI.sheet 换掉（延迟 onOpen）时直接跳过 */
          fs.addEventListener('input', function () {
            rc.fontSize = parseInt(fs.value, 10) || 18;
            $('#rdFs', pb).textContent = rc.fontSize + 'px';
            applyStyle();
          });
          lh.addEventListener('input', function () {
            rc.lineHeight = clamp(parseFloat(lh.value) || 1.8, 1.4, 2.0);
            $('#rdLh', pb).textContent = rc.lineHeight.toFixed(1);
            applyStyle();
          });
          fs.addEventListener('change', saveCfg);
          lh.addEventListener('change', saveCfg);
          $$('[data-bg]', pb).forEach(function (b2) {
            b2.onclick = function () {
              rc.bg = b2.dataset.bg;
              $$('[data-bg]', pb).forEach(function (x) { x.classList.toggle('on', x === b2) });
              $('#rdBg', pb).textContent = bgLabel(rc.bg);
              applyStyle();
              saveCfg();
            };
          });
        }
      });
    }
    function bgLabel(k) {
      return { night: '夜间', white: '白色', beige: '米黄', green: '护眼绿' }[k] || '夜间';
    }

    /* TTS：WebView 里 speechSynthesis 常常不可用，先检测；不可用不假称支持 */
    function ttsAvailable() {
      return !!(window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function');
    }
    function splitTTS(t) {
      const out = [];
      const s = String(t || '').replace(/\s+/g, ' ').trim();
      if (!s) return out;
      let buf = '';
      for (let i = 0; i < s.length; i++) {
        buf += s.charAt(i);
        if (buf.length >= 160 && /[。！？!?；;，,\s]/.test(s.charAt(i))) { out.push(buf); buf = '' }
      }
      if (buf.trim()) out.push(buf);
      return out;
    }
    function stopTTS() {
      ttsToken++;
      ttsOn = false;
      if (ttsAvailable()) { try { window.speechSynthesis.cancel() } catch (e) { } }
      if (ttsBtn) ttsBtn.textContent = '朗读';
    }
    function toggleTTS() {
      if (!ttsAvailable()) return UI.toast('本机不支持内置朗读');
      if (ttsOn) { stopTTS(); return }
      const t = rdText.textContent || '';
      if (!t.trim()) return UI.toast('这一章没有正文');
      const chunks = splitTTS(t);
      if (!chunks.length) return UI.toast('这一章没有正文');
      ttsOn = true;
      const my = ++ttsToken;
      ttsBtn.textContent = '停止';
      const speakOne = function (i) {
        if (!ttsOn || my !== ttsToken) return;
        if (i >= chunks.length) { ttsOn = false; ttsBtn.textContent = '朗读'; return }
        const u = new window.SpeechSynthesisUtterance(chunks[i]);
        u.lang = 'zh-CN';
        u.rate = 1;
        u.onend = function () { speakOne(i + 1) };
        u.onerror = function () { stopTTS() };
        try { window.speechSynthesis.speak(u) } catch (e) { stopTTS() }
      };
      speakOne(0);
    }

    $('[data-back]', wrap).onclick = function () { App.back() };
    $('[data-toc]', wrap).onclick = openToc;
    document.getElementById('rdToc2').onclick = openToc;
    $('[data-set]', wrap).onclick = openSettings;
    ttsBtn.onclick = toggleTTS;
    rdPrev.onclick = function () { openChapter(cur - 1, null) };
    rdNext.onclick = function () { openChapter(cur + 1, null) };
    /* 正文加载失败时，点状态区重试当前章 */
    rdState.addEventListener('click', function () {
      if (rdState.textContent.indexOf('失败') < 0) return;
      if (cur >= 0) openChapter(cur, null, true);
    });

    rdBody.addEventListener('scroll', function () {
      clearTimeout(saveT);
      saveT = setTimeout(savePos, 800);
    }, { passive: true });

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      savePos();
      clearTimeout(saveT);
      stopTTS();
      if (window.__rouBookCleanup === cleanup) window.__rouBookCleanup = null;
    }
    if (st) st.cleanup = cleanup;
    window.__rouBookCleanup = cleanup;

    applyStyle();
    /* 有 content 且章节为空：直接显示；有章节：恢复上次章节 + 滚动位置 */
    if (!chapters.length) {
      if (text) { cur = 0; rdText.textContent = text; updateNav(); }
      else showState('这本书还没有正文');
    } else {
      updateNav();
      const restore = lastProg && chapters[startIdx] && lastProg.ep === startIdx ? lastProg : null;
      openChapter(startIdx, restore, false);
    }
  };
})();
