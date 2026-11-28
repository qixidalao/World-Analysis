/* engine.js — JS 脚本引擎（docs/02 契约的 JS 实现）
   脚本 = 一个站点；形式：{ name, icon, site, group, tabs, home(), parse(url,html), search?(kw), fetch?(url) }
   Java/Python 后端后续接入时，同一 JSON 契约不变（docs/01 §1）。 */
const Engine = {
  builtin: {},          // id -> source（来自 index.html 的 <script type="text/plain">）
  _mods: {},            // id -> 已编译对象

  init() {
    $$('script[type="text/plain"][data-script]').forEach(el => { this.builtin[el.dataset.script] = el.textContent });
    return this;
  },

  /* 取脚本源码：本地 DB 优先，其次内置 */
  source(id) {
    const s = DB.site(id);
    if (s && s.script) return s.script;
    return this.builtin[id] || '';
  },

  /* 编译：去掉 export default，包进 IIFE，返回脚本对象 */
  compile(src, id) {
    let s = String(src || '').trim();
    if (!s) throw new Error('脚本为空');
    s = s.replace(/export\s+default\s+/, 'var __rouDefault = ');
    s = s.replace(/^\s*export\s+(?=(?:async\s+)?function|const|let|var|class)/gm, '');
    let obj;
    try {
      s += '\n;if(!__rouDefault)__rouDefault={};if(!__rouDefault.config&&typeof CONFIG!==\'undefined\')__rouDefault.config=CONFIG;return __rouDefault;';
      obj = (new Function('"use strict";\n' + s + '\n'))();
    } catch (e) {
      throw new Error('脚本语法错误: ' + e.message);
    }
    if (!obj || typeof obj.parse !== 'function') throw new Error('脚本缺少 parse(url, html)');
    obj.__id = id;
    return obj;
  },

  /* 多文件 JS：轻量打包（相对 import / export default / 命名导出） */
  compileBundle(files, entry, noValidate) {
    files = files || {};
    const names = Object.keys(files);
    if (!names.length) throw new Error('没有文件');
    entry = entry && files[entry] ? entry : names[0];
    const transformed = {};
    for (const name of names) {
      let src = String(files[name] == null ? '' : files[name]);
      const exports = [];
      src = src.replace(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm, (m, what, spec) => {
        what = what.trim();
        if (what.startsWith('*')) return 'const ' + what.split(/\s+as\s+/)[1] + ' = __req(\'' + spec + '\');';
        if (what.startsWith('{')) return 'const ' + what + ' = __req(\'' + spec + '\');';
        return 'const ' + what + ' = __req(\'' + spec + '\').default;';
      });
      src = src.replace(/^\s*import\s+['"]([^'"]+)['"];?\s*$/gm, (m, spec) => '__req(\'' + spec + '\');');
      src = src.replace(/\bimport\s*\(/g, 'Promise.resolve(__req(');
      src = src.replace(/\brequire\s*\(/g, '__req(');
      src = src.replace(/\bmodule\.exports\s*=/g, '__exports.default =');
      src = src.replace(/\bexports\./g, '__exports.');
      src = src.replace(/^\s*export\s+default\s+/gm, '__exports.default = ');
      src = src.replace(/^\s*export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, (m, a, n) => { exports.push(n); return (a || '') + 'function ' + n; });
      src = src.replace(/^\s*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (m, k, n) => { exports.push(n); return k + ' ' + n; });
      src = src.replace(/^\s*export\s*\{([^}]+)\}\s*;?\s*$/gm, (m, list) => {
        list.split(',').forEach(x => {
          const parts = x.trim().split(/\s+as\s+/);
          if (parts[0]) exports.push(parts[0]);
        });
        return '';
      });
      if (exports.length) src += '\n' + exports.map(n => '__exports[' + JSON.stringify(n) + '] = ' + n + ';').join('\n');
      transformed[name] = src;
    }
    const code = 'var __files = ' + JSON.stringify(transformed) + ';\n' +
      'var __cache = {};\n' +
      'function __norm(from, req) {\n' +
      '  if (!req) return req;\n' +
      '  if (req.charAt(0) !== ".") return req;\n' +
      '  var parts = from.split("/"); parts.pop();\n' +
      '  var segs = (parts.join("/") + "/" + req).split("/");\n' +
      '  var out = [];\n' +
      '  for (var i = 0; i < segs.length; i++) { var s = segs[i]; if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }\n' +
      '  return out.join("/");\n' +
      '}\n' +
      'function __load(name) {\n' +
      '  if (__cache[name]) return __cache[name];\n' +
      '  if (!__files[name]) throw new Error("模块不存在: " + name);\n' +
      '  var exports = {}; __cache[name] = exports;\n' +
      '  var fn = new Function("__exports", "__req", __files[name]);\n' +
      '  fn(exports, function (s) { return __load(__norm(name, s)); });\n' +
      '  return exports;\n' +
      '}\n' +
      'var __entry = __load(' + JSON.stringify(entry) + ');\n' +
      'return __entry && (__entry.default || __entry);';
    let obj;
    try { obj = (new Function(code))(); } catch (e) { throw new Error('脚本语法错误: ' + e.message) }
    if (!noValidate && (!obj || typeof obj.parse !== 'function')) throw new Error('入口文件缺少 parse(url, html)');
    return obj;
  },

  configFromSource(src, files, entry) {
    try {
      if (files) {
        if (files['config.json']) {
          let j;
          try { j = JSON.parse(files['config.json']); } catch (e) { j = null; }
          if (Array.isArray(j)) return { ok: true, config: j };
          if (j && Array.isArray(j.config)) return { ok: true, config: j.config };
        }
        if (files['config.js'] || files['config.mjs']) {
          const nm = files['config.js'] ? 'config.js' : 'config.mjs';
          const m = this.compileBundle(files, nm, true);
          const c = (m && (m.config || m.CONFIG)) || [];
          if (Array.isArray(c) && c.length) return { ok: true, config: c };
        }
      }
      let mod;
      if (files && Object.keys(files).length > 1) mod = this.compileBundle(files, entry);
      else mod = this.compile(src);
      return { ok: true, config: (mod && mod.config) || [] };
    } catch (e) { return { ok: false, err: e.message }; }
  },

  get(id) {
    if (this._mods[id]) return this._mods[id];
    const site = DB.site(id);
    let mod;
    if (site && site.type === 'rule') {
      mod = this.ruleModule(site);
    } else {
      if (site && site.files && Object.keys(site.files).length > 1) {
        mod = this.compileBundle(site.files, site.entry);
      } else {
        const src = this.source(id);
        if (!src) throw new Error('脚本不存在: ' + id);
        mod = this.compile(src, id);
      }
    }
    this._mods[id] = mod;
    return mod;
  },
  invalidate(id) { delete this._mods[id] },

  /* 硬解规则（docs/02 §1.5.1）：用 DOMParser + CSS 选择器执行，无需 Java/Jsoup */
  ruleModule(site) {
    let rule = site.rule;
    if (!rule) {
      try { rule = JSON.parse(site.script || '{}') } catch (e) { rule = null }
    }
    if (!rule || (!rule.list && !rule.detail)) throw new Error('规则为空或格式不对');
    const self = this;
    return {
      __id: site.id, __rule: rule, name: rule.name || site.name, site: rule.site || site.site,
      home() { return (rule.site || site.site || '').replace(/\/+$/, '') + (rule.home || '') },
      search(kw) {
        const tpl = (rule.search && rule.search.template) || ((rule.site || site.site) + '/search?q=**');
        return tpl.replace(/\*\*/g, encodeURIComponent(kw));
      },
      parse(url, html) { return self.ruleParse(rule, url, html) }
    };
  },

  ruleParse(rule, url, html) {
    const base = (rule.site || (String(url).match(/^https?:\/\/[^\/]+/) || [''])[0]).replace(/\/+$/, '');
    const abs = u => {
      if (!u) return '';
      if (/^https?:\/\//.test(u)) return u;
      if (u.startsWith('//')) return 'https:' + u;
      if (u.startsWith('/')) return base + u;
      return base + '/' + u;
    };
    let doc;
    try { doc = new DOMParser().parseFromString(String(html || ''), 'text/html') } catch (e) { doc = null }
    if (!doc) throw new Error('HTML 解析失败');

    const selAttr = (v, dflt) => {
      const s = String(v || '');
      const i = s.indexOf('&&');
      return i < 0 ? [s, dflt] : [s.slice(0, i), s.slice(i + 2)];
    };
    const pick = (root, v, dflt, isUrl) => {
      const [sel, attr] = selAttr(v, dflt);
      if (!sel) return '';
      let node = null;
      try { node = root.querySelector(sel) } catch (e) { return '' }
      if (!node && root.matches) { try { if (root.matches(sel)) node = root } catch (e) { } }
      if (!node) return '';
      if (attr === 'Text' || attr === 'text' || attr === '') return (node.textContent || '').replace(/\s+/g, ' ').trim();
      let val = node.getAttribute(attr) || '';
      /* meta 等标签用 content；src 取不到时也退化到 content */
      if (!val && node.getAttribute) val = node.getAttribute('content') || '';
      return isUrl ? abs(val) : String(val).trim();
    };
    const meta = name => {
      const n = doc.querySelector('meta[property="' + name + '"],meta[name="' + name + '"]');
      return n ? (n.getAttribute('content') || '') : '';
    };

    const norm = u => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    const homeUrl = norm(((rule.site || base).replace(/\/+$/, '')) + (rule.home || ''));
    const isHome = norm(url) === homeUrl || norm(url) === norm(base);

    /* 详情优先：playRe 命中且不是站点首页时才视为详情页 */
    const det = rule.detail || {};
    let play = '';
    if (det.playRe) {
      try {
        const m = new RegExp(det.playRe, 'i').exec(String(html || ''));
        if (m) {
          play = m[1] || m[0];
          try { play = decodeURIComponent(play) } catch (e) { }
        }
      } catch (e) { }
    }
    if (play && det.playFrom !== 'js' && !isHome) {
      let title = pick(doc, det.title, 'Text') || meta('og:title') || (doc.title || '');
      let pic = pick(doc, det.pic, 'src', true) || meta('og:image');
      return {
        type: 'detail', detail: {
          title: String(title).replace(/\s*[-–—|].*$/, '').trim(), pic: pic,
          desc: meta('description'), play: abs(play), kind: 'video', episodes: [], tags: []
        }
      };
    }

    /* 列表 */
    const list = rule.list || {};
    const items = [];
    if (list.item) {
      const scope = list.container ? (doc.querySelector(list.container) || doc) : doc;
      let nodes = [];
      try { nodes = Array.from(scope.querySelectorAll(list.item)) } catch (e) { nodes = [] }
      nodes.forEach(n => {
        const title = pick(n, list.title, 'Text');
        const href = pick(n, list.url, 'href', true);
        if (!title || !href) return;
        items.push({ title, pic: pick(n, list.pic, 'src', true), desc: pick(n, list.desc, 'Text'), url: href });
      });
    }
    if (!items.length) throw new Error('规则没匹配到任何条目（检查容器/条目选择器）');

    if (isHome) {
      return { type: 'home', heroes: [], cats: [], sections: [{ title: rule.name || '推荐', cards: items, more: '' }] };
    }
    let title = '';
    try { title = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '') } catch (e) { }
    return { type: 'list', title: title || (rule.name || '列表'), cards: items };
  },

  /* 脚本清单（P-04）：DB 站点 + 内置（未落库时） */
  list() {
    const db = DB.sites();
    const seen = new Set(db.map(s => s.id));
    const out = db.map(s => ({ id: s.id, name: s.name, type: s.type || 'js', site: s.site, icon: s.icon, enabled: s.enabled !== false, lines: (s.script || this.builtin[s.id] || '').split('\n').length }));
    for (const id in this.builtin) if (!seen.has(id)) out.push({ id, name: id, type: 'js', builtin: true, enabled: false, lines: this.builtin[id].split('\n').length });
    return out;
  },

  /* 统一执行入口（对齐 docs/02 §2 dispatch）
     opts: {html, site}  →  {ok, data} | {ok:false, error, trace}
     py 站点：优先走 Java 的 Native.pyDispatch（APK 内置 Chaquopy 时才有），否则退回 JS 脚本 */
  async run(id, url, opts = {}) {
    const t0 = Date.now();
    const site = DB.site(id);
    if (site && site.type === 'py') {
      /* Python 站点：源码在 DB（用户在 P-05 编辑）→ 落到 filesDir/py/<id>.py → Native.pyDispatch */
      if (!window.Py || !window.Py.available()) {
        return { ok: false, error: 'Python 运行时未内置（请安装 with-python 包，或用 build.ps1 -WithPython 出包）', trace: '', ms: Date.now() - t0, py: true };
      }
      try {
        if (site.script) {
          const w = await window.Py.put(id, site.script);
          if (!w.ok) throw new Error('脚本落盘失败：' + (w.err || ''));
        }
        let html = opts.html;
        let finalUrl = url;
        if (html == null) {
          const r = await Net.request('GET', url, { site: opts.site || id, headers: Net.headersFor(opts.site || id) });
          html = r.txt; finalUrl = r.url || url;
          Log.info('GET ' + url.slice(0, 90) + ' → ' + r.status + ' ' + (html || '').length + 'B ' + (Date.now() - t0) + 'ms');
        }
        try { window.Py.info(true); } catch (e) { }
        if (site && site.files && window.Py.putFiles) {
          try { await window.Py.putFiles(id, site.files, site.entry); } catch (e) { }
        }
        try { await window.Py.setConfig(id, (site && site.config) || {}); } catch (e) { }
        const res = await window.Py.dispatch(id, finalUrl, html || '');
        if (!res.ok) throw new Error(res.err || 'Python 执行失败');
        return { ok: true, data: res.data, ms: Date.now() - t0, py: true };
      } catch (e) {
        Log.err('Python 解析失败 ' + id + ': ' + e.message);
        return { ok: false, error: e.message, trace: '', ms: Date.now() - t0, py: true };
      }
    }
    try {
      const mod = this.get(id);
      let html = opts.html;
      let finalUrl = url;
      if (html == null) {
        const r = await Net.request('GET', url, { site: opts.site || id, headers: Net.headersFor(opts.site || id) });
        html = r.txt; finalUrl = r.url || url;
        Log.info('GET ' + url.slice(0, 90) + ' → ' + r.status + ' ' + (html || '').length + 'B ' + (Date.now() - t0) + 'ms');
      }
      window.CFG = (site && site.config) || {};
      const data = await mod.parse(finalUrl, html, window.CFG);
      return { ok: true, data, ms: Date.now() - t0, mod };
    } catch (e) {
      Log.err('解析失败 ' + (id || '') + ': ' + e.message);
      return { ok: false, error: e.message, trace: (e && e.stack) || '', ms: Date.now() - t0 };
    }
  },

  config(id) {
    const site = DB.site(id);
    if (site && site.type === 'py' && window.Py) return window.Py.config(id);
    try { const m = this.get(id); return { ok: true, config: m.config || [] }; }
    catch (e) { return { ok: false, err: e.message }; }
  },

  homeUrl(id) {
    try { const m = this.get(id); return m.home ? m.home() : (m.site || '') } catch (e) { return '' }
  },
  searchUrl(id, kw) {
    try {
      const m = this.get(id);
      if (m.search) return m.search(kw);
      return (m.site || '') + '/search?q=' + encodeURIComponent(kw);
    } catch (e) { return '' }
  },

  /* 新建脚本模板（P-19） */
  template(type) {
    if (type === 'rule') return RULE_TEMPLATE;
    if (type === 'py') return PY_TEMPLATE;
    return JS_TEMPLATE;
  }
};

const JS_TEMPLATE = `/* 新建脚本模板 · JavaScript
   契约：export default { name, site, home(), parse(url, html) }
   parse 返回：{type:'home',heroes,cats,sections} | {type:'list',title,cards} | {type:'detail',detail} */
const SITE = 'https://example.com';

function T(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim() }
function abs(u, base) { if (!u) return ''; if (/^https?:/.test(u)) return u; if (u.startsWith('//')) return 'https:' + u; return base + (u[0] === '/' ? u : '/' + u) }

export default {
  name: '新站点',
  site: SITE,

  home() { return SITE + '/' },

  parse(url, html) {
    const base = (url.match(/^https?:\\/\\/[^\\/]+/) || [SITE])[0];
    // 详情页
    if (/\\/v\\/|\\/video\\//.test(url)) {
      const t = (html.match(/<h1[^>]*>([\\s\\S]*?)<\\/h1>/) || [])[1];
      const og = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
      return { type: 'detail', detail: { title: T(t), pic: og || '', desc: '', play: '' } };
    }
    // 列表页
    if (/[?&](page|p)=|\\/list\\//.test(url)) {
      const cards = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\\s\\S]{0,500}?)<\\/a>/g)].slice(0, 20)
        .map(m => ({ title: T(m[2]), pic: '', url: abs(m[1], base) }));
      return { type: 'list', title: '列表', cards };
    }
    // 首页
    return { type: 'home', heroes: [], cats: [], sections: [] };
  }
}`;

const PY_TEMPLATE = `# 新建脚本模板 · Python（内置 CPython，可执行）
NAME = '新站点'
SITE = 'https://example.com'

def home():
    return SITE + '/'

def parse(url, html):
    return {'type': 'home', 'heroes': [], 'cats': [], 'sections': []}`;

const RULE_TEMPLATE = `{
  "name": "新站点",
  "id": "new_site",
  "site": "https://example.com",
  "list": { "container": "", "item": "", "title": "", "pic": "", "url": "" },
  "detail": { "title": "", "pic": "", "playRe": "", "playFrom": "html" },
  "search": { "template": "https://example.com/search?q=**" },
  "page": { "param": "page", "start": 1 }
}`;
