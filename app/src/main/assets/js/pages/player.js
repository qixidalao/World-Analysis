/* player.js — P-24 播放器（专属全屏页面，不是弹窗）
   规格：docs/07 P-24、docs/09 §5（链路/UI）/ §6（字幕占位）/ §7（片头尾）、docs/04 §3-§5（PNG roUd 封装）
   播放链路：
     Net.playSource(play)
       ├─ {kind:'m3u8'}  → 主列表取最高码率 → 重写每个分片/密钥 URI 为假地址
       │                    → hls.js（自定义 loader：pLoader/fLoader/loader 同一个类）
       │                    → 分片：假地址查表 → Net.bytes → Net.unwrap → TS → 回调给 hls.js
       ├─ {kind:'ts'|'bin'} → Blob 直接给 <video>
       └─ {kind:'json'}   → 取 videoUrl 再 playSource 一次
   失败：loader 内 2 次指数退避重试；最终失败显示错误条 + 「重新解包」。
   竖屏 = 内容页（顶栏 + 16:9 视频 + 标题/操作/选集/相关推荐）；横屏 = 全屏（body.pl-land）。
   横屏只由「全屏」按钮进入/退出：进入 Native.orient(1)+body.pl-land，退出 Native.orient(0)。
   返回键：横屏时 window.__playerBack() 先退出横屏并返回 true（boot.js 的 __back 优先调用）。
   清理：st.cleanup 里 hls.destroy() / 清 timer / 存进度 / 释放 blob / 复位横屏与钩子。 */
