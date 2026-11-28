/* mine.js — T-4 我的（个性化页，不放功能宫格）
   数据源：DB.cfg().profile / DB.stats() / DB.fav() / DB.hist()，全部本地。
   结构：资料卡（V-10）/ 三项统计 / 我的内容 / 个性化 / 其他 / 版本。
   规则（docs/07 T-4）：终端 / 模块 / 脚本 / 设置的功能宫格**只在主页**，这里不重复摆。
   7 态：纯本地页 → loading / offline / invalid 不适用；
        ready、error（渲染异常）、empty（资料卡「未设置昵称」+ 统计显示 0 不隐藏）、
        partial（统计读取失败时降级为 0 并出错误条）已实现。 */
(function () {
  const VER = (window.App && App.info && App.info.version) || '0.0.0';
  const FAV_SEG_KEY = 'rouparser.favSeg';   // 与 fav.js / home.js 共用：进 T-3 时落到指定段
  const AVATARS = ['🐍', '🔥', '📚', '😼', '🎬', '🖼'];   // docs/07 V-10：6 个头像（3×2）
  const DAY = 86400000;

  const LS = { set(k, v) { try { localStorage.setItem(k, v) } catch (e) { } } };

  function firstLine(s) { return String(s == null ? '' : s).split('\n')[0].slice(0, 120) }

  /* 存储占用估算：所有 rouparser.* 键按 UTF-16 字符数 × 2 估算（WebView 无文件系统 API） */
  function storeBytes() {
    let n = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf(DB.NS) !== 0) continue;
        const v = localStorage.getItem(k) || '';
        n += (k.length + v.length) * 2;
      }
    } catch (e) { Log.err('统计存储失败: ' + e.message) }
    return n;
  }

  /* 统计读取失败时降级成 0，并让页面出区块错误条（partial） */
  function statsSafe() {
    try {
      return { s: DB.stats(), err: '' };
    } catch (e) {
      Log.err('读取统计失败: ' + e.message);
      return {
        s: { videos: 0, hours: 0, hist: DB.hist().length, sites: DB.sites().length, scripts: 0 },
        err: firstLine(e.message)
      };
    }
  }

  function profileSafe() {
    let p = DB.cfg().profile || {};
    if (!p.joinedAt) {
      /* 首次进入记下「加入时间」，只写一次（docs/07：加入 N 天） */
      try {
        DB.setCfg({ profile: { joinedAt: now() } });
        p = DB.cfg().profile || p;
      } catch (e) { Log.err('写入加入时间失败: ' + e.message) }
    }
    return p;
  }

  function decoderName(d) {
    return { auto: '自动', hw: '硬解', sw: '软解' }[d] || '自动';
  }
  function themeName(t) { return t === 'light' ? '浅色' : '深色' }
  function homeSummary(hc) {
    const keys = ['welcome', 'tiles', 'sites', 'cont', 'notice'];
    const off = keys.filter(k => !hc[k]).length;
    return off ? '已关 ' + off + ' 项' : '默认';
  }

  /* ---------------- 注册 Tab ---------------- */
  App.tabs['mine'] = function (root) {
    root.innerHTML = '';
    try {
      render(root);
    } catch (e) {
      Log.err('我的页渲染失败: ' + e.message);
      root.innerHTML = '';
      UI.state(root, 'error', { msg: '我的页加载失败：' + firstLine(e.message), retry: () => App.renderTab() });
    }
  };

  function render(root) {
    const cfg = DB.cfg();
    const prof = profileSafe();
    const r = statsSafe();
    const s = r.s;
    const favN = DB.fav().length;
    const histN = s.hist;

    root.appendChild(UI.topbar({ back: false, title: '个人中心' }));
    const body = document.createElement('div');
    root.appendChild(body);

    if (r.err) body.appendChild(UI.errbar('统计读取失败：' + r.err, () => App.renderTab()));
    body.appendChild(profileCard(prof, s));

    /* 三项统计：部影片 / 小时 / 条历史，为 0 也显示（保留 1 位小数） */
    const stats = document.createElement('div');
    stats.className = 'me-stats';
    stats.innerHTML = [
      [String(s.videos || 0), '部影片'],
      [(s.hours || 0).toFixed(1), '小时'],
      [String(s.hist || 0), '条历史']
    ].map(x => '<div class="stat"><b>' + esc(x[0]) + '</b><s>' + x[1] + '</s></div>').join('');
    body.appendChild(stats);

    const play = cfg.play || {};
    const rows = [
      { grp: '我的内容', items: [
        { icon: '❤️', title: '收藏', right: String(favN), arrow: true, act: 'fav' },
        { icon: '🕘', title: '历史', right: String(histN), arrow: true, act: 'hist' },
      ] },
      { grp: '其他', items: [
        { title: '反馈与建议', arrow: true, act: 'feedback' }
      ] }
    ];
    body.insertAdjacentHTML('beforeend', rows.map(g =>
      '<div class="rows"><div class="grp">' + g.grp + '</div>' + g.items.map(UI.row).join('') + '</div>').join(''));
    body.insertAdjacentHTML('beforeend',
      '<div class="home-foot">界析 v' + VER + '</div><div class="tab-end"></div>');

    $$('.rows .row[data-act]', body).forEach(node => {
      node.onclick = () => onAct(node.dataset.act);
    });
  }

  /* ---------------- 资料卡（点 → V-10） ---------------- */
  function profileCard(prof, s) {
    const days = Math.max(1, Math.ceil((now() - (prof.joinedAt || now())) / DAY));
    const nick = String(prof.nick || '').trim();
    const card = document.createElement('div');
    card.className = 'me-card';
    card.innerHTML =
      '<div class="me-av">' + UI.avatarHTML(prof.avatar) + '</div>' +
      '<div class="me-t"><div class="nm">' + esc(nick || '未设置昵称') + '<span class="ed">✎</span></div>' +
      '<div class="ds">加入 ' + days + ' 天 · ' + (s.sites || 0) + ' 个站点 · ' + (s.scripts || 0) + ' 脚本</div></div>' +
      '<div class="me-arw">›</div>';
    card.onclick = openProfile;
    return card;
  }

  /* ---------------- 行点击分发 ---------------- */
  function onAct(act) {
    if (act === 'fav') {
      LS.set(FAV_SEG_KEY, 'fav');
      return App.setTab('fav');
    }
    if (act === 'hist') {
      LS.set(FAV_SEG_KEY, 'hist');
      return App.setTab('fav');
    }
    if (act === 'ui' || act === 'font') return App.go('settings.ui');   // 字号与主题同页（P-14）
    if (act === 'play') return App.go('settings.play');
    if (act === 'storage') return App.go('settings.storage');
    if (act === 'about') return App.go('settings.about');
    if (act === 'feedback') return App.go('feedback');
    if (act === 'homelayout') {
      /* 主页布局 → 回主页 Tab 再开 V-09（复用 home.js 的浮层，避免两份实现） */
      const home = App.tabs['home'];
      if (home && home.openCustomize) home.openCustomize();
      else UI.toast('主页未就绪');
    }
  }

  /* ---------------- V-10 个人资料（emoji 或 自定义图片 URL） ---------------- */
  function openProfile() {
    const p = DB.cfg().profile || {};
    const initAv = String(p.avatar || '🐍').trim();
    const initUrl = UI.avatarIsUrl(initAv) ? initAv : '';
    let picked = UI.avatarIsUrl(initAv) ? '🐍' : (initAv || '🐍');
    let urlState = initUrl ? 'idle' : 'idle';

    UI.sheet(
      '<div class="sheet-hd">个人资料</div>' +
      '<div class="fm av-row"><div class="me-av big" id="avBig"></div>' +
      '<div><div class="nm" id="avName">当前头像</div>' +
      '<div class="av-hint" id="avHint">emoji 或 图片 URL 二选一，图片优先</div></div></div>' +
      '<div class="fm"><label>昵称</label>' +
      '<input class="input" id="nickInput" maxlength="16" placeholder="未设置昵称" value="' + esc(p.nick || '') + '"></div>' +
      '<div class="fm"><label>头像 emoji</label><div class="avatars">' +
      AVATARS.map(a => '<div class="av' + (a === picked ? ' on' : '') + '" data-av="' + esc(a) + '">' +
        esc(a) + '</div>').join('') + '</div></div>' +
      '<div class="fm"><label>图片 URL（可选）</label>' +
      '<input class="input" id="avUrl" spellcheck="false" autocapitalize="off" ' +
      'placeholder="https://example.com/avatar.png" value="' + esc(initUrl) + '"></div>' +
      '<div class="sh-act"><button class="btn pri block" data-save>保存</button></div>',
      {
        onOpen: pb => {
          const big = $('#avBig', pb);
          const input = $('#avUrl', pb);
          const hint = $('#avHint', pb);
          const nameEl = $('#avName', pb);
          let probe = null;
          let timer = null;

          const setHint = (text, cls) => {
            if (!hint) return;
            hint.className = 'av-hint' + (cls ? ' ' + cls : '');
            hint.textContent = text;
          };
          const renderBig = av => {
            if (!big) return;
            big.innerHTML = UI.avatarHTML(av);
            const nm = big.querySelector('.av-img');
            if (nm) { nm.onerror = () => { big.innerHTML = UI.avatarHTML(picked); setHint('图片加载失败，已回退 emoji', 'err'); } }
          };
          const current = () => String((input && input.value) || '').trim() || picked;
          renderBig(initAv);
          if (nameEl) nameEl.textContent = initUrl ? '自定义图片' : ('emoji ' + picked);

          const validate = url => {
            if (timer) clearTimeout(timer);
            if (!url) {
              urlState = 'idle';
              setHint('当前使用 emoji 头像', '');
              renderBig(picked);
              if (nameEl) nameEl.textContent = 'emoji ' + picked;
              return;
            }
            if (!/^(https?:\/\/|data:image\/)/i.test(url)) {
              urlState = 'fail';
              setHint('URL 格式不对：需要以 http:// 或 https:// 开头', 'err');
              renderBig(picked);
              return;
            }
            urlState = 'loading';
            setHint('正在加载图片…', '');
            renderBig(url);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              if (probe) { probe.onload = probe.onerror = null; probe = null; }
              probe = new Image();
              probe.onload = () => {
                urlState = 'ok';
                const wh = probe.naturalWidth + '×' + probe.naturalHeight;
                setHint('图片已加载（' + wh + '）', 'ok');
                if (nameEl) nameEl.textContent = '自定义图片';
              };
              probe.onerror = () => {
                urlState = 'fail';
                setHint('图片加载失败：URL 无法访问、不是图片，或被防盗链拦截', 'err');
                renderBig(picked);
                if (nameEl) nameEl.textContent = 'emoji ' + picked;
              };
              probe.src = url;
            }, 420);
          };

          if (input) {
            input.oninput = () => validate(String(input.value || '').trim());
            input.onblur = () => validate(String(input.value || '').trim());
          }
          $$('[data-av]', pb).forEach(node => {
            node.onclick = () => {
              $$('[data-av]', pb).forEach(x => x.classList.remove('on'));
              node.classList.add('on');
              picked = node.dataset.av;
              if (input) input.value = '';
              urlState = 'idle';
              setHint('当前使用 emoji 头像', '');
              renderBig(picked);
              if (nameEl) nameEl.textContent = 'emoji ' + picked;
            };
          });

          const save = $('[data-save]', pb);
          if (save) save.onclick = () => {
            const nick = String(($('#nickInput', pb) || {}).value || '').trim().slice(0, 16);
            const url = String((input && input.value) || '').trim();
            const doSave = () => {
              DB.setCfg({ profile: { nick: nick, avatar: url || picked } });
              UI.closeSheet();
              App.renderTab();
              UI.toast(url ? '已保存图片头像' : '已保存资料');
            };
            if (url && urlState === 'fail') {
              UI.dialog({
                title: '图片加载失败',
                msg: '这个 URL 目前取不到图片（无法访问 / 不是图片 / 防盗链），保存后会显示默认 emoji 头像。仍要保存吗？',
                okText: '仍然保存', cancelText: '返回修改', danger: true,
                onOk: doSave
              });
              return;
            }
            if (url && urlState === 'idle') validate(url);   // 还没校验过就点保存：先校验再保存
            doSave();
          };
        }
      });
  }

  /* ---------------- 反馈与建议 ---------------- */
  App.pages['feedback'] = function (root) {
    root.innerHTML = '';
    root.appendChild(UI.topbar({ title: '反馈与建议' }));
    var body = document.createElement('div');
    body.innerHTML =
      '<div class="st-note">说明需要什么模块、遇到什么问题；反馈写入云端，用于排期和修复。</div>' +
      '<div class="d1-pad">' +
      '<input class="input" id="fbModel" placeholder="模块名 / 问题标题">' +
      '<input class="input" id="fbContact" placeholder="联系方式（可选）">' +
      '<textarea class="input" id="fbReason" rows="5" placeholder="用途 / 复现步骤 / 设备与版本"></textarea>' +
      '<button class="btn pri block" id="fbSend">提交反馈</button></div>' +
      '<div class="st-note">提交失败时会把内容复制到剪贴板，可手动发送。</div>';
    root.appendChild(body);
    $('#fbSend', body).onclick = function () {
      var model = String($('#fbModel', body).value || '').trim();
      var reason = String($('#fbReason', body).value || '').trim();
      var contact = String($('#fbContact', body).value || '').trim();
      if (!model || !reason) { UI.toast('标题和说明必填'); return }
      var url = 'https://cloud.lenv.top/api/feedback?module=' + encodeURIComponent(model) +
        '&reason=' + encodeURIComponent(reason) + '&contact=' + encodeURIComponent(contact);
      Net.get(url).then(function () {
        UI.toast('反馈已提交');
        $('#fbModel', body).value = ''; $('#fbReason', body).value = ''; $('#fbContact', body).value = '';
      }, function (e) {
        try { navigator.clipboard.writeText(model + '\n' + reason + '\n' + contact); } catch (x) { }
        UI.toast('提交失败，已尝试复制：' + (e.message || e));
      });
    };
  };
})();
