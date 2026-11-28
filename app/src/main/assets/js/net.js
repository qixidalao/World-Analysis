/* net.js — 网络层：优先走 Java 桥（OkHttp + DoH/代理/站点 headers），退化到浏览器 fetch
   桥契约（见 docs/dev-frontend-conventions.md §3）：
     window.Native.cfg(json)          设置 {mode,proxy,doh,ua,timeout}
     window.Native.req(id, method, url, headersJson)
     window.__netCb(id, json)         json={status,url,txt,b64,err,ms}
*/
const Net = {
  seq: 0,
  pending: new Map(),
  _cfg: { mode: 'direct', proxy: '', doh: 'https://223.5.5.5/resolve', ua: '', timeout: 20 },
  log: [],

  native() { return (window.Native && typeof window.Native.req === 'function') ? window.Native : null },

  config(patch) {
    Object.assign(this._cfg, patch || {});
    const n = this.native();
    if (n && n.cfg) { try { n.cfg(JSON.stringify(this._cfg)) } catch (e) { } }
    return this._cfg;
  },
  cfg() { return Object.assign({}, this._cfg) },

  /* 从站点配置合并 headers（站点 > 全局 > 默认） */
  headersFor(site) {
    const h = {};
    const c = DB.cfg();
    if (c.ua) h['User-Agent'] = c.ua;
    const s = site ? DB.site(site) : null;
    if (s) {
      if (s.ua) h['User-Agent'] = s.ua;
      if (s.referer) h['Referer'] = s.referer;
      if (s.cookie) h['Cookie'] = s.cookie;
      if (s.headers) Object.assign(h, s.headers);
    }
    return h;
  },

  /* 底层请求：返回 {status,url,txt,bytes,ms} */
  request(method, url, opt = {}) {
    const headers = Object.assign({}, opt.headers || {});
    const n = this.native();
    const t0 = Date.now();
    if (n) {
      return new Promise((resolve, reject) => {
        const id = 'r' + (++this.seq);
        this.pending.set(id, { resolve, reject, t0, url });
        try {
          var _s = opt.site ? DB.site(opt.site) : null;
          var _p = (_s && _s.net && _s.net.mode === 'proxy') ? String(_s.net.proxy || '') : '';
          if (_p && n.reqProxy) n.reqProxy(id, method, url, JSON.stringify(headers), _p);
          else n.req(id, method, url, JSON.stringify(headers));
        }
        catch (e) { this.pending.delete(id); reject(e) }
        setTimeout(() => {
          if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('请求超时 ' + url)) }
        }, (opt.timeout || this._cfg.timeout || 20) * 1000 + 2000);
      });
    }
    /* 退化：浏览器 fetch（桌面预览/无桥环境；无 DoH/代理能力） */
    return fetch(url, { method, headers, cache: 'no-store' }).then(async r => {
      const buf = await r.arrayBuffer();
      const out = {
        status: r.status, url: r.url || url, ms: Date.now() - t0,
        bytes: new Uint8Array(buf), txt: '', headers: {}
      };
      try { out.txt = new TextDecoder('utf-8').decode(buf) } catch (e) { }
      return out;
    });
  },

  /* Java 回调入口 */
  _cb(id, json) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    let d;
    try { d = typeof json === 'string' ? JSON.parse(json) : json } catch (e) { return p.reject(new Error('桥返回解析失败')) }
    if (d.err) return p.reject(new Error(d.err));
    const out = { status: d.status || 0, url: d.url || p.url, ms: d.ms != null ? d.ms : (Date.now() - p.t0), headers: d.headers || {} };
    if (d.b64) {
      out.bytes = this.b64bytes(d.b64);
      out.txt = '';
    } else {
      out.txt = d.txt != null ? d.txt : '';
      out.bytes = null;
    }
    if (d.status && d.status >= 400) {
      const e = new Error('HTTP ' + d.status + ' ' + (out.url || ''));
      e.status = d.status; e.body = out.txt; return p.reject(e);
    }
    p.resolve(out);
  },

  b64bytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  bytesb64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  },

  async get(url, opt = {}) {
    const r = await this.request('GET', url, Object.assign({ headers: this.headersFor(opt.site) }, opt));
    return r.txt != null ? r.txt : new TextDecoder('utf-8', { fatal: false }).decode(r.bytes || new Uint8Array());
  },
  async bytes(url, opt = {}) {
    const r = await this.request('GET', url, Object.assign({ headers: this.headersFor(opt.site), binary: true }, opt));
    return r.bytes || new TextEncoder().encode(r.txt || '');
  },

  /* ---------------- PNG roUd 解包（docs/04 §3） ---------------- */
  roUd(u8) {
    if (!u8 || u8.length < 16) return null;
    if (!(u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47)) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let i = 8;
    while (i + 12 <= u8.length) {
      const len = dv.getUint32(i);
      if (i + 8 + len > u8.length) break;
      const typ = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
      if (typ === 'roUd') return u8.subarray(i + 8, i + 8 + len);
      if (typ === 'IEND') break;
      i += 12 + len;
    }
    return null;
  },

  async inflate(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('不支持 DecompressionStream');
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  },

  /* 完整解包：PNG → {kind:'m3u8',text} | {kind:'ts',bytes} */
  async unwrap(u8) {
    const ro = this.roUd(u8);
    if (!ro || ro.length < 2) return null;
    const flag = ro[0], body = ro.subarray(1);
    let out;
    try {
      out = flag === 1 ? await this.inflate(body) : body;
    } catch (e) {
      throw new Error('PNG 解包失败（roUd flag=' + flag + '，zlib 数据损坏或不是压缩流）');
    }
    if (flag === 1 || (out.length > 7 && out[0] === 0x23 && out[1] === 0x45)) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(out);
      if (text.indexOf('#EXTM3U') >= 0) return { kind: 'm3u8', text, bytes: out };
    }
    return { kind: 'ts', bytes: out };
  },

  /* 抓播放源：可能是 m3u8 文本、PNG 封装、或 302 到 PNG */
  async playSource(url, opt = {}) {
    const u8 = await this.bytes(url, opt);
    const head = u8.length > 7 ? String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) : '';
    if (u8[0] === 0x89 && head.indexOf('PNG') >= 0) {
      const w = await this.unwrap(u8);
      if (!w) throw new Error('PNG 里没有 roUd');
      return w;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(u8);
    if (text.indexOf('#EXTM3U') >= 0) return { kind: 'm3u8', text, bytes: u8 };
    if (text.trim().startsWith('{')) return { kind: 'json', text, bytes: u8 };
    return { kind: 'bin', bytes: u8, text };
  }
};

window.__netCb = (id, json) => Net._cb(id, json);