(function () {
  'use strict';

  const RATES = [1, 1.25, 1.5, 2, 0.75];
  const FAKE = 'https://rou.local';          // 假源站：只为满足 hls.js 的 URL 解析，绝不发真实请求
  const MANIFEST = FAKE + '/index.m3u8';
  const SAVE_MS = 5000;
  const MAX_RETRY = 2;                        // 失败重试 2 次（指数退避）
  const RATIO_LABEL = { fit: '适应', fill: '填充', crop: '裁切' };

  /* ---------------- 小工具 ---------------- */
  function firstLine(s) { return String(s == null ? '' : s).split('\n')[0].slice(0, 120) }
  function toAB(u8) { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) }
  function nowMs() { return (window.performance && window.performance.now) ? window.performance.now() : Date.now() }

  /* ==== 纯函数区：m3u8 重写（离线可测，改完可用 node 单独跑） ==== */
  /* 相对地址 → 绝对地址 */
  function absUrl(u, base) {
    let s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.indexOf('//') === 0) return 'https:' + s;
    const m = String(base || '').match(/^https?:\/\/[^\/]+/);
    const origin = m ? m[0] : '';
    if (s.charAt(0) === '/') return origin + s;
    const path = String(base || '').replace(/[?#].*$/, '');
    return path.replace(/[^\/]*$/, '') + s;
  }

  /* 把 m3u8 里所有分片 / EXT-X-KEY / EXT-X-MAP 的 URI 换成本地假地址，并返回 假地址→真实地址 映射 */
  function rewriteM3u8(text, base) {
    const map = {};
    let n = 0, segs = 0;
    const put = function (u, kind) {
      const real = absUrl(u, base);
      if (!real) return '';
      const fake = FAKE + '/' + kind + '/' + (n++);
      map[fake] = { url: real, kind: kind };
      if (kind === 'seg') segs++;
      return fake;
    };
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (!t) { out.push(line); continue; }
      if (t.charAt(0) === '#') {
        let l = line;
        if (t.indexOf('URI="') >= 0) {
          const kind = t.indexOf('#EXT-X-KEY') === 0 ? 'key' : (t.indexOf('#EXT-X-MAP') === 0 ? 'init' : 'seg');
          l = line.replace(/URI="([^"]+)"/g, function (m, u) { return 'URI="' + put(u, kind) + '"' });
        }
        out.push(l);
        continue;
      }
      /* #EXTINF 后面那一行、以及以 http 开头的行，都走这里（非注释行就是分片 URI） */
      out.push(put(t, 'seg'));
    }
    return { text: out.join('\n'), map: map, count: n, segs: segs };
  }

  /* 主播放列表：挑 BANDWIDTH 最高的一条子线路 */
  function bestVariant(text, base) {
    const lines = String(text || '').split(/\r?\n/);
    let best = '', bestBw = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
      const m = t.match(/BANDWIDTH=(\d+)/i);
      const bw = m ? parseInt(m[1], 10) : 0;
      for (let j = i + 1; j < lines.length; j++) {
        const u = lines[j].trim();
        if (!u) continue;
        if (u.charAt(0) === '#') continue;
        if (bw > bestBw) { bestBw = bw; best = absUrl(u, base) }
        break;
      }
    }
    return best;
  }
  /* ==== 纯函数区结束 ==== */

  /* JSON 播放源：标准 JSON 优先，失败再兜 JS 对象字面量（{videoUrl:"/api/hls/x"}） */
  function parseJsonLoose(text) {
    try { return JSON.parse(text) } catch (e) { }
    const m = String(text || '').match(/["']?(?:videoUrl|url|play|src)["']?\s*:\s*["']([^"']+)["']/);
    return m ? { videoUrl: m[1] } : null;
  }

  function sniffMime(u8) {
    if (!u8 || !u8.length) return 'video/mp4';
    if (u8[0] === 0x47) return 'video/mp2t';
    if (u8[0] === 0x1a && u8[1] === 0x45) return 'video/webm';
    try { if (String.fromCharCode.apply(null, u8.subarray(0, 16)).indexOf('ftyp') >= 0) return 'video/mp4' } catch (e) { }
    return 'video/mp4';
  }

  function newStats() {
    return {
      aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 }
    };
  }

  /* ---------------- hls.js 自定义 loader ----------------
     hls.js 1.7 里 createInternalLoader 用的是 `new (pLoader || loader)(config)`，
     分片走 `new (fLoader || loader)`；所以三把都指向同一个类即可全覆盖：
       · 播放列表（manifest/level/audioTrack/subtitleTrack）→ 返回内存里重写好的 m3u8 文本
       · 分片/密钥/初始化段 → 假地址查表 → Net.bytes → PNG 解开 → TS/原始字节
     loader 自己不做重试策略配置，只在网络/解包失败时指数退避重试 2 次。 */
  function makeLoader(ctl) {
    var SegCache = (function () {
    var NAME = 'rou_hls_v1', STORE = 'seg', dbp = null;
    function limit() {
      var mb = Number((DB.cfg().play || {}).cache);
      if (!isFinite(mb) || mb <= 0) return 0;
      return mb * 1024 * 1024;
    }
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var rq = indexedDB.open(NAME, 1);
        rq.onupgradeneeded = function () {
          var db = rq.result;
          if (!db.objectStoreNames.contains(STORE)) {
            var st = db.createObjectStore(STORE, { keyPath: 'k' });
            st.createIndex('at', 'at');
          }
        };
        rq.onsuccess = function () { resolve(rq.result) };
        rq.onerror = function () { reject(rq.error) };
      });
      return dbp;
    }
    function get(key) {
      return open().then(function (db) {
        return new Promise(function (resolve) {
          var rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
          rq.onsuccess = function () { resolve(rq.result ? rq.result.data : null) };
          rq.onerror = function () { resolve(null) };
        });
      }).catch(function () { return null });
    }
    function trim() {
      var max = limit();
      if (!max) return;
      open().then(function (db) {
        var tx = db.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
        var rows = [];
        st.openCursor().onsuccess = function (e) {
          var cur = e.target.result;
          if (cur) { rows.push({ k: cur.value.k, at: cur.value.at || 0, size: cur.value.size || 0 }); cur.continue(); return; }
          var total = rows.reduce(function (a, x) { return a + x.size }, 0);
          rows.sort(function (a, b) { return a.at - b.at });
          for (var i = 0; i < rows.length && total > max; i++) {
            total -= rows[i].size; st.delete(rows[i].k);
          }
        };
      }).catch(function () { });
    }
    function put(key, ab) {
      var max = limit();
      if (!max || !ab || !ab.byteLength) return;
      open().then(function (db) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ k: key, at: Date.now(), size: ab.byteLength, data: ab });
        tx.oncomplete = trim;
      }).catch(function () { });
    }
    return { get: get, put: put };
  })();

  function RouLoader(config) {
      this.config = config || {};
      this.stats = newStats();
      this.context = null;
      this.callbacks = null;
      this.aborted = false;
      this.timer = 0;
    }
    const P = RouLoader.prototype;

    P.load = function (context, config, callbacks) {
      const self = this;
      this.context = context;
      this.callbacks = callbacks;
      this.aborted = false;
      this.stats.loading.start = nowMs();

      const ok = function (data) {
        if (self.aborted) return;
        const st = self.stats;
        const t = nowMs();
        st.loading.first = st.loading.first || t;
        st.loading.end = t;
        st.loaded = (typeof data === 'string') ? data.length : ((data && data.byteLength) || 0);
        st.total = st.loaded;
        st.chunkCount = 1;
        const cost = Math.max(1, st.loading.end - st.loading.start);
        st.bwEstimate = st.loaded * 8 / cost * 1000;
        callbacks.onSuccess({ url: context.url, data: data }, st, context, null);
      };
      const fail = function (e) {
        if (self.aborted) return;
        callbacks.onError({ code: (e && e.status) || 0, text: (e && e.message) || String(e) }, context, null, self.stats);
      };
      const run = function (attempt) {
        if (self.aborted) return;
        self.stats.retry = attempt;
        const again = function (e) {
          if (self.aborted) return;
          if (attempt >= MAX_RETRY) return fail(e);
          self.timer = setTimeout(function () { run(attempt + 1) }, 600 * Math.pow(2, attempt));
        };
        const type = context.type;
        const isList = type === 'manifest' || type === 'level' || type === 'audioTrack' || type === 'subtitleTrack';
        if (isList) ctl.playlistText(context.url).then(ok, again);
        else ctl.bytesFor(context.url).then(ok, again);
      };
      run(0);
    };

    P.abort = function () {
      const was = !this.aborted;
      this.aborted = true;
      if (this.timer) { clearTimeout(this.timer); this.timer = 0 }
      if (was && this.callbacks && this.callbacks.onAbort) {
        try { this.callbacks.onAbort(this.stats, this.context, null) } catch (e) { }
      }
    };
    P.destroy = function () {
      if (this.timer) clearTimeout(this.timer);
      this.timer = 0;
      this.aborted = true;
      this.callbacks = null;
      this.context = null;
    };
    P.getCacheAge = function () { return null };
    P.getResponseHeader = function () { return null };
    return RouLoader;
  }

  /* Net.playSource + 2 次指数退避 */
  function playSource(url, site) {
    return new Promise(function (resolve, reject) {
      let n = 0;
      const run = function () {
        Net.playSource(url, { site: site }).then(resolve, function (e) {
          n++;
          if (n > MAX_RETRY) return reject(e);
          setTimeout(run, 600 * Math.pow(2, n - 1));
        });
      };
      run();
    });
  }

  /* 主播放列表循环下钻（嵌套主列表很少见，最多 2 层） */
  async function flattenPlaylist(text, base, site) {
    let t = text, b = base, n = 0;
    while (t.indexOf('#EXT-X-STREAM-INF') >= 0 && n < 2) {
      const v = bestVariant(t, b);
      if (!v) break;
      const r = await playSource(v, site);
      if (!r || r.kind !== 'm3u8') throw new Error('子线路不是播放列表');
      t = r.text; b = v; n++;
    }
    return { text: t, base: b };
  }

  /* 一个播放会话的 URL 路由器：播放列表文本 + 假地址→真实地址映射 */
  function makeCtl(site, firstText, firstMap) {
    const playlists = {};
    const map = {};
    playlists[MANIFEST] = firstText;
    /* 首屏 m3u8 重写出来的 假地址→真实地址 表必须灌进来，否则分片全部查不到 */
    if (firstMap) Object.keys(firstMap).forEach(function (k) { map[k] = firstMap[k] });

    function playlistText(url) {
      if (playlists[url] != null) return Promise.resolve(playlists[url]);
      return playSource(url, site).then(function (r) {
        if (!r || r.kind !== 'm3u8') throw new Error('线路返回的不是播放列表');
        return flattenPlaylist(r.text, url, site).then(function (f) {
          const rw = rewriteM3u8(f.text, f.base);
          Object.keys(rw.map).forEach(function (k) { map[k] = rw.map[k] });
          playlists[url] = rw.text;
          return rw.text;
        });
      });
    }

    function lookup(url) {
      const hit = map[url];
      if (hit) return hit;
      /* 兜底：hls.js 会用 buildAbsoluteURL 归一化，万一 key 形式变了，按 /seg|init|key/<idx> 再取一次 */
      const m = String(url || '').match(/\/(seg|init|key)\/(\d+)(?:[?#]|$)/);
      if (m) {
        const k = FAKE + '/' + m[1] + '/' + m[2];
        if (map[k]) return map[k];
      }
      return null;
    }

    function bytesFor(url) {
      const ent = lookup(url);
      let real = ent ? ent.url : '';
      if (!real) {
        if (url.indexOf(FAKE + '/') === 0) {
          Log.err('未知分片（映射表未命中）: ' + url);
          return Promise.reject(new Error('未知分片：' + String(url).slice(String(url).lastIndexOf('/') + 1)));
        }
        real = url;
      }
      return SegCache.get(real).then(function (cached) {
        if (cached) return cached;
        return Net.bytes(real, { site: site }).then(function (u8) {
          if (u8 && u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50) {
            return Net.unwrap(u8).then(function (w) {
              if (!w) throw new Error('分片解包失败');
              if (w.kind === 'ts') return toAB(w.bytes);
              throw new Error('分片返回了播放列表');
            });
          }
          return toAB(u8);
        }).then(function (ab) { SegCache.put(real, ab); return ab; });
      });
    }

    return { playlistText: playlistText, bytesFor: bytesFor };
  }

  /* ---------------- 页面 ---------------- */
  App.pages['player'] = function (root, params, st) {
    params = params || {};
    const site = params.site || App.siteId || '';

    /* 上一次实例若没被路由清理（如 refresh 重渲染），先停掉，避免串音 */
    if (typeof window.__rouPlayerCleanup === 'function') {
      try { window.__rouPlayerCleanup() } catch (e) { }
    }

    const state = {
      title: params.title || '',
      pic: params.pic || '',
      episodes: params.episodes || [],
      lines: params.lines || [],
      series: params.series || '',
      play: params.play || '',
      url: params.url || '',
      id: params.id || '',
      ep: Math.max(0, parseInt(params.ep, 10) || 0),
      curLine: 0,
      intro: null,
      /* 相关推荐只认 params.related（[{title,pic,desc,url}]）；params.tags 是标签，不能当视频推荐 */
      related: Array.isArray(params.related) ? params.related.filter(function (x) { return x && x.url }) : []
    };
    let hls = null;
    let blobUrl = '';
    let started = 0;
    let pendingSeek = 0;
    let brightness = 1;
    let cleaned = false;
    let saveTimer = 0;
    let ctlTimer = 0;
    let resumeTimer = 0;
    let nextTimer = 0;
    let nextShown = false;
    let osdTimer = 0;
    let longTimer = 0;
    let tapTimer = 0;
    let lastTap = 0;
    let gs = null;
    let dragging = false;
    let pendingSeekUI = false;
    let recoveries = 0;

    const stTop = st || (App.stacks[App.tab] && App.stacks[App.tab][App.stacks[App.tab].length - 1]);

    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'pl-wrap';
    wrap.innerHTML = `
      <div class="pl-top">
        <div class="pl-ico" data-back>‹</div>
        <div class="pl-title" id="ptitle">播放</div>
        <div class="pl-ico" data-more>⋮</div>
      </div>
      <div class="pl-main" id="plmain">
        <div class="pl-stage" id="plstage">
          <video class="pl-video" id="pv" playsinline webkit-playsinline preload="metadata"></video>
          <div class="pl-gest" id="pgest"></div>
          <div class="pl-osd" id="posd"></div>
          <button class="pl-bigplay" id="pbigplay" aria-label="播放">▶</button>
          <div class="pl-loading on" id="ploading"><i class="spin"></i><span id="ploadtxt">解析播放源…</span></div>
          <div class="pl-err" id="perr"><b>播放失败</b><span id="perrmsg"></span><button class="btn pri" data-rebuild>重新解包</button></div>
          <button class="pl-full-fl" id="pbfullfl" aria-label="全屏">⛶</button>
          <div class="pl-bottom">
            <div class="pl-timebar">
              <span id="ptcur">0:00</span>
              <div class="pl-track" id="ptrack">
                <div class="pl-buf" id="pbuf"></div>
                <div class="pl-fill" id="pfill"></div>
                <div class="pl-mk intro" id="pmkin"></div>
                <div class="pl-mk outro" id="pmkout"></div>
                <div class="pl-knob" id="pknob"></div>
              </div>
              <span id="ptdur">0:00</span>
            </div>
            <div class="pl-btns">
              <button class="pl-btn" id="pbfull">⛶ 全屏</button>
              <button class="pl-btn" id="pbrate">倍速 1×</button>
              <button class="pl-btn" id="pbsub">字幕</button>
              <button class="pl-btn" id="pbline">选源</button>
              <button class="pl-btn" id="pbin">设片头</button>
              <button class="pl-btn" id="pbout">设片尾</button>
            </div>
          </div>
          <div class="pl-resume" id="presume"><span id="presumetxt"></span><button class="btn pri" data-resume>继续播放</button><button class="btn ghost" data-restart>从头</button></div>
          <div class="pl-next" id="pnext"><span>片尾 · 下一集 <b id="pnextn">8</b></span><button class="btn pri" data-nextgo>播放</button><button class="btn ghost" data-nextcancel>取消</button></div>
        </div>
        <div class="pl-info" id="pinfo">
          <div class="pl-info-t" id="pinfotitle">播放</div>
          <div class="pl-info-m" id="pinfometa"></div>
        </div>
        <div class="pl-acts">
          <button class="pl-act" id="pbfav">♡ 收藏</button>
          <button class="pl-act" id="pbshare">⤴ 分享</button>
          <button class="pl-act" id="pbeps">选集</button>
          <button class="pl-act" id="pbrate2">倍速 1×</button>
          <button class="pl-act" id="pbmore">⋯ 更多</button>
        </div>
        <div class="pl-sec" id="pepsec">
          <div class="sec-h"><h3>选集</h3><s id="pepcount"></s></div>
          <div class="pl-epsx" id="pepstrip"></div>
        </div>
        <div class="pl-sec" id="prelsec">
          <div class="sec-h"><h3>相关推荐</h3></div>
          <div class="grid" id="prelgrid"></div>
        </div>
        <div class="pl-safe"></div>
      </div>
    `;
    root.appendChild(wrap);

    const video = document.getElementById('pv');
    const gest = document.getElementById('pgest');
    const osdEl = document.getElementById('posd');
    const bigPlay = document.getElementById('pbigplay');
    const loadingEl = document.getElementById('ploading');
    const loadTxt = document.getElementById('ploadtxt');
    const errEl = document.getElementById('perr');
    const errMsg = document.getElementById('perrmsg');
    const titleEl = document.getElementById('ptitle');
    const trackEl = document.getElementById('ptrack');
    const bufEl = document.getElementById('pbuf');
    const fillEl = document.getElementById('pfill');
    const knobEl = document.getElementById('pknob');
    const mkIn = document.getElementById('pmkin');
    const mkOut = document.getElementById('pmkout');
    const tCur = document.getElementById('ptcur');
    const tDur = document.getElementById('ptdur');
    const rateBtn = document.getElementById('pbrate');
    const resumeEl = document.getElementById('presume');
    const resumeTxt = document.getElementById('presumetxt');
    const nextEl = document.getElementById('pnext');
    const nextN = document.getElementById('pnextn');
    /* 竖屏内容页 / 横屏控制层用到的节点 */
    const fullBtn = document.getElementById('pbfull');
    const fullFlBtn = document.getElementById('pbfullfl');
    const infoTitle = document.getElementById('pinfotitle');
    const infoMeta = document.getElementById('pinfometa');
    const actFav = document.getElementById('pbfav');
    const actShare = document.getElementById('pbshare');
    const actEps = document.getElementById('pbeps');
    const actRate = document.getElementById('pbrate2');
    const actMore = document.getElementById('pbmore');
    const epSec = document.getElementById('pepsec');
    const epStrip = document.getElementById('pepstrip');
    const epCount = document.getElementById('pepcount');
    const relSec = document.getElementById('prelsec');
    const relGrid = document.getElementById('prelgrid');

    /* 初始画面比例 */
    const initRatio = DB.cfg().play.ratio || 'fit';
    video.style.objectFit = initRatio === 'fill' ? 'fill' : (initRatio === 'crop' ? 'cover' : 'contain');

    /* ---------- 通用 UI ---------- */
    function toast(m) { UI.toast(m) }
    function setLoading(t) {
      loadTxt.textContent = t;
      loadingEl.classList.add('on');
    }
    function hideLoading() { loadingEl.classList.remove('on') }
    function showError(msg) {
      errMsg.textContent = String(msg || '未知错误');
      errEl.classList.add('on');
      hideLoading();
      Log.err('播放失败: ' + msg);
    }
    function hideError() { errEl.classList.remove('on') }
    function showCtl() {
      wrap.classList.add('ctl');
      clearTimeout(ctlTimer);
      /* 竖屏/横屏同一套：播放中 3s 后自动隐藏，点视频再显示 */
      if (!video.paused) ctlTimer = setTimeout(function () { wrap.classList.remove('ctl') }, 3000);
    }
    function hideCtl() { wrap.classList.remove('ctl'); clearTimeout(ctlTimer) }
    function osd(text) {
      osdEl.textContent = text;
      osdEl.classList.add('on');
      clearTimeout(osdTimer);
      osdTimer = setTimeout(function () { osdEl.classList.remove('on') }, 900);
    }
    function showBigPlay() { bigPlay.classList.add('on') }
    function hideBigPlay() { bigPlay.classList.remove('on') }

    /* ---------- 横屏全屏（只能由按钮进入/退出，不接管双击） ----------
       进入：Native.orient(1) + body.pl-land；退出：Native.orient(0) + 移除 class。
       没有 Java 桥（桌面浏览器）时静默降级，只切 class。 */
    let land = false;
    function nativeOrient(mode) {
      try {
        /* boot.js 提供了 App.orient（内部就是 Native.orient）；没有时直接调桥，再没有就静默降级 */
        if (typeof App.orient === 'function') { App.orient(mode); return }
        if (window.Native && typeof window.Native.orient === 'function') window.Native.orient(mode);
      } catch (e) { }
    }
    function applyOrient() {
      if (land) document.body.classList.add('pl-land');
      else document.body.classList.remove('pl-land');
      if (fullBtn) fullBtn.textContent = land ? '⛶ 退出全屏' : '⛶ 全屏';
      nativeOrient(land ? 1 : 0);
      showCtl();
      onResize();
    }
    function enterFull() { if (land) return; land = true; applyOrient() }
    function exitFull() { if (!land) return; land = false; applyOrient() }
    function toggleFull() { if (land) exitFull(); else enterFull() }

    function rateText(r) {
      return (Math.round(r * 100) / 100) + '×';
    }
    function setRate(r, quiet) {
      video.playbackRate = r;
      rateBtn.textContent = '倍速 ' + rateText(r);
      if (actRate) actRate.textContent = '倍速 ' + rateText(r);
      if (!quiet) toast('倍速 ' + rateText(r));
    }
    function cycleRate() {
      const cur = video.playbackRate || 1;
      let i = RATES.indexOf(cur);
      if (i < 0) i = 0;
      setRate(RATES[(i + 1) % RATES.length]);
    }

    function togglePlay() {
      if (video.paused) {
        const p = video.play();
        if (p && p.catch) p.catch(function () { showBigPlay() });
      } else {
        video.pause();
      }
    }
    function titleText() {
      const e = state.episodes[state.ep];
      let label = e && e.title ? e.title : '';
      if (!label && (state.episodes.length > 1 || state.ep > 0)) label = '第' + (state.ep + 1) + '集';
      /* 详情标题里可能已带「· 第N集」（og:title），避免重复拼接 */
      let base = String(state.title || '播放').replace(/\s*[·\-–—]\s*第\s*\d+\s*集\s*$/, '').trim();
      if (!base) base = '播放';
      if (label && base.indexOf(label) >= 0) return base;
      return label ? base + ' · ' + label : base;
    }

    /* ---------- 竖屏内容页：标题/元信息 · 操作行 · 选集 · 相关推荐 ---------- */
    function refreshFav() {
      if (!actFav) return;
      const on = !!(state.url && DB.isFav(state.url));
      actFav.textContent = on ? '♥ 已收藏' : '♡ 收藏';
      actFav.classList.toggle('on', on);
    }
    function renderInfo() {
      if (!infoTitle) return;
      infoTitle.textContent = state.title || '播放';
      const bits = [];
      if (state.episodes.length > 1) {
        const e = state.episodes[state.ep];
        bits.push(e && e.title ? e.title : ('第' + (state.ep + 1) + '集'));
        bits.push('共 ' + state.episodes.length + ' 集');
      } else if (state.url) {
        bits.push('单集');
      }
      if (state.lines.length > 1) bits.push('线路 ' + (state.curLine + 1) + '/' + state.lines.length);
      infoMeta.textContent = bits.join(' · ');
      refreshFav();
    }
    function renderEpStrip() {
      if (!epSec) return;
      const eps = state.episodes || [];
      if (eps.length <= 1) { epSec.style.display = 'none'; epStrip.innerHTML = ''; return }
      epSec.style.display = '';
      epCount.textContent = '共 ' + eps.length + ' 集';
      epStrip.innerHTML = eps.map(function (e, i) {
        return '<b data-epx="' + i + '" class="' + (i === state.ep ? 'on' : '') + '">' +
          esc(e.title || ('第' + (i + 1) + '集')) + '</b>';
      }).join('');
      $$('[data-epx]', epStrip).forEach(function (b) {
        b.onclick = function () { switchEp(parseInt(b.dataset.epx, 10) || 0) };
      });
    }
    function relatedHtml(list) {
      return list.map(function (it, i) {
        const pic = it.pic ? `<img loading="lazy" src="${esc(it.pic)}" alt="" onerror="this.style.display='none'">` : '';
        const ph = pic || `<div class="phg" style="position:absolute;inset:0"></div>`;
        return `<div class="card" data-rel="${i}"><div class="ph">${ph}${it.desc ? `<em>${esc(it.desc)}</em>` : ''}</div>` +
          `<div class="tt">${esc(it.title || '未命名')}</div></div>`;
      }).join('');
    }
    function renderRelated() {
      if (!relSec) return;
      const list = (state.related || []).filter(function (x) { return x && x.url }).slice(0, 30);
      if (!list.length) { relSec.style.display = 'none'; relGrid.innerHTML = ''; return }
      relSec.style.display = '';
      relGrid.innerHTML = relatedHtml(list);
      $$('[data-rel]', relGrid).forEach(function (el) {
        el.onclick = function () {
          const i = parseInt(el.dataset.rel, 10) || 0;
          openRelated(list[i]);
        };
      });
    }
    /* 点相关推荐：换栈顶重新进播放器，由播放器自己 Engine.run(params.url) 解析播放源 */
    function openRelated(it) {
      if (!it || !it.url) return;
      saveProgress();
      const np = {
        site: site, url: it.url, id: '', title: it.title || '', series: '', play: '',
        ep: 0, episodes: [], lines: [], related: [], startPos: 0, land: land
      };
      if (stTop && stTop.cleanup) stTop.cleanup(); else cleanup();
      App.replace('player', np);
    }
    function shareLink() {
      const u = state.url || '';
      if (!u) return toast('没有可分享的地址');
      const txt = (state.title ? state.title + ' ' : '') + u;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast('已复制链接') }, function () { toast('复制失败') });
      } else {
        toast('复制失败：请长按地址手动复制');
      }
    }
    function openEps() {
      const eps = state.episodes || [];
      if (!eps.length) {
        UI.sheet(`<div class="sh-h">选集</div>
          <div class="sh-empty">脚本没有提供选集，这个内容只有当前一集</div>`, {});
        return;
      }
      const linesHtml = state.lines.length > 1 ? `
        <div class="sh-h">线路 <span class="sh-d">共 ${state.lines.length} 条</span></div>
        <div class="rows">${state.lines.map(function (l, i) {
          return `<div class="row tap" data-line="${i}"><div class="t"><div class="nm">${esc(l.name || ('线路' + (i + 1)))}</div></div><div class="v">${i === state.curLine ? '当前' : '›'}</div></div>`;
        }).join('')}</div>` : '';
      UI.sheet(`<div class="sh-h">选集 <span class="sh-d">共 ${eps.length} 集</span></div>
        <div class="pl-eps">${eps.map(function (e, i) {
          return `<b data-ep="${i}" class="${i === state.ep ? 'on' : ''}">${esc(e.title || ('第' + (i + 1) + '集'))}</b>`;
        }).join('')}</div>${linesHtml}`, {
        onOpen: function (pb) {
          $$('[data-ep]', pb).forEach(function (b) {
            b.onclick = function () { UI.closeSheet(); switchEp(parseInt(b.dataset.ep, 10) || 0) };
          });
          $$('[data-line]', pb).forEach(function (b) {
            b.onclick = function () { switchLine(parseInt(b.dataset.line, 10) || 0) };
          });
        }
      });
    }

    /* ---------- 进度 / 缓冲 / 标记 ---------- */
    function updateTime() {
      const dur = isFinite(video.duration) ? video.duration : 0;
      const cur = video.currentTime || 0;
      tCur.textContent = fmtTime(cur);
      tDur.textContent = dur > 0 ? fmtTime(dur) : '0:00';
      if (!dragging && !pendingSeekUI) {
        const pct = dur > 0 ? (cur / dur * 100) : 0;
        fillEl.style.width = pct + '%';
        knobEl.style.left = pct + '%';
      }
      updateBuffer();
    }
    function updateBuffer() {
      const dur = video.duration || 0;
      if (!dur || !video.buffered || !video.buffered.length) return;
      const end = video.buffered.end(video.buffered.length - 1);
      bufEl.style.width = clamp(end / dur * 100, 0, 100) + '%';
    }
    function previewSeek(ratio) {
      const dur = video.duration || 0;
      if (!dur) return;
      pendingSeekUI = true;
      fillEl.style.width = (ratio * 100) + '%';
      knobEl.style.left = (ratio * 100) + '%';
      tCur.textContent = fmtTime(ratio * dur);
    }

    function updateMarkers() {
      const dur = video.duration || 0;
      const it = state.intro || {};
      if (dur > 0 && it.introEnd > 0 && it.introEnd < dur) {
        mkIn.style.display = 'block';
        mkIn.style.width = (it.introEnd / dur * 100) + '%';
      } else mkIn.style.display = 'none';
      if (dur > 0 && it.outroStart > 0 && it.outroStart < dur) {
        mkOut.style.display = 'block';
        mkOut.style.left = (it.outroStart / dur * 100) + '%';
      } else mkOut.style.display = 'none';
    }

    /* ---------- 进度记忆 ---------- */
    function seriesKey() { return state.series || state.id || state.url || 'unknown' }
    function saveProgress() {
      if (!video) return;
      const dur = isFinite(video.duration) ? video.duration : 0;
      const pos = video.currentTime || 0;
      if (dur < 1 || pos < 1) return;
      DB.setProgress(site, state.id || state.url, state.ep, Math.round(pos), Math.round(dur));
    }
    function showResume(pos) {
      resumeTxt.textContent = '上次看到 ' + fmtTime(pos) + '，继续播放？';
      resumeEl.dataset.pos = String(pos);
      resumeEl.classList.add('on');
      clearTimeout(resumeTimer);
      /* 规格：3 秒提示；同时 ⋮ 里也留了「上次进度」入口，不怕错过 */
      resumeTimer = setTimeout(function () { resumeEl.classList.remove('on') }, 3000);
    }
    function hideResume() { resumeEl.classList.remove('on'); clearTimeout(resumeTimer) }

    $('[data-resume]', resumeEl).onclick = function () {
      const pos = parseFloat(resumeEl.dataset.pos) || 0;
      try { video.currentTime = pos } catch (e) { }
      hideResume();
      showCtl();
    };
    $('[data-restart]', resumeEl).onclick = function () { hideResume(); try { video.currentTime = 0 } catch (e) { } };

    /* ---------- 片头 / 片尾 ---------- */
    function loadIntro() {
      let it = DB.intro(site, seriesKey(), state.ep) || null;
      /* docs/09 §7.2 系列继承：本集没标记时，套用同系列其他集（优先靠前的集）的片头尾 */
      if (!it && state.episodes.length > 1) {
        for (let i = 0; i < state.episodes.length && !it; i++) {
          if (i === state.ep) continue;
          const s = DB.intro(site, seriesKey(), i);
          if (s && (s.introEnd > 0 || s.outroStart > 0)) it = Object.assign({}, s, { source: 'inherited' });
        }
      }
      state.intro = it;
      updateMarkers();
    }
    function markIntro() {
      if (!(video.duration > 0)) return toast('视频还没就绪');
      const t = video.currentTime;
      const cur = state.intro || {};
      DB.setIntro(site, seriesKey(), state.ep, {
        introEnd: Math.round(t * 10) / 10,
        outroStart: cur.outroStart || 0,
        dur: Math.round(video.duration),
        auto: cur.auto !== false,
        source: 'manual'
      });
      loadIntro();
      toast('已记片头 ' + Math.round(t) + 's');
    }
    function markOutro() {
      if (!(video.duration > 0)) return toast('视频还没就绪');
      const t = video.currentTime;
      const cur = state.intro || {};
      DB.setIntro(site, seriesKey(), state.ep, {
        introEnd: cur.introEnd || 0,
        outroStart: Math.round(t * 10) / 10,
        dur: Math.round(video.duration),
        auto: cur.auto !== false,
        source: 'manual'
      });
      loadIntro();
      nextShown = false;
      toast('已记片尾 ' + Math.round(t) + 's');
    }
    function hideNext() {
      nextEl.classList.remove('on');
      clearInterval(nextTimer);
    }
    function showNext() {
      nextShown = true;
      let n = 8;
      nextN.textContent = String(n);
      nextEl.classList.add('on');
      clearInterval(nextTimer);
      nextTimer = setInterval(function () {
        n--;
        if (n <= 0) {
          hideNext();
          switchEp(state.ep + 1);
          return;
        }
        nextN.textContent = String(n);
      }, 1000);
    }
    function checkOutro() {
      const it = state.intro;
      if (!it || !(it.outroStart > 0)) return;
      if (video.currentTime < it.outroStart - 5) { nextShown = false; hideNext(); return; }
      if (nextShown) return;
      if (!state.episodes || state.episodes.length <= state.ep + 1) return;
      if (DB.cfg().play.jumpOutro === false) return;
      showNext();
    }

    /* ---------- 选源 / 切集 / 比例 ---------- */
    function switchLine(i) {
      if (!state.lines[i]) return;
      const pos = video.currentTime || 0;
      UI.closeSheet();
      saveProgress();
      state.curLine = i;
      state.play = state.lines[i].url || state.play;
      destroyHls();
      hideError();
      started = 0;
      bootstrap(pos > 3 ? pos : 0);
    }
    function switchEp(i) {
      if (i < 0 || i >= state.episodes.length) { UI.toast('没有下一集了'); return }
      if (i === state.ep) return;
      hideNext();
      saveProgress();
      const e = state.episodes[i] || {};
      const np = {
        site: site,
        id: state.id,
        ep: i,
        url: e.url || state.url,
        play: e.url ? '' : state.play,
        title: state.title,
        pic: state.pic,
        series: state.series,
        episodes: state.episodes,
        lines: state.lines,
        related: state.related,
        land: land,
        startPos: 0
      };
      if (stTop && stTop.cleanup) stTop.cleanup();
      else cleanup();
      App.replace('player', np);
    }
    function setRatio(r) {
      video.style.objectFit = r === 'fill' ? 'fill' : (r === 'crop' ? 'cover' : 'contain');
      DB.setCfg({ play: { ratio: r } });
    }

    /* ---------- 浮层 ---------- */
    function openMore() {
      const epHtml = state.episodes.length ? `
        <div class="sh-h">选集 <span class="sh-d">共 ${state.episodes.length} 集</span></div>
        <div class="pl-eps">${state.episodes.map(function (e, i) {
          return `<b data-ep="${i}" class="${i === state.ep ? 'on' : ''}">${esc(e.title || ('第' + (i + 1) + '集'))}</b>`;
        }).join('')}</div>` : '';
      const linesHtml = state.lines.length ? `
        <div class="sh-h">线路</div>
        <div class="rows">${state.lines.map(function (l, i) {
          return `<div class="row tap" data-line="${i}"><div class="t"><div class="nm">${esc(l.name || ('线路' + (i + 1)))}</div></div><div class="v">${i === state.curLine ? '当前' : '›'}</div></div>`;
        }).join('')}</div>` : '';
      const curRatio = DB.cfg().play.ratio || 'fit';
      const int = state.intro || {};
      const autoIn = int.auto !== false;
      const resumeOn = DB.cfg().play.resume !== false;
      const jumpOut = DB.cfg().play.jumpOutro !== false;
      const last = DB.progress(site, state.id, state.ep);
      const html = `
        ${epHtml}
        ${linesHtml}
        <div class="sh-h">画面比例</div>
        <div class="pl-seg">${['fit', 'fill', 'crop'].map(function (r) {
          return `<b data-ratio="${r}" class="${r === curRatio ? 'on' : ''}">${RATIO_LABEL[r]}</b>`;
        }).join('')}</div>
        <div class="rows">
          ${UI.switchRow({ title: '自动跳片头', desc: '起播时直接跳到片头结束点', on: autoIn, act: 'autoIntro' })}
          ${UI.switchRow({ title: '自动跳片尾', desc: '到片尾弹「下一集」倒计时', on: jumpOut, act: 'jumpOutro' })}
          ${UI.switchRow({ title: '记忆进度', desc: '下次播放提示继续', on: resumeOn, act: 'resume' })}
          ${last && last.pos > 10 ? UI.row({ title: '上次进度', desc: fmtTime(last.pos), right: '跳转', arrow: true, act: 'seekLast' }) : ''}
          ${UI.row({ title: '重新解包', desc: '分片加载失败时重新拉索引', right: '重试', arrow: true, act: 'rebuild' })}
        </div>`;
      UI.sheet(html, {
        onOpen: function (pb) {
          $$('[data-ep]', pb).forEach(function (b) {
            b.onclick = function () { UI.closeSheet(); switchEp(parseInt(b.dataset.ep, 10) || 0) };
          });
          $$('[data-line]', pb).forEach(function (b) {
            b.onclick = function () { switchLine(parseInt(b.dataset.line, 10) || 0) };
          });
          $$('[data-ratio]', pb).forEach(function (b) {
            b.onclick = function () {
              setRatio(b.dataset.ratio);
              $$('[data-ratio]', pb).forEach(function (x) { x.classList.toggle('on', x === b) });
            };
          });
          $$('[data-sw]', pb).forEach(function (sw) {
            sw.onclick = function (ev) {
              if (ev && ev.stopPropagation) ev.stopPropagation();
              toggleSwitch(sw.dataset.sw, pb);
            };
          });
          /* 点开关行整行也能切（开关自身已 stopPropagation，不会双触发） */
          $$('.row[data-act]', pb).forEach(function (row) {
            if (!row.querySelector('.switch')) return;
            row.onclick = function () { toggleSwitch(row.dataset.act, pb) };
          });
          const seekRow = $('[data-act="seekLast"]', pb);
          if (seekRow) seekRow.onclick = function () {
            UI.closeSheet();
            if (last) { try { video.currentTime = last.pos } catch (e) { } }
            showCtl();
          };
          const rb = $('[data-act="rebuild"]', pb);
          if (rb) rb.onclick = function () { UI.closeSheet(); rebuild() };
        }
      });
    }

    function toggleSwitch(key, pb) {
      if (key === 'autoIntro') {
        const cur = state.intro || {};
        const on = cur.auto === false;
        DB.setIntro(site, seriesKey(), state.ep, Object.assign({ introEnd: 0, outroStart: 0, dur: Math.round(video.duration || 0) }, cur, { auto: on }));
        loadIntro();
        const sw = $('[data-sw="autoIntro"]', pb);
        if (sw) sw.classList.toggle('on', on);
      } else if (key === 'jumpOutro') {
        const on = DB.cfg().play.jumpOutro === false;
        DB.setCfg({ play: { jumpOutro: on } });
        const sw = $('[data-sw="jumpOutro"]', pb);
        if (sw) sw.classList.toggle('on', on);
        if (!on) hideNext();
      } else if (key === 'resume') {
        const on = DB.cfg().play.resume === false;
        DB.setCfg({ play: { resume: on } });
        const sw = $('[data-sw="resume"]', pb);
        if (sw) sw.classList.toggle('on', on);
      }
    }

    function openLines() {
      if (!state.lines || state.lines.length <= 1) {
        UI.sheet(`<div class="sh-h">选源</div>
          <div class="sh-empty">${state.lines.length ? '只有一条线路' : '脚本没有提供线路信息'}</div>
          <div class="rows">${UI.row({ title: '重新解包', desc: '当前源再拉一次索引', right: '重试', arrow: true, act: 'rebuild' })}</div>`, {
          onOpen: function (pb) {
            const rb = $('[data-act="rebuild"]', pb);
            if (rb) rb.onclick = function () { UI.closeSheet(); rebuild() };
          }
        });
        return;
      }
      UI.sheet(`<div class="sh-h">选源 <span class="sh-d">共 ${state.lines.length} 条线路</span></div>
        <div class="rows">${state.lines.map(function (l, i) {
          return `<div class="row tap" data-line="${i}"><div class="t"><div class="nm">${esc(l.name || ('线路' + (i + 1)))}</div></div><div class="v">${i === state.curLine ? '当前' : '›'}</div></div>`;
        }).join('')}</div>`, {
        onOpen: function (pb) {
          $$('[data-line]', pb).forEach(function (b) {
            b.onclick = function () { switchLine(parseInt(b.dataset.line, 10) || 0) };
          });
        }
      });
    }

    function openSubs() {
      /* 本期未接字幕源：按文案规范给原因 + 后续计划，不假成功 */
      UI.sheet(`<div class="sh-h">字幕</div>
        <div class="sh-empty">字幕：本机暂无匹配（同名/库/在线 将在后续版本接入）</div>
        <div class="rows">
          ${UI.row({ title: '字号', desc: '字幕源接入后可调', right: '—' })}
          ${UI.row({ title: '双语', desc: '字幕源接入后可调', right: '—' })}
        </div>`);
    }

    /* ---------- 播放源链路 ---------- */
    function applyMeta() {
      titleEl.textContent = titleText();
      renderInfo();
      renderEpStrip();
      renderRelated();
      loadIntro();
      updateMarkers();
    }

    async function resolveMeta() {
      if (!state.play) {
        if (!state.url) throw new Error('缺少播放地址');
        setLoading('解析播放页…');
        const r = await Engine.run(site, state.url);
        if (!r.ok) throw new Error('解析失败：' + firstLine(r.error));
        const d = (r.data && (r.data.detail || r.data)) || {};
        state.play = d.play || '';
        if (!state.title) state.title = d.title || '';
        if (!state.pic) state.pic = d.pic || '';
        if ((!state.episodes || !state.episodes.length) && d.episodes && d.episodes.length) state.episodes = d.episodes;
        if ((!state.lines || !state.lines.length) && d.lines && d.lines.length) state.lines = d.lines;
        if (!state.series) state.series = d.series || '';
        if (!state.id) state.id = d.id || state.url;
        /* 详情解析若顺带给了相关推荐，补上；tags 是标签，绝不当作视频推荐 */
        if ((!state.related || !state.related.length) && Array.isArray(d.related)) {
          state.related = d.related.filter(function (x) { return x && x.url });
        }
      }
      /* docs/07：立即播放的源 = detail.play / lines[0].url */
      if (!state.play && state.lines.length) state.play = state.lines[0].url || '';
      /* 脚本偶尔给相对路径（如 /api/hls/x）：按播放页地址补成绝对地址 */
      if (state.play && !/^https?:\/\//i.test(state.play) && state.url) state.play = absUrl(state.play, state.url);
      state.id = state.id || state.url;
      if (!state.play) throw new Error('这个内容没有播放源');
    }

    async function startHls(text, base) {
      const flat = await flattenPlaylist(text, base, site);
      const rw = rewriteM3u8(flat.text, flat.base);
      if (!rw.segs) throw new Error('索引里没有分片');
      const ctl = makeCtl(site, rw.text, rw.map);
      const Loader = makeLoader(ctl);
      if (typeof Hls === 'undefined' || !Hls.isSupported()) throw new Error('本机不支持 HLS 播放');
      destroyHls();
      recoveries = 0;
      hls = new Hls({
        enableWorker: true,
        pLoader: Loader,
        fLoader: Loader,
        loader: Loader,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        capLevelToPlayerSize: false,
        startPosition: -1
      });
      hls.on(Hls.Events.MEDIA_ATTACHED, function () {
        try { hls.loadSource(MANIFEST) } catch (e) { showError(firstLine(e.message)) }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        hideLoading();
        if (video.duration > 0) applyStart();
      });
      hls.on(Hls.Events.ERROR, function (evt, data) {
        if (!data) return;
        if (!data.fatal) { Log.info('hls: ' + data.details); return }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries < 1) {
          recoveries++;
          try { hls.recoverMediaError(); return } catch (e) { }
        }
        const e = data.error || {};
        showError((data.details || 'HLS_ERROR') + (e.message ? '：' + firstLine(e.message) : ''));
      });
      hls.attachMedia(video);
    }

    function startBlob(bytes, kind) {
      destroyHls();
      const mime = sniffMime(bytes);
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      video.src = blobUrl;
      video.load();
      const p = video.play();
      if (p && p.catch) p.catch(function () { showBigPlay() });
      if (kind === 'ts' || mime === 'video/mp2t') {
        /* 纯 TS 分片：Chromium 通常不支持直接播，失败时给明确原因（真 HLS 走 hls.js） */
        toast('该源是 TS 分片');
      }
    }

    async function bootstrap(seekTo) {
      hideError();
      pendingSeek = seekTo || 0;
      started = 0;
      try {
        setLoading('解析播放源…');
        await resolveMeta();
        applyMeta();
        const play = state.play;
        let src = await playSource(play, site);
        let guard = 0;
        while (src && src.kind === 'json' && guard < 2) {
          const j = parseJsonLoose(src.text) || {};
          const vu = j.videoUrl || j.url || j.play || j.src;
          if (!vu) throw new Error('播放源格式不支持');
          src = await playSource(absUrl(vu, play), site);
          guard++;
        }
        if (!src) throw new Error('播放源为空');
        if (src.kind === 'm3u8') {
          setLoading('解包索引…');
          await startHls(src.text, play);
          return;
        }
        if (src.kind === 'ts' || src.kind === 'bin') {
          hideLoading();
          startBlob(src.bytes || src.text, src.kind);
          return;
        }
        throw new Error('未识别的播放源类型');
      } catch (e) {
        showError(firstLine(e && e.message ? e.message : e));
      }
    }

    function rebuild() {
      saveProgress();
      destroyHls();
      try { video.removeAttribute('src'); video.load() } catch (e) { }
      hideResume();
      hideNext();
      bootstrap(0);
    }

    /* ---------- 起播位置 / 续播 / 自动跳片头 ---------- */
    function applyStart() {
      if (started) return;
      if (!(video.duration > 0)) return;
      started = 1;
      hideLoading();
      updateMarkers();
      const cfg = DB.cfg();
      let target = 0;
      if (pendingSeek > 3) {
        target = pendingSeek;
      } else if (params.startPos > 3) {
        target = params.startPos;
      } else {
        const saved = DB.progress(site, state.id, state.ep);
        if (saved && cfg.play.resume !== false && saved.pos > 10 && (!saved.dur || saved.pos < saved.dur - 10)) showResume(saved.pos);
        const it = state.intro;
        if (it && it.introEnd > 0 && it.auto !== false) {
          target = it.introEnd;
          toast('已跳过片头 ' + Math.round(it.introEnd) + 's');
        }
      }
      if (target > 0 && target < video.duration - 2) {
        try { video.currentTime = target } catch (e) { }
      }
      tryPlay();
    }
    function tryPlay() {
      const p = video.play();
      if (p && p.catch) p.catch(function () { showBigPlay() });
    }

    /* ---------- 手势：左亮度 / 右音量 / 横拖进度 / 双击暂停 / 长按倍速 ---------- */
    gest.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { clearTimeout(longTimer); gs = null; return }
      const t = e.touches[0];
      const r = gest.getBoundingClientRect();
      gs = {
        x: t.clientX, y: t.clientY, t: Date.now(), w: r.width, h: r.height,
        mode: '', moved: false, long: false, rate0: 1,
        t0: video.currentTime || 0, v0: video.volume, b0: brightness, seek: 0
      };
      clearTimeout(longTimer);
      longTimer = setTimeout(function () {
        if (!gs || gs.moved || gs.mode) return;
        gs.long = true;
        gs.rate0 = video.playbackRate || 1;
        const lp = DB.cfg().play.longPress || 2;
        video.playbackRate = lp;
        osd(lp + '× 倍速');
      }, 500);
    }, { passive: false });

    gest.addEventListener('touchmove', function (e) {
      if (!gs || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - gs.x, dy = t.clientY - gs.y;
      if (!gs.moved && Math.abs(dx) + Math.abs(dy) > 8) { gs.moved = true; clearTimeout(longTimer) }
      if (gs.long) { e.preventDefault(); return }
      if (!gs.moved) return;
      const cfg = DB.cfg().play;
      if (!gs.mode) {
        if (Math.abs(dx) > Math.abs(dy) * 1.2) gs.mode = cfg.gestureSeek === false ? 'none' : 'seek';
        else if (gs.x < gs.w / 2) gs.mode = cfg.gestureLight === false ? 'none' : 'bright';
        else gs.mode = cfg.gestureVol === false ? 'none' : 'vol';
      }
      if (gs.mode === 'none') return;
      e.preventDefault();
      if (gs.mode === 'seek') {
        const dur = video.duration || 0;
        if (!dur) return;
        const span = clamp(dur * 0.25, 30, 300);
        gs.seek = clamp(gs.t0 + dx / gs.w * span, 0, dur);
        osd('→ ' + fmtTime(gs.seek) + ' / ' + fmtTime(dur));
      } else if (gs.mode === 'bright') {
        brightness = clamp(gs.b0 - dy / gs.h * 0.9, 0.15, 1.6);
        video.style.filter = 'brightness(' + brightness.toFixed(2) + ')';
        osd('亮度 ' + Math.round(brightness * 100) + '%');
      } else {
        const v = clamp(gs.v0 - dy / gs.h, 0, 1);
        video.volume = v;
        video.muted = v <= 0.001;
        osd('音量 ' + Math.round(v * 100) + '%');
      }
    }, { passive: false });

    gest.addEventListener('touchend', function () {
      clearTimeout(longTimer);
      if (!gs) return;
      const g = gs;
      gs = null;
      if (g.long) {
        video.playbackRate = g.rate0 || 1;
        return;
      }
      if (g.mode === 'seek' && g.moved) {
        try { video.currentTime = g.seek } catch (e) { }
        return;
      }
      if (!g.moved && Date.now() - g.t < 300) { onTap(); return }
    }, { passive: true });

    function onTap() {
      const t = Date.now();
      if (t - lastTap < 320) {
        clearTimeout(tapTimer);
        lastTap = 0;
        togglePlay();
        return;
      }
      lastTap = t;
      tapTimer = setTimeout(function () {
        lastTap = 0;
        if (wrap.classList.contains('ctl')) hideCtl(); else showCtl();
      }, 240);
    }

    bigPlay.onclick = function () { hideBigPlay(); tryPlay() };
    wrap.addEventListener('contextmenu', function (e) { e.preventDefault() });

    /* ---------- 进度条拖动 ---------- */
    function ratioOf(clientX) {
      const r = trackEl.getBoundingClientRect();
      return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
    }
    trackEl.addEventListener('pointerdown', function (e) {
      if (!(video.duration > 0)) return;
      dragging = true;
      try { trackEl.setPointerCapture(e.pointerId) } catch (err) { }
      previewSeek(ratioOf(e.clientX));
      e.preventDefault();
    });
    trackEl.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      previewSeek(ratioOf(e.clientX));
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      const r = ratioOf(e.clientX);
      try { video.currentTime = r * video.duration } catch (err) { }
      pendingSeekUI = false;
      updateTime();
      showCtl();
    }
    trackEl.addEventListener('pointerup', endDrag);
    trackEl.addEventListener('pointercancel', function () { dragging = false; pendingSeekUI = false; updateTime() });

    /* ---------- 按钮 ---------- */
    /* 横屏时返回键/返回按钮先退出横屏，不直接退出播放器（硬件返回由 window.__playerBack 接管） */
    $('[data-back]', wrap).onclick = function () {
      if (land) { exitFull(); return }
      App.back();
    };
    $('[data-more]', wrap).onclick = function (e) { e.stopPropagation(); showCtl(); openMore() };
    rateBtn.onclick = cycleRate;
    if (fullBtn) fullBtn.onclick = toggleFull;
    if (fullFlBtn) fullFlBtn.onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); toggleFull() };
    if (actRate) actRate.onclick = cycleRate;
    if (actEps) actEps.onclick = openEps;
    if (actShare) actShare.onclick = shareLink;
    if (actMore) actMore.onclick = function () { showCtl(); openMore() };
    if (actFav) actFav.onclick = function () {
      if (!state.url) return toast('没有可收藏的地址');
      const on = DB.toFav({ site: site, title: state.title || '', pic: state.pic || '', url: state.url });
      refreshFav();
      toast(on ? '已收藏' : '已取消收藏');
    };
    document.getElementById('pbsub').onclick = openSubs;
    document.getElementById('pbline').onclick = openLines;
    document.getElementById('pbin').onclick = markIntro;
    document.getElementById('pbout').onclick = markOutro;
    const errRebuild = $('[data-rebuild]', errEl);
    if (errRebuild) errRebuild.onclick = rebuild;
    $('[data-nextgo]', nextEl).onclick = function () { hideNext(); switchEp(state.ep + 1) };
    $('[data-nextcancel]', nextEl).onclick = function () { hideNext() };

    /* ---------- 旋转 / 尺寸变化：重算进度条宽与手势区域 ----------
       手势区域（gest）每次 touchstart 都用实时 getBoundingClientRect，天然跟随新尺寸；
       这里把拖动中的状态收尾并重画进度。hls 实例不因旋转重建。 */
    function onResize() {
      if (cleaned) return;
      if (dragging) { dragging = false; pendingSeekUI = false; }
      updateTime();
      updateBuffer();
    }
    function onViewport() { onResize(); setTimeout(onResize, 180) }
    window.addEventListener('resize', onViewport);
    window.addEventListener('orientationchange', onViewport);

    /* ---------- <video> 事件 ---------- */
    video.addEventListener('loadedmetadata', applyStart);
    video.addEventListener('durationchange', function () { if (video.duration > 0) applyStart() });
    video.addEventListener('timeupdate', function () {
      updateTime();
      updateBuffer();
      checkOutro();
    });
    video.addEventListener('progress', updateBuffer);
    video.addEventListener('waiting', function () { if (!errEl.classList.contains('on')) setLoading('缓冲中…') });
    video.addEventListener('playing', function () { hideLoading(); hideBigPlay(); showCtl(); hideError() });
    video.addEventListener('pause', function () {
      saveProgress();
      showBigPlay();
      showCtl();
    });
    video.addEventListener('play', function () { hideBigPlay(); showCtl() });
    video.addEventListener('ended', function () { saveProgress(); showBigPlay() });
    video.addEventListener('error', function () {
      /* 只处理本地 Blob（TS/bin）解码失败；HLS 的错误统一走 hls 的 ERROR 事件 */
      if (cleaned) return;
      if (blobUrl) showError('当前内核无法直接播放该封装（TS/二进制）');
    });

    /* 后台切换：默认不后台播放（cfg.play.bgPlay） */
    function onVis() {
      if (document.hidden) {
        saveProgress();
        if (DB.cfg().play.bgPlay !== true) { try { video.pause() } catch (e) { } }
      }
    }
    document.addEventListener('visibilitychange', onVis);

    /* ---------- 清理 ---------- */
    function destroyHls() {
      if (!hls) return;
      try { hls.destroy() } catch (e) { }
      hls = null;
    }
    /* 全局返回钩子：横屏时 Android 返回键先退出横屏（core/boot 的 __back 会优先调用它） */
    const backHook = function () {
      if (land) { exitFull(); return true }
      return false;
    };
    window.__playerBack = backHook;
    window.__playerExitFullscreen = exitFull;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { saveProgress() } catch (e) { }
      clearInterval(saveTimer);
      clearTimeout(ctlTimer);
      clearTimeout(resumeTimer);
      clearInterval(nextTimer);
      clearTimeout(osdTimer);
      clearTimeout(longTimer);
      clearTimeout(tapTimer);
      destroyHls();
      try { video.pause() } catch (e) { }
      try { video.removeAttribute('src'); video.load() } catch (e) { }
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl) } catch (e) { }
        blobUrl = '';
      }
      /* 横屏收尾：解除全屏 class 并恢复竖屏锁定，避免退出页面后还停在横屏 */
      if (land) { land = false; nativeOrient(0) }
      document.body.classList.remove('pl-land');
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('orientationchange', onViewport);
      document.removeEventListener('visibilitychange', onVis);
      if (window.__playerBack === backHook) window.__playerBack = null;
      if (window.__playerExitFullscreen === exitFull) window.__playerExitFullscreen = null;
      if (window.__rouPlayerCleanup === cleanup) window.__rouPlayerCleanup = null;
    }
    if (stTop) stTop.cleanup = cleanup;
    window.__rouPlayerCleanup = cleanup;

    /* ---------- 启动 ---------- */
    const cfgRate = DB.cfg().play.rate;
    setRate(RATES.indexOf(cfgRate) >= 0 ? cfgRate : 1, true);
    updateTime();
    renderInfo();
    renderEpStrip();
    renderRelated();
    /* 换集/换源重开播放器时保持横屏（横屏状态只来源于用户点按钮） */
    if (params.land === true) { land = true; applyOrient() }
    bootstrap(0);
    saveTimer = setInterval(saveProgress, SAVE_MS);
    showCtl();
  };
})();
