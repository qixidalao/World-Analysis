/* plugins.js — 1.8.0 Pack Registry（基础版）
 *
 * 目标：核心不写死语言/组件/主题；pack 用 manifest 声明贡献点。
 * 本版只开放 syntax 贡献点，组件/解析器下一阶段接入。
 *
 * 安全说明：JS pack 仍运行在 WebView 同一上下文，权限是声明式的，
 * 不是强沙箱；只安装可信来源的包。
 */
(function () {
  'use strict';

  var CORE = (window.App && App.info && App.info.version) || '1.9.3';
  var KEY = 'packs';
  var builtin = [];
  var active = {};
  var langs = {};
  var templates = [];
  var themes = {};
  var pages = {};
  var layouts = {};
  var owned = { syntax: {}, components: {}, themes: {}, pages: {}, layouts: {} };

  function store() {
    try { return DB._get(KEY, {}) || {}; } catch (e) { return {}; }
  }
  function save(v) { try { DB._set(KEY, v); } catch (e) { } }

  function semverOk(range) {
    if (!range) return true;
    var m = String(range).match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return true;
    var want = [+m[1], +m[2], +m[3]];
    var cur = CORE.split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      if (cur[i] > want[i]) return true;
      if (cur[i] < want[i]) return false;
    }
    return true;
  }

  function validate(m) {
    if (!m || typeof m !== 'object') return 'manifest 为空';
    if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(String(m.id || ''))) return 'id 不合法';
    if (!m.version) return '缺少 version';
    if (!m.engines || !m.engines.jiexi) return '缺少 engines.jiexi';
    if (!semverOk(m.engines.jiexi)) return '不兼容当前版本 ' + CORE;
    if (!m.contributes || typeof m.contributes !== 'object') return '缺少 contributes';
    return '';
  }

  function apiFor(id) {
    return {
      version: CORE,
      addSyntax: function (name, profile) {
        var n = String(name || '').toLowerCase();
        if (!n) return false;
        langs[n] = { pack: id, profile: profile || {} };
        owned.syntax[n] = id;
        if (window.CodeEditor && CodeEditor.registerLanguage) CodeEditor.registerLanguage(n, profile || {});
        return true;
      },
      addComponent: function (type, fn) {
        if (window.UI && UI.registerComponent) UI.registerComponent(type, fn);
        owned.components[type] = id;
      },
      addParserTemplate: function (t) {
        if (!t || !t.rule) return false;
        templates.push({ pack: id, name: t.name || '模板', desc: t.desc || '', rule: t.rule });
        return true;
      },
      addTheme: function (name, tokens) {
        var n = String(name || '').toLowerCase();
        if (!n || !tokens) return false;
        themes[n] = { pack: id, tokens: tokens };
        owned.themes[n] = id;
        return true;
      },
      addPage: function (name, def) {
        if (!window.App || !App.pages) return false;
        var n = String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
        var key = 'pack_' + id.replace(/[^a-z0-9_]/g, '_') + '_' + n;
        pages[n] = { pack: id, key: key, title: (def && def.title) || name };
        owned.pages[key] = id;
        App.pages[key] = function (root, params, st) {
          root.innerHTML = '';
          if (def && def.title) root.appendChild(UI.topbar({ title: def.title }));
          var body = document.createElement('div');
          body.className = 'page';
          root.appendChild(body);
          if (def && typeof def.render === 'function') def.render(body, params || {}, st);
          if (window.UI && UI.externalLinks) UI.externalLinks(body);
          return Promise.resolve();
        };
        return key;
      },
      addLayout: function (name, def) {
        var n = String(name || '').toLowerCase();
        if (!n || !def || typeof def.render !== 'function') return false;
        layouts[n] = { pack: id, name: n, render: def.render, title: def.title || name };
        owned.layouts[n] = id;
        return true;
      },
      log: function (msg) { try { Log.info('[pack ' + id + '] ' + msg); } catch (e) { } }
    };
  }

  function activateRecord(id, rec, isBuiltin) {
    try {
      var v = validate(rec.manifest);
      if (v) throw new Error(v);
      var code = rec.code;
      if (typeof code === 'function') code(apiFor(id));
      else if (typeof code === 'string' && code.trim()) {
        var fn = new Function('api', '"use strict";\n' + code);
        fn(apiFor(id));
      }
      active[id] = true;
      return true;
    } catch (e) {
      try { Log.err('扩展包激活失败 ' + id + ': ' + e.message); } catch (x) { }
      active[id] = false;
      return false;
    }
  }

  function builtinDefs() {
    return [
      {
        manifest: {
          id: 'core.lang.markdown', name: 'Markdown 语法', version: '1.0.0',
          engines: { jiexi: '>=1.8.0' }, permissions: [],
          contributes: { syntax: ['md'] }
        },
        code: function (api) {
          api.addSyntax('md', {
            lineComment: '', blockComment: ['<!--', '-->'],
            quotes: ['"', "'"], keywords: []
          });
        }
      },
      {
        manifest: {
          id: 'core.lang.html', name: 'HTML 语法', version: '1.0.0',
          engines: { jiexi: '>=1.8.0' }, permissions: [],
          contributes: { syntax: ['html'] }
        },
        code: function (api) {
          api.addSyntax('html', {
            lineComment: '', blockComment: ['<!--', '-->'],
            quotes: ['"', "'"],
            keywords: ['html', 'head', 'body', 'div', 'span', 'a', 'img', 'script', 'style', 'link', 'meta', 'class', 'id']
          });
        }
      },
      {
        manifest: {
          id: 'core.lang.css', name: 'CSS 语法', version: '1.0.0',
          engines: { jiexi: '>=1.8.0' }, permissions: [],
          contributes: { syntax: ['css'] }
        },
        code: function (api) {
          api.addSyntax('css', {
            lineComment: '', blockComment: ['/*', '*/'],
            quotes: ['"', "'"],
            keywords: ['color', 'background', 'display', 'position', 'margin', 'padding', 'border', 'font', 'flex', 'grid', 'width', 'height']
          });
        }
      },
      {
        manifest: {
          id: 'core.ui.card', name: '卡片组件', version: '1.0.0',
          engines: { jiexi: '>=1.8.0' }, permissions: [],
          contributes: { components: ['pack-card'] }
        },
        code: function (api) {
          api.addComponent('pack-card', function (b) {
            var e = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] }) };
            var pic = b.pic || b.url || '';
            return '<div class="cb-pack-card">' + (pic ? '<img src="' + e(pic) + '" alt="">' : '') +
              '<div class="t"><div class="n">' + e(b.title || '') + '</div>' +
              '<div class="d">' + e(b.text || '') + '</div></div></div>';
          });
        }
      },
      {
        manifest: {
          id: 'core.layout.notice', name: '首页公告布局', version: '1.0.0',
          engines: { jiexi: '>=1.8.0' }, permissions: [],
          contributes: { layouts: ['notice'] }
        },
        code: function (api) {
          api.addLayout('notice', {
            title: '公告',
            render: function (el) {
              el.innerHTML = '<div class="st-note">这是由扩展包提供的首页布局块，可在扩展包面板查看来源。</div>';
            }
          });
        }
      },
      {
        manifest: {
          id: 'core.theme.ocean', name: '海洋主题', version: '1.0.0',
          engines: { jiexi: '>=1.8.0' }, permissions: [],
          contributes: { themes: ['ocean'] }
        },
        code: function (api) {
          api.addTheme('ocean', { accent: '#3BA7FF', bg: '#08111E', bg2: '#111D30', bg3: '#182842', line: '#22344F', txt: '#EAF4FF', txt2: '#9CB4D0' });
        }
      },
      {
        manifest: {
          id: 'core.page.demo', name: '扩展示例页', version: '1.0.0',
          engines: { jiexi: '>=1.8.0' }, permissions: [],
          contributes: { pages: ['demo'] }
        },
        code: function (api) {
          api.addPage('demo', {
            title: '扩展示例页',
            render: function (body) {
              body.innerHTML = '<div class="st-note">这个页面不是内置页面，而是扩展包 <b>core.page.demo</b> 通过 <span class="mono">api.addPage()</span> 注册的。</div>' +
                '<div class="st-grp">它做了什么</div><div class="rows"><div class="row"><div class="t"><div class="nm">manifest.contributes.pages</div><div class="ds">声明页面名 demo</div></div></div>' +
                '<div class="row"><div class="t"><div class="nm">code: api.addPage(\'demo\', {render})</div><div class="ds">注册页面并指定标题/渲染函数</div></div></div></div>' +
                '<div class="st-note">你可以在 设置 → 扩展包 → 扩展包文档与示例 看到最小可用 JSON；页面代码与 App 同上下文，只安装可信来源。</div>';
            }
          });
        }
      },
      {
        manifest: {
          id: 'core.parser.basic', name: '基础规则模板', version: '1.0.0',
          engines: { jiexi: '>=1.8.0' }, permissions: [],
          contributes: { parsers: ['basic-list'] }
        },
        code: function (api) {
          api.addParserTemplate({
            name: '基础列表', desc: 'li + h3 + a + img',
            rule: { list: { item: 'li', title: 'h3', url: 'a', pic: 'img' } }
          });
          api.addParserTemplate({
            name: '文章列表', desc: 'article + h2 + a + img',
            rule: { list: { item: 'article', title: 'h2', url: 'a', pic: 'img' } }
          });
        }
      }
    ];
  }

  function installed() { return store(); }

  function list() {
    var out = [];
    builtin.forEach(function (b) {
      out.push({ id: b.manifest.id, manifest: b.manifest, builtin: true, enabled: active[b.manifest.id] !== false });
    });
    var ins = installed();
    Object.keys(ins).forEach(function (id) {
      var r = ins[id];
      if (!r || !r.manifest) return;
      out.push({ id: id, manifest: r.manifest, builtin: false, enabled: !!r.enabled, code: r.code });
    });
    return out;
  }

  function init() {
    builtin = builtinDefs();
    builtin.forEach(function (b) {
      active[b.manifest.id] = false;
      activateRecord(b.manifest.id, b, true);
    });
    var ins = installed();
    Object.keys(ins).forEach(function (id) {
      var r = ins[id];
      if (r && r.enabled) activateRecord(id, r, false);
    });
    initCustomSyntax();
  }

  function initCustomSyntax() { customSyntax().forEach(applySyntaxDef); }

  function setEnabled(id, on) {
    var b = builtin.filter(function (x) { return x.manifest.id === id; })[0];
    if (b) {
      if (on) activateRecord(id, b, true);
      else active[id] = false;
      return { ok: true };
    }
    var ins = installed();
    if (!ins[id]) return { ok: false, err: '包不存在' };
    ins[id].enabled = !!on;
    if (on) {
      var ok = activateRecord(id, ins[id], false);
      if (!ok) { ins[id].enabled = false; save(ins); return { ok: false, err: '激活失败' }; }
    } else active[id] = false;
    save(ins);
    return { ok: true };
  }

  function purge(id) {
    Object.keys(owned.syntax).forEach(function (n) {
      if (owned.syntax[n] !== id) return;
      delete langs[n]; delete owned.syntax[n];
      try { if (window.CodeEditor && CodeEditor.unregisterLanguage) CodeEditor.unregisterLanguage(n); } catch (e) { }
    });
    Object.keys(owned.components).forEach(function (t) {
      if (owned.components[t] !== id) return;
      try { if (window.UI && UI.components) delete UI.components[t]; } catch (e) { }
      delete owned.components[t];
    });
    Object.keys(owned.layouts).forEach(function (n) {
      if (owned.layouts[n] !== id) return;
      delete layouts[n]; delete owned.layouts[n];
    });
    Object.keys(owned.themes).forEach(function (n) {
      if (owned.themes[n] !== id) return;
      delete themes[n]; delete owned.themes[n];
    });
    Object.keys(owned.pages).forEach(function (key) {
      if (owned.pages[key] !== id) return;
      try { if (window.App && App.pages) delete App.pages[key]; } catch (e) { }
      delete pages[key.split('_').pop()]; delete owned.pages[key];
    });
  }

  function install(payload) {
    var manifest = payload && payload.manifest;
    var code = payload && payload.code;
    var err = validate(manifest);
    if (err) return { ok: false, err: err };
    var id = manifest.id;
    var ins = installed();
    var upgraded = false;
    if (ins[id]) {
      var old = String((ins[id].manifest || {}).version || '0');
      if (String(manifest.version || '0') <= old) return { ok: false, err: '同 id 版本未升高' };
      purge(id); delete ins[id]; upgraded = true;
    }
    ins[id] = { manifest: manifest, code: code || '', enabled: true };
    save(ins);
    var ok = activateRecord(id, ins[id], false);
    if (!ok) { ins[id].enabled = false; save(ins); return { ok: false, err: '激活失败' }; }
    return { ok: true, upgraded: upgraded };
  }

  function remove(id) {
    var ins = installed();
    if (!ins[id]) return { ok: false, err: '只能删除已安装包' };
    purge(id);
    delete ins[id];
    delete active[id];
    save(ins);
    return { ok: true };
  }

  function remove(id) {
    var ins = installed();
    if (!ins[id]) return { ok: false, err: '只能删除已安装包' };
    delete ins[id];
    delete active[id];
    save(ins);
    return { ok: true };
  }

  function applySyntaxDef(def) {
    if (!def || !def.name || !def.exts) return;
    var profile = {
      keywords: def.keywords || [],
      types: def.types || [],
      constants: def.constants || [],
      functions: def.functions || [],
      lineComment: def.lineComment || '',
      blockComment: def.blockComment || null,
      quotes: def.quotes || ['"', "'"]
    };
    String(def.exts).split(/[,\s]+/).forEach(function (e) {
      e = e.replace(/^\./, '').toLowerCase();
      if (!e) return;
      langs[e] = { pack: 'custom', profile: profile };
      if (window.CodeEditor && CodeEditor.registerLanguage) CodeEditor.registerLanguage(e, profile);
    });
  }

  function customSyntax() {
    try { return DB.cfg().customSyntax || []; } catch (e) { return []; }
  }

  function addCustomSyntax(def) {
    if (!def || !def.name || !def.exts) return false;
    var list = customSyntax().slice();
    list = list.filter(function (x) { return x.name !== def.name; });
    list.push(def);
    DB.setCfg({ customSyntax: list });
    applySyntaxDef(def);
    return true;
  }

  function removeCustomSyntax(name) {
    var list = customSyntax();
    var hit = list.filter(function (x) { return x.name === name })[0];
    list = list.filter(function (x) { return x.name !== name });
    DB.setCfg({ customSyntax: list });
    if (hit && hit.exts) String(hit.exts).split(/[,\s]+/).forEach(function (e) {
      e = e.replace(/^\./, '').toLowerCase();
      delete langs[e];
      if (window.CodeEditor && CodeEditor.unregisterLanguage) CodeEditor.unregisterLanguage(e);
    });
    return true;
  }

  function langForFile(name) {
    var ext = String(name || '').split('.').pop().toLowerCase();
    if (ext === 'md' || ext === 'markdown') return 'md';
    if (ext === 'html' || ext === 'htm') return 'html';
    if (ext === 'css') return 'css';
    if (ext === 'py') return 'py';
    if (ext === 'json') return 'json';
    if (ext && langs[ext]) return ext;
    return 'js';
  }

  window.Packs = {
    core: CORE,
    init: init,
    list: list,
    install: install,
    remove: remove,
    setEnabled: setEnabled,
    langForFile: langForFile,
    languages: function () { return Object.keys(langs); },
    parserTemplates: function () { return templates.slice(); },
    layouts: function () {
      return Object.keys(layouts).map(function (n) { return { name: n, pack: layouts[n].pack, title: layouts[n].title, render: layouts[n].render }; });
    },
    syntaxes: function () { return customSyntax(); },
    addCustomSyntax: addCustomSyntax,
    removeCustomSyntax: removeCustomSyntax,
    themes: function () {
      return Object.keys(themes).map(function (n) { return { name: n, pack: themes[n].pack, tokens: themes[n].tokens }; });
    },
    pages: function () {
      return Object.keys(pages).map(function (n) { return { name: n, pack: pages[n].pack, key: pages[n].key, title: pages[n].title }; });
    },
    clearTheme: function () {
      try { DB.setCfg({ themePack: '' }); } catch (e) { }
      ['accent', 'bg', 'bg2', 'bg3', 'txt', 'txt2', 'txt3', 'line', 'surface', 'surface2'].forEach(function (k) {
        document.documentElement.style.removeProperty('--' + k);
      });
      try { if (window.UI && UI.applyTheme) UI.applyTheme(); } catch (e) { }
      return true;
    },
    applyTheme: function (name) {
      var t = themes[name];
      if (!t || !t.tokens) return false;
      ['accent', 'bg', 'bg2', 'bg3', 'txt', 'txt2', 'txt3', 'line', 'surface', 'surface2'].forEach(function (k) {
        if (t.tokens[k]) document.documentElement.style.setProperty('--' + k, String(t.tokens[k]));
      });
      try { DB.setCfg({ themePack: name }); } catch (e) { }
      return true;
    },
    componentTypes: function () { return Object.keys((window.UI && UI.components) || {}); },
    audit: function () {
      return { core: CORE, active: Object.keys(active).filter(function (k) { return active[k]; }), languages: Object.keys(langs), components: Object.keys((window.UI && UI.components) || {}), parsers: templates.length, themes: Object.keys(themes), pages: Object.keys(pages), layouts: Object.keys(layouts) };
    }
  };
})();
