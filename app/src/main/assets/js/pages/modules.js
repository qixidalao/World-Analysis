/* modules.js — 模块商店（P-07）
 * 分类：
 *   我的商店   —— https://cloud.lenv.top/pub/jiexi/modules.json（我预编译/上传的第三方模块）
 *   官方商店   —— Chaquopy 官方 Android 预编译 + PyPI 纯 Python（纯原生）
 *   第三方商店 —— 用户自己添加的 modules.json 地址（可增删）
 *   已安装     —— 真实 pip 清单；可卸载 / 加载到当前会话 / 从会话移除
 *   反馈       —— 提交“需要什么模块”，写入云端反馈表
 * 约定：模块不会随 App 启动自动加载；装完只落盘，需要时点“加载到当前会话”。
 * 目录格式见 docs/18-Pip运行时安装.md。
 */
App.pages['module'] = function (root, params) {
  var MY_STORE = localStorage.getItem('rouparser.storeUrl') || 'https://cloud.lenv.top/pub/jiexi/modules.json';
  var FEEDBACK = 'https://cloud.lenv.top/api/feedback';
  var PURE = [
    ['requests', 'HTTP 客户端（纯 Python）'],
    ['beautifulsoup4', 'HTML 解析（纯 Python，推荐）'],
    ['html5lib', 'HTML5 解析器（纯 Python）'],
    ['cssselect', 'CSS 选择器转 XPath（纯 Python）'],
    ['httpx', '现代 HTTP 客户端（纯 Python）'],
    ['idna', '国际化域名（纯 Python）'],
    ['urllib3', 'HTTP 底层库（纯 Python）'],
    ['certifi', 'CA 证书包（纯 Python）'],
    ['charset-normalizer', '字符集检测（纯 Python）']
  ];

  var cat = 'mine';
  var q = '';
  var myStore = null, thirdStores = [], thirdData = [], installed = [];
  var myError = '';
  var busy = false;
  var pipJob = null;
  var queue = [], pendingLoads = [];

  root.innerHTML = '';
  root.appendChild(UI.topbar({ title: '模块商店' }));
  var body = document.createElement('div');
  body.className = 'ms-body';
  root.appendChild(body);

  function abi() {
    try {
      var ti = window.Native && Native.termInfo ? JSON.parse(Native.termInfo()) : null;
      return ti && ti.abi ? ti.abi.replace(/-/g, '_') : 'arm64_v8a';
    } catch (e) { return 'arm64_v8a'; }
  }
  function js(x) { try { return JSON.parse(x || '{}') } catch (e) { return {} } }
  function call(fn, args) {
    try {
      if (!window.Native || typeof window.Native[fn] !== 'function') return { ok: false, err: 'no-bridge' };
      return js(window.Native[fn].apply(window.Native, args || []));
    } catch (e) { return { ok: false, err: String(e.message || e) } }
  }
  function stores() {
    try { return DB._get('moduleStores', []) || [] } catch (e) { return [] }
  }
  function saveStores(list) { try { DB._set('moduleStores', list) } catch (e) { } }
  function loadInstalled() {
    var r = call('pipList');
    installed = (r && r.packages) || [];
  }
  function installedOf(id) {
    var k = String(id).toLowerCase().replace(/-/g, '_');
    for (var i = 0; i < installed.length; i++) {
      if (installed[i].pkg === k) return installed[i];
    }
    return null;
  }

  function fetchJson(url) {
    return Net.get(url).then(function (txt) {
      var d = JSON.parse(txt);
      if (!d || !d.modules) throw new Error('目录格式不对（缺 modules）');
      return d;
    });
  }
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error('请求超时')) }, ms || 12000);
    })]);
  }
  function cacheCatalog(d) {
    try { localStorage.setItem('rouparser.moduleCatalog', JSON.stringify(d)) } catch (e) { }
  }
  function cachedCatalog() {
    try { return JSON.parse(localStorage.getItem('rouparser.moduleCatalog') || 'null') } catch (e) { return null }
  }

  function promptSheet(title, placeholder, onOk) {
    UI.sheet('<div class="st-grp">' + esc(title) + '</div>' +
      '<input class="input tm-pin" placeholder="' + esc(placeholder || '') + '">' +
      '<div class="tm-facts"><button class="btn ghost" data-c>取消</button>' +
      '<button class="btn pri" data-o>确定</button></div>', {
      onOpen: function (pb) {
        var inp = $('.tm-pin', pb);
        setTimeout(function () { try { inp.focus() } catch (e) { } }, 60);
        $('[data-c]', pb).onclick = function () { UI.closeSheet() };
        $('[data-o]', pb).onclick = function () {
          var v = String(inp.value || '').trim();
          if (!v) return;
          UI.closeSheet();
          onOk(v);
        };
      }
    });
  }

  function pipCall(spec, opts, loads) {
    queue.push({ spec: spec, opts: opts || { deps: true } });
    if (loads && loads.length) pendingLoads = pendingLoads.concat(loads);
    pump();
  }
  function pump() {
    if (busy) return;
    if (!queue.length) {
      if (pendingLoads.length) loadPending();
      return;
    }
    var q = queue.shift();
    if (!window.Native || !Native.pipInstall) { UI.toast('当前包没有 pip 桥'); return }
    if (/^https?:\/\//i.test(q.spec)) q.opts.store = true;
    busy = true;
    pipJob = 'm' + Date.now().toString(36);
    var r = call('pipInstall', [pipJob, q.spec, JSON.stringify(q.opts)]);
    if (!r.ok) {
      busy = false;
      UI.toast('启动失败：' + (r.err || ''));
      setTimeout(pump, 100);
      return;
    }
    render();
  }
  function loadPending() {
    var list = pendingLoads.slice();
    pendingLoads = [];
    list.forEach(function (pkg) {
      try { call('pipLoad', [String(pkg).replace(/-/g, '_')]); } catch (e) { }
    });
    loadInstalled();
    render();
  }
  window.__pipEv = function (e) {
    if (!e || e.j !== pipJob) return;
    if (e.t === 'log') { status(String(e.m || '')); return }
    if (e.t === 'prog') {
      if (e.total > 0) status('下载 ' + Math.floor(e.got * 100 / e.total) + '%');
      return;
    }
    if (e.t !== 'done') return;
    busy = false;
    pipJob = null;
    status(e.ok ? ('✓ 已安装 ' + (e.pkg || '') + ' ' + (e.version || '')) : ('安装失败：' + (e.error || '')));
    loadInstalled();
    if (queue.length) pump();
    else if (pendingLoads.length) loadPending();
    else render();
  };

  var statusEl = null;
  function status(t) {
    if (!statusEl) return;
    statusEl.textContent = t;
    statusEl.hidden = !t;
  }

  function fileFor(mod) {
    var a = abi();
    var base = mod.__base || '';
    var files = mod.files || [];
    for (var i = 0; i < files.length; i++) {
      if (files[i].abi === a) return { url: base + files[i].wheel, file: files[i] };
    }
    return null;
  }

  function normId(x) { return String(x || '').toLowerCase().replace(/-/g, '_') }
  function hit(p) {
    var s = q.trim().toLowerCase();
    if (!s) return true;
    return (String(p.name || p.id || p.pkg) + ' ' + String(p.summary || '')).toLowerCase().indexOf(s) >= 0;
  }
  function depSet() {
    var set = {};
    allModules().forEach(function (m) { (m.deps || []).forEach(function (d) { set[normId(d.name || d)] = 1; }); });
    return set;
  }
  function srcOf(p) {
    var m = modFor(p.pkg);
    if (m) {
      if (myStore && (myStore.modules || []).indexOf(m) >= 0) return m.__base && m.__base.indexOf('cloud.lenv.top') < 0 ? '第三方' : '开发者商店';
      return '第三方商店';
    }
    for (var i = 0; i < PURE.length; i++) if (normId(PURE[i][0]) === normId(p.pkg)) return 'PyPI 官方';
    return '依赖/其他';
  }
  function allModules() {
    var out = [];
    if (myStore) out = out.concat(myStore.modules || []);
    thirdData.forEach(function (g) { out = out.concat(g.modules || []); });
    return out;
  }
  function modFor(pkg) {
    var k = normId(pkg);
    var list = allModules();
    for (var i = 0; i < list.length; i++) {
      if (normId(list[i].id) === k) return list[i];
    }
    return null;
  }
  function findMod(id) {
    var list = allModules();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function verCmp(a, b) {
    var pa = String(a || '').split('.'), pb = String(b || '').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var va = parseInt(pa[i], 10) || 0, vb = parseInt(pb[i], 10) || 0;
      if (va !== vb) return va - vb;
    }
    return 0;
  }
  function updates() {
    var out = [];
    installed.forEach(function (p) {
      var m = modFor(p.pkg);
      if (m && m.version && verCmp(m.version, p.version) > 0) out.push({ p: p, mod: m });
    });
    return out;
  }

  function installMod(mod) {
    var f = fileFor(mod);
    if (!f) { UI.toast(mod.level === 'android' || (mod.abi && mod.abi.length) ? '该模块需要预编译轮子，当前不下载安装' : ('没有适配 ' + abi() + ' 的轮子')); return }
    var steps = [], loads = [];
    (mod.deps || []).forEach(function (d) {
      var a = abi(), df = (d.files || []).filter(function (x) { return x.abi === a })[0];
      if (df) { steps.push((mod.__base || '') + df.wheel); loads.push(d.name); }
    });
    steps.push(f.url);
    loads.push(mod.id);
    steps.forEach(function (u, i) {
      pipCall(u, { deps: false }, i === steps.length - 1 ? loads : null);
    });
  }

  function card(mod) {
    var f = fileFor(mod);
    var inst = installedOf(mod.id);
    var can = !!f;
    var up = !!(inst && mod.version && verCmp(mod.version, inst.version) > 0);
    var meta = (mod.level === 'android' ? '预编译' : '纯 Python') + ' · ' + (mod.version || '') +
      ' · ' + ((mod.abi || []).join('/') || '') + ((mod.deps && mod.deps.length) ? (' · 依赖 ' + mod.deps.length) : '');
    return '<div class="row"><div class="t"><div class="nm">' + esc(mod.name || mod.id) +
      (inst ? ' <span class="tag">已装</span>' : '') +
      (up ? ' <span class="tag">可更新 ' + esc(mod.version) + '</span>' : '') + '</div>' +
      '<div class="ds">' + esc(mod.summary || '') + '</div>' +
      '<div class="ds mono">' + esc(meta) + '</div></div>' +
      (inst
        ? ((up && can ? '<button class="btn pri" data-in="' + esc(mod.id) + '">更新</button>' : '') +
           '<button class="btn ghost" data-un="' + esc(inst.pkg) + '">卸载</button>')
        : (can ? '<button class="btn pri" data-in="' + esc(mod.id) + '">安装</button>'
          : '<span class="tag">无本机 ABI</span>')) +
      '</div>';
  }

  function userCard(p) {
    var inst = installedOf(p.id);
    var loaded = window.__loaded && window.__loaded[p.id];
    return '<div class="row"><div class="t"><div class="nm">' + esc(p.name || p.id) +
      (inst ? ' <span class="tag">已装</span>' : '') + '</div>' +
      '<div class="ds">' + esc(p.summary || '') + '</div></div>' +
      (inst
        ? '<button class="btn ghost" data-unload="' + esc(inst.pkg) + '">' + (loaded ? '移除会话' : '加载') + '</button>' +
          '<button class="btn ghost" data-un="' + esc(inst.pkg) + '">卸载</button>'
        : '<button class="btn pri" data-pure="' + esc(p.id) + '">安装</button>') +
      '</div>';
  }

  function render() {
    var h = '';
    h += '<div class="seg ms-seg">' + [
      ['mine', '我的'], ['official', '官方'], ['third', '第三方'], ['installed', '已安装'], ['feedback', '反馈']
    ].map(function (x) {
      return '<b data-cat="' + x[0] + '" class="' + (cat === x[0] ? 'on' : '') + '">' + x[1] + '</b>';
    }).join('') + '</div>';
    h += '<div class="ms-status mono" hidden></div>';
    if (cat === 'mine' || cat === 'official' || cat === 'third' || cat === 'installed') {
      h += '<div class="ms-search"><input class="input" id="msSearch" placeholder="搜索模块 / 说明" value="' + esc(q) + '"></div>';
    }
    var ups = updates();
    if (ups.length) {
      h += '<div class="ms-upd">发现 ' + ups.length + ' 个模块可更新 ' +
        '<button class="btn pri" data-upall>全部更新</button></div>';
      if (!window.__updNotified) {
        window.__updNotified = true;
        setTimeout(function () { UI.toast('模块商店：' + ups.length + ' 个模块可更新') }, 300);
      }
    }

    if (cat === 'mine') {
      h += '<div class="st-grp">我的商店 · 预编译模块（用户主动安装）</div>';
      if (myError) h += '<div class="ms-empty">' + esc(myError) +
        '<br><button class="btn ghost" data-retrycat>重试</button></div>';
      if (!myStore) h += (myError ? '' : '<div class="ms-empty">正在读取 ' + esc(MY_STORE) + '</div>');
      else if (!myStore.modules.length) h += '<div class="ms-empty">我的商店还没有模块</div>';
      else h += myStore.modules.filter(hit).map(card).join('');
      h += '<div class="st-note">来源：' + esc(MY_STORE) + ' · 安装后自动加载到当前 Python 会话。</div>';
    } else if (cat === 'official') {
      h += '<div class="st-grp">官方 · 纯 Python（PyPI）</div>';
      h += PURE.filter(function (x) { return hit({ id: x[0], name: x[0], summary: x[1] }); }).map(function (x) { return userCard({ id: x[0], name: x[0], summary: x[1] }); }).join('');
      h += '<div class="st-grp">官方 · Android 预编译（Chaquopy 仓库）</div>';
      h += '<div class="ms-empty">lxml 5.3.0 官方 Android 轮子已可用，但需要 libxml2/libxslt companion；<br>' +
        '等预加载接好后在「我的商店」提供；当前请用 beautifulsoup4/html5lib 纯 Python 替代。</div>';
    } else if (cat === 'third') {
      h += '<div class="st-grp">第三方商店 · 自定义 modules.json</div>';
      h += thirdStores.map(function (u, i) {
        return '<div class="row"><div class="t"><div class="ds mono lines2">' + esc(u) + '</div></div>' +
          '<button class="btn ghost" data-delstore="' + i + '">删除</button></div>';
      }).join('') || '<div class="ms-empty">还没有第三方商店地址</div>';
      h += '<div class="row tap" data-addstore><div class="t"><div class="nm">＋ 添加第三方商店</div>' +
        '<div class="ds">填一个返回 modules.json 的 https 地址</div></div><div class="arw">›</div></div>';
      h += thirdData.map(function (g) {
        var mods = (g.modules || []).filter(hit);
        return mods.length ? '<div class="st-grp">' + esc(g.name) + '</div>' + mods.map(card).join('') : '';
      }).join('');
    } else if (cat === 'installed') {
      var dep = depSet();
      var direct = installed.filter(function (p) { return !dep[normId(p.pkg)]; });
      var deps = installed.filter(function (p) { return dep[normId(p.pkg)]; });
      h += '<div class="st-grp">已安装（' + installed.length + '）</div>';
      function instRow(p) {
        var loaded = window.__loaded && window.__loaded[p.pkg];
        var m = modFor(p.pkg);
        var up = !!(m && m.version && verCmp(m.version, p.version) > 0);
        return '<div class="row"><div class="t"><div class="nm">' + esc(p.pkg) +
          ' <span class="tag">' + esc(srcOf(p)) + '</span>' +
          (loaded ? ' <span class="tag">会话中</span>' : '') +
          (up ? ' <span class="tag">可更新 ' + esc(m.version) + '</span>' : '') + '</div>' +
          '<div class="ds mono">' + esc(p.version) + ' · ' + esc(p.path) + '</div></div>' +
          (up ? '<button class="btn pri" data-in="' + esc(m.id) + '">更新</button>' : '') +
          '<button class="btn ghost" data-load="' + esc(p.pkg) + '">' + (loaded ? '移出' : '加载') + '</button>' +
          '<button class="btn ghost" data-un="' + esc(p.pkg) + '">卸载</button></div>';
      }
      h += '<div class="st-grp">直接安装（' + direct.length + '）</div>';
      if (!direct.length) h += '<div class="ms-empty">没有直接安装的模块</div>';
      else h += direct.filter(hit).map(instRow).join('');
      h += '<div class="st-grp">依赖（' + deps.length + '）</div>';
      if (!deps.length) h += '<div class="ms-empty">没有自动安装的依赖</div>';
      else h += deps.filter(hit).map(instRow).join('');
      h += '<div class="st-note">「安装」把包写入模块目录；「加载」把包加入当前 Python 会话 sys.path，脚本 import 才立即可用。本版安装成功后会自动加载，重启 App 需重新加载。</div>';
    } else {
      h += '<div class="st-grp">反馈 · 需要什么模块？</div>' +
        '<div class="ms-form"><input class="input" id="fbModel" placeholder="模块名，如 lxml / numpy / pandas">' +
        '<input class="input" id="fbContact" placeholder="联系方式（可选）">' +
        '<textarea class="input" id="fbReason" rows="4" placeholder="用途 / 版本要求 / 设备"></textarea>' +
        '<button class="btn pri" id="fbSend">提交反馈</button></div>' +
        '<div class="st-note">反馈会写入云端 <span class="mono">/api/feedback</span>，用于后续预编译排期。</div>';
    }
    body.innerHTML = h;
    statusEl = $('.ms-status', body);
    if (busy) status('安装中…');
    bind();
  }

  function bind() {
    var search = $('#msSearch', body);
    if (search) {
      search.oninput = function () {
        q = search.value;
        var pos = search.selectionStart;
        render();
        var s2 = $('#msSearch', body);
        if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (e) { } }
      };
    }
    $$('[data-cat]', body).forEach(function (b) {
      b.onclick = function () { cat = b.dataset.cat; render(); };
    });
    var retry = $('[data-retrycat]', body);
    if (retry) retry.onclick = function () {
      myStore = null; myError = ''; render();
      loadMine().then(function () { render(); });
    };
    $$('[data-in]', body).forEach(function (b) {
      b.onclick = function () {
        var mod = findMod(b.dataset.in);
        if (mod) installMod(mod);
      };
    });
    var upall = $('[data-upall]', body);
    if (upall) upall.onclick = function () {
      var list = updates();
      if (!list.length) return;
      UI.toast('开始更新 ' + list.length + ' 个模块');
      list.forEach(function (u) { installMod(u.mod); });
    };
    $$('[data-pure]', body).forEach(function (b) {
      b.onclick = function () { pipCall(b.dataset.pure, { deps: true }, [normId(b.dataset.pure)]); };
    });
    $$('[data-un]', body).forEach(function (b) {
      b.onclick = function () {
        var r = call('pipRemove', [b.dataset.un]);
        if (r.ok) { UI.toast('已卸载'); loadInstalled(); render(); }
        else UI.toast('卸载失败：' + (r.err || ''));
      };
    });
    $$('[data-load]', body).forEach(function (b) {
      b.onclick = function () {
        var pkg = b.dataset.load;
        window.__loaded = window.__loaded || {};
        var on = !!window.__loaded[pkg];
        var r = call(on ? 'pipUnload' : 'pipLoad', [pkg]);
        if (r.ok) { window.__loaded[pkg] = !on; UI.toast(on ? '已从会话移除' : '已加载到当前会话'); render(); }
        else UI.toast('操作失败：' + (r.err || ''));
      };
    });
    var add = $('[data-addstore]', body);
    if (add) add.onclick = function () {
      promptSheet('添加第三方商店', 'https://example.com/modules.json', function (u) {
        if (!/^https?:\/\//.test(u)) { UI.toast('需要 http(s) 地址'); return }
        thirdStores.push(u); saveStores(thirdStores); loadThird();
      });
    };
    $$('[data-delstore]', body).forEach(function (b) {
      b.onclick = function () {
        thirdStores.splice(Number(b.dataset.delstore), 1);
        saveStores(thirdStores); loadThird();
      };
    });
    var send = $('#fbSend', body);
    if (send) send.onclick = function () {
      var model = String(($('#fbModel', body) || {}).value || '').trim();
      var reason = String(($('#fbReason', body) || {}).value || '').trim();
      var contact = String(($('#fbContact', body) || {}).value || '').trim();
      if (!model) { UI.toast('填一下模块名'); return }
      var u = FEEDBACK + '?module=' + encodeURIComponent(model) +
        '&reason=' + encodeURIComponent(reason) + '&contact=' + encodeURIComponent(contact);
      send.disabled = true;
      Net.get(u).then(function () {
        send.disabled = false;
        UI.toast('反馈已提交');
        $('#fbModel', body).value = '';
        $('#fbReason', body).value = '';
      }, function (e) {
        send.disabled = false;
        UI.toast('提交失败：' + e.message);
      });
    };
  }

  function loadMine() {
    return withTimeout(fetchJson(MY_STORE), 12000).then(function (d) {
      d.modules.forEach(function (m) { m.__base = d.base || MY_STORE.replace(/modules\.json$/, ''); });
      myStore = d;
      myError = '';
      cacheCatalog(d);
    }, function (e) {
      var c = cachedCatalog();
      if (c) { myStore = c; myError = '实时目录读取失败，显示缓存：' + e.message; }
      else { myStore = { modules: [] }; myError = '目录读取失败：' + e.message; }
    });
  }
  function loadThird() {
    thirdStores = stores();
    return Promise.all(thirdStores.map(function (u) {
      return fetchJson(u).then(function (d) {
        d.modules.forEach(function (m) { m.__base = d.base || u.replace(/modules\.json$/, ''); });
        return { name: u, modules: d.modules };
      }, function () { return { name: u, modules: [] }; });
    })).then(function (list) { thirdData = list; render(); });
  }

  loadInstalled();
  render();
  loadMine().then(function () { render(); loadThird(); });
  loadThird();
  return Promise.resolve();
};
