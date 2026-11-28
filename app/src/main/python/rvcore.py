#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rvcore.py — 解析内核库（纯 Python，无 App 依赖）
可用于 App 内（Chaquopy）或桌面对照测试。
"""
import re, base64, zlib, struct, urllib.request, json

SITE = 'https://example.com'
UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
REF = SITE + '/'

def http_get(url, timeout=30, referer=None):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': referer or REF,
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=timeout) as f:
        return f.read()

def unfix(s):
    if isinstance(s, bytes):
        s = s.decode('utf-8', 'replace')
    return s

def rv_text(s):
    if not s: return ''
    s = re.sub(r'<script[\s\S]*?</script>', ' ', s, flags=re.I)
    s = re.sub(r'<style[\s\S]*?</style>', ' ', s, flags=re.I)
    s = re.sub(r'<!--[\s\S]*?-->', ' ', s)
    s = re.sub(r'<[^>]+>', ' ', s)
    for a, b in [('&amp;','&'),('&lt;','<'),('&gt;','>'),('&quot;','"'),('&#x27;',"'"),('&#39;',"'"),('&nbsp;',' ')]:
        s = s.replace(a, b)
    return re.sub(r'\s+', ' ', s).strip()

def rv_abs(u, base=SITE):
    if not u: return ''
    if u.startswith('http://') or u.startswith('https://'): return u
    if u.startswith('//'): return 'https:' + u
    if u.startswith('/'): return base + u
    return base + '/' + u

def _id_of(url):
    m = re.search(r'/([vs]|hls)/([0-9a-zA-Z]{10,48})', url or '')
    return m.group(2) if m else ''

def rv_cards(html):
    out, seen = [], set()
    for m in re.finditer(r'<a[^>]+href="(/v/[0-9a-zA-Z_-]{10,48})"[^>]*>([\s\S]{0,4000}?)</a>', html):
        href, inner = m.group(1), m.group(2)
        key = _id_of(href) or href
        if key in seen: continue
        t = re.search(r'<h3[^>]*>([\s\S]*?)</h3>', inner)
        title = rv_text(t.group(1)) if t else ''
        if not title:
            alt = re.search(r'<img[^>]+alt="([^"]*)"', inner)
            title = rv_text(alt.group(1)) if alt else ''
        if not title: continue
        im = re.search(r'<img[^>]+src="([^"]+)"', inner)
        dur = ''
        du = re.search(r'>\s*((?:\d+\s*小時)?\s*\d+\s*分\d*\s*秒?|\d+\s*分)\s*<', inner)
        if du: dur = rv_text(du.group(1))
        src = ''
        sc = re.search(r'<span class="truncate[^"]*">([^<]+)</span>', inner)
        if sc: src = rv_text(sc.group(1))
        desc = ' · '.join([x for x in (dur, src) if x])
        seen.add(key)
        out.append({'title': title, 'pic': rv_abs(im.group(1)) if im else '', 'desc': desc,
                    'url': SITE + href, 'id': key})
    return out

def rv_series(html):
    out, seen = [], set()
    for m in re.finditer(r'<a[^>]+href="(/s/[0-9a-zA-Z_-]{10,48})"[^>]*>([\s\S]{0,3000}?)</a>', html):
        href, inner = m.group(1), m.group(2)
        key = _id_of(href) or href
        if key in seen: continue
        t = re.search(r'<h3[^>]*>([\s\S]*?)</h3>', inner)
        title = rv_text(t.group(1)) if t else ''
        if not title: continue
        im = re.search(r'<img[^>]+src="([^"]+)"', inner)
        seen.add(key)
        out.append({'title': title, 'pic': rv_abs(im.group(1)) if im else '', 'url': SITE + href, 'id': key})
    return out

def rv_tags(html):
    out, seen = [], set()
    for m in re.finditer(r'<a[^>]+href="(/t/[^"?#]+)"[^>]*>([\s\S]{0,3000}?)</a>', html):
        href, inner = m.group(1), m.group(2)
        if href in seen: continue
        raw = rv_text(inner)
        if not raw: continue
        h = re.search(r'<h[23][^>]*>([\s\S]{0,80}?)</h[23]>', inner)
        title = rv_text(h.group(1)) if h else raw
        num = 0
        nm = re.search(r'([\d,\.]+\s*[萬万]?)\s*部影片', raw)
        if nm:
            v = nm.group(1).replace(',', '').replace('，', '').replace(' ', '')
            num = float(v.replace('萬','').replace('万','')) * (10000 if ('萬' in nm.group(1) or '万' in nm.group(1)) else 1)
        m2 = re.match(r'^([\s\S]*?)\s*([\d,]{1,9}(?:\.\d+)?\s*[萬万]?)$', title)
        if m2 and m2.group(1).strip():
            title = m2.group(1).strip()
        if not title or len(title) > 24:
            continue
        seen.add(href)
        out.append({'title': title, 'url': SITE + href, 'num': int(num), 'slug': href})
    return out

def rv_picid(pic):
    """封面 URL → 内容 id/link"""
    try:
        tail = pic.split('/')[-1].split('.')[0]
        b = tail.replace('-', '+').replace('_', '/')
        b += '=' * (-len(b) % 4)
        path = base64.b64decode(b).decode('utf-8', 'replace')
        m = re.search(r'/(series|hls)/([0-9a-z]+)/', path)
        if not m: return None
        kind, cid = m.group(1), m.group(2)
        return {'id': cid, 'url': SITE + ('/s/' if kind == 'series' else '/v/') + cid}
    except Exception:
        return None

def rv_hero(html):
    m = re.search(r'<section[^>]*class="[^"]*min-h-\[350px\][^"]*"[^>]*>([\s\S]{0,8000}?)</section>', html)
    seg = m.group(1) if m else ''
    if not seg:
        at = html.find('art-title')
        if at < 0: return None
        seg = html[max(0, at-1500):at+3500]
    t = re.search(r'<h2[^>]*>([\s\S]{0,160}?)</h2>', seg)
    title = rv_text(t.group(1)) if t else ''
    if not title: return None
    v = re.search(r'href="(/v/[0-9a-zA-Z_-]{10,48})"', seg)
    if not v: return None
    im = re.search(r'<img[^>]+src="([^"]+)"', seg)
    metaM = re.search(r'<div class="flex items-center gap-2[^"]*"[^>]*>([\s\S]{0,500}?)</div>', seg)
    meta = rv_text(metaM.group(1)) if metaM else ''
    pM = re.search(r'<p[^>]*class="[^"]*clamp-2[^"]*"[^>]*>([\s\S]{0,400}?)</p>', seg)
    intro = rv_text(pM.group(1)) if pM else ''
    desc = (meta + '　' + intro) if (meta and intro) else (meta or intro)
    sm = re.search(r'href="(/s/[0-9a-zA-Z_-]{10,48})"', seg)
    return {'title': title, 'pic': rv_abs(im.group(1)) if im else '', 'desc': desc,
            'url': SITE + v.group(1), 'series': (SITE + sm.group(1)) if sm else ''}

def rv_heroes(html):
    m = re.search(r'<section[^>]*class="[^"]*min-h-\[350px\][^"]*"[^>]*>([\s\S]{0,8000}?)</section>', html)
    out, seen = [], set()
    if not m: 
        h = rv_hero(html)
        return [h] if h else []
    seg = m.group(1)
    first = rv_hero(html)
    if first and first.get('title'):
        out.append(first); seen.add(first['url'])
    for mm in re.finditer(r'<img[^>]+src="(https://v\.rn252[^"]+)"', seg):
        pic = mm.group(1)
        info = rv_picid(pic)
        if not info or info['url'] in seen: continue
        seen.add(info['url'])
        out.append({'title': '', 'pic': pic, 'desc': '', 'url': info['url'], 'series': ''})
    for h in out:
        if not h['title']:
            h['title'] = '短剧推荐' if '/s/' in h['url'] else '视频推荐'
    return out

def rv_sections(html):
    marks = [(m.start(), rv_text(m.group(1))) for m in re.finditer(r'<h2[^>]*>([\s\S]{0,120}?)</h2>', html)]
    res, seen = [], set()
    cut = []
    for i, (pos, title) in enumerate(marks):
        end = marks[i+1][0] if i+1 < len(marks) else len(html)
        if end - pos < 200: continue
        seg = html[pos:end]
        cards = rv_cards(seg)
        if not cards: continue
        more = re.search(r'<a[^>]+href="(/t/[^"]+)"[^>]*>[\s\S]{0,40}?更多', seg) or re.search(r'更多[\s\S]{0,40}?<a[^>]+href="(/t/[^"]+)"', seg)
        cut.append({'title': title or ('分区%d' % (i+1)), 'cards': cards,
                    'more': (SITE + more.group(1)) if more else ''})
    if marks:
        head = rv_cards(html[:marks[0][0]])
        if head: cut.insert(0, {'title': '推荐', 'cards': head, 'more': ''})
    for c in cut:
        keep = [x for x in c['cards'] if x['id'] not in seen]
        for x in keep: seen.add(x['id'])
        if keep:
            c['cards'] = keep
            res.append(c)
    return res

def rv_decode_ev(html):
    m = re.search(r'\{d:"([A-Za-z0-9+/=]{16,})",k:(\d+)\}', html)
    if m:
        d, k = m.group(1), int(m.group(2))
    else:
        m = re.search(r'k:(\d+),d:"([A-Za-z0-9+/=]{16,})"', html)
        if not m: return None
        k, d = int(m.group(1)), m.group(2)
    try:
        raw = base64.b64decode(d)
        s = ''.join(chr((b - k) & 0xFF) for b in raw)
        return json.loads(s)
    except Exception:
        return None

def rv_detail(html):
    r = {'title': '', 'pic': '', 'desc': '', 'play': '', 'eps': [], 'tags': []}
    t = re.search(r'<h1[^>]*>([\s\S]*?)</h1>', html)
    if t: r['title'] = rv_text(t.group(1))
    if not r['title']:
        ogt = re.search(r'<meta property="og:title" content="([^"]*)"', html)
        if ogt: r['title'] = rv_text(ogt.group(1))
    og = re.search(r'<meta property="og:image" content="([^"]+)"', html)
    if og: r['pic'] = rv_abs(og.group(1))
    de = re.search(r'<meta name="description" content="([^"]*)"', html)
    if de: r['desc'] = rv_text(de.group(1))
    ev = rv_decode_ev(html)
    if ev:
        if ev.get('videoUrl'): r['play'] = rv_abs(ev['videoUrl'])
    me = (re.search(r'/v/([0-9a-z]{15,40})', html) or [None, ''])[1] if re.search(r'/v/([0-9a-z]{15,40})', html) else ''
    seen = set()
    for m in re.finditer(r'<a[^>]+href="(/v/([0-9a-zA-Z_-]{10,48}))"[^>]*>([\s\S]{0,800}?)</a>', html):
        cid, inner = m.group(2), m.group(3)
        if cid == me or cid in seen: continue
        tt = rv_text(inner)
        if not tt or len(tt) > 20: continue
        if re.search(r'分\d*秒|小時|小时|次觀看|次观看|萬|万次|更多|查看全部', tt): continue
        seen.add(cid)
        r['eps'].append({'title': tt, 'url': SITE + m.group(1)})
    r['tags'] = rv_tags(html)[:20]
    return r

# ---- PNG 解包 ----
def ro_ud(data):
    if data[:4] != b'\x89PNG': return None
    i, n = 8, len(data)
    while i + 12 <= n:
        ln = struct.unpack('>I', data[i:i+4])[0]
        typ = data[i+4:i+8]
        if typ == b'roUd': return data[i+8:i+8+ln]
        if typ == b'IEND': break
        i += 12 + ln
    return None

def unwrap(data):
    ro = ro_ud(data)
    if not ro or len(ro) < 2: return None
    flag, body = ro[0], ro[1:]
    if flag == 1:
        try: return zlib.decompress(body)
        except Exception: return None
    return body
