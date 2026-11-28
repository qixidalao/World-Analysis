"""示例解析脚本：example.com

只演示 parse 的返回结构；换成自己的站点时替换 SITE 和选择器。
"""
NAME = '示例站点'
SITE = 'https://example.com'

def home():
    return SITE + '/'

def search(kw):
    return SITE + '/search?q=' + str(kw)

def parse(url, html):
    return {'type': 'home', 'heroes': [], 'cats': [], 'sections': []}
