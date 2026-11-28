# fake_pypi.py — 离线假 PyPI（给运行时 pip 做验收）
#
# 提供两个纯 Python 包：
#   demo-pkg 1.0.0（依赖 dep-pkg）
#   dep-pkg  2.0.0
# 接口与 PyPI JSON API 对齐：
#   GET /pypi/<name>/json           最新版
#   GET /pypi/<name>/<ver>/json     指定版
#   GET /files/<wheel 文件名>        wheel 本体
#
# 用法：
#   python scripts/fake_pypi.py --port 8001
#   adb reverse tcp:8001 tcp:8001
# 然后在界析终端：
#   pip index http://127.0.0.1:8001/pypi/
#   pip install demo-pkg
#   python -c "import demo_pkg, dep_pkg; print(demo_pkg.VERSION, dep_pkg.VERSION)"
#   pip list
#   pip uninstall demo-pkg
import argparse
import hashlib
import io
import json
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PKGS = {
    'demo-pkg': {
        'version': '1.0.0',
        'requires': ['dep-pkg'],
        'module': 'demo_pkg',
        'body': 'VERSION = "1.0.0"\n\ndef hello():\n    return "hello from demo_pkg"\n',
    },
    'dep-pkg': {
        'version': '2.0.0',
        'requires': [],
        'module': 'dep_pkg',
        'body': 'VERSION = "2.0.0"\n',
    },
    'demo-native': {
        'version': '1.0.0',
        'requires': [],
        'module': 'demo_native',
        'body': 'VERSION = "1.0.0"\n',
        'wheelfile': 'demo_native-1.0.0-cp311-cp311-android_24_x86_64.whl',
    },
}

WHEELS = {}


def build_wheel(name, meta):
    ver = meta['version']
    mod = meta['module']
    dist = mod + '-' + ver + '.dist-info'
    files = {
        mod + '/__init__.py': meta['body'],
        dist + '/METADATA': (
            'Metadata-Version: 2.1\nName: %s\nVersion: %s\n' % (name, ver)
            + ''.join('Requires-Dist: %s\n' % r for r in meta['requires'])
        ),
        dist + '/WHEEL': 'Wheel-Version: 1.0\nGenerator: fake_pypi\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
        dist + '/RECORD': '',
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for path, text in files.items():
            z.writestr(path, text)
    data = buf.getvalue()
    fn = meta.get('wheelfile') or (mod + '-' + ver + '-py3-none-any.whl')
    WHEELS[fn] = data
    return fn, data


for _name, _meta in PKGS.items():
    build_wheel(_name, _meta)


def meta_json(name, ver=None):
    meta = PKGS[name]
    ver = ver or meta['version']
    fn = meta['module'] + '-' + ver + '-py3-none-any.whl'
    if meta.get('wheelfile'):
        fn = meta['wheelfile']
    data = WHEELS[fn]
    return {
        'info': {
            'name': name,
            'version': ver,
            'requires_dist': meta['requires'],
        },
        'urls': [{
            'filename': fn,
            'url': '/files/' + fn,
            'size': len(data),
            'digests': {'sha256': hashlib.sha256(data).hexdigest()},
        }],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = 'FakePyPI/1.0'

    def log_message(self, fmt, *args):
        print('[fake-pypi] ' + fmt % args)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        host = self.headers.get('Host', '127.0.0.1')
        if path.startswith('/pypi/'):
            parts = [p for p in path[len('/pypi/'):].split('/') if p]
            if len(parts) >= 1 and parts[-1] == 'json':
                parts = parts[:-1]
            if not parts:
                return self.send_json(404, {'error': 'no package'})
            raw = parts[0]
            # PyPI 名称不区分 - / _，这里同时支持
            name = raw.lower().replace('_', '-')
            if name not in PKGS:
                return self.send_json(404, {'error': 'package not found: ' + raw})
            ver = parts[1] if len(parts) > 1 else None
            obj = meta_json(name, ver)
            fn = obj['urls'][0]['filename']
            obj['urls'][0]['url'] = 'http://%s/files/%s' % (host, fn)
            return self.send_json(200, obj)
        if path.startswith('/files/'):
            fn = path[len('/files/'):]
            data = WHEELS.get(fn)
            if data is None:
                return self.send_json(404, {'error': 'wheel not found: ' + fn})
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == '/':
            return self.send_json(200, {'ok': True, 'packages': list(PKGS)})
        return self.send_json(404, {'error': 'not found'})

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8001)
    ap.add_argument('--host', default='127.0.0.1')
    a = ap.parse_args()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print('fake PyPI on http://%s:%d/pypi/  (wheels: %s)' % (a.host, a.port, ', '.join(WHEELS)))
    srv.serve_forever()


if __name__ == '__main__':
    main()
