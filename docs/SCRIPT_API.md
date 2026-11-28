# 脚本 API

脚本类型：`js`、`py`、`rule`。

```text
Engine.run(siteId, url)
  → JS: mod.parse(url, html, CFG)
  → Py: engine.dispatch(siteId, url, html)
  → rule: ruleParse(rule, url, html)
```

失败返回 `{ ok:false, error, trace }`。

## 1. 返回结构

### 首页

```js
{
  type: 'home',
  heroes: [{ title, desc, pic, url }],
  cats: [{ title, url }],
  sections: [{
    title: '最新',
    more: 'https://example.com/more',
    cards: [{ title, pic, desc, url }]
  }]
}
```

### 列表

```js
{ type: 'list', title: '分类', cards: [{ title, pic, desc, url }] }
```

### 详情

```js
{
  type: 'detail',
  detail: {
    title, pic, desc,
    play: 'https://example.com/a.m3u8',
    eps: [{ title, url }],
    tags: ['标签'],
    blocks: []
  }
}
```

### 播放

```js
{ type: 'player', play: 'https://example.com/a.m3u8' }
```

## 2. JavaScript

```js
export default {
  name: '示例站点',
  site: 'https://example.com',
  home() { return this.site + '/'; },
  search(kw) { return this.site + '/search?q=' + encodeURIComponent(kw); },
  parse(url, html) { return { type: 'home', heroes: [], cats: [], sections: [] }; }
};
```

- 入口必须有 `parse`
- `this.site` / `this.name`
- `Net.request` / `Net.get` / `Net.bytes`
- 多文件：相对 import、动态 `import()`、CommonJS
- `config.js` 或 `CONFIG` 声明参数
- 运行时 `CFG`

## 3. Python

```python
NAME = '示例站点'
SITE = 'https://example.com'
CONFIG = []

def home():
    return SITE + '/'

def search(kw):
    return SITE + '/search?q=' + str(kw)

def parse(url, html):
    return {'type': 'home', 'heroes': [], 'cats': [], 'sections': []}
```

- 入口必须有 `parse(url, html)`
- `CONFIG` 自动生成表单
- 运行时 `CFG['key']`
- 详细见 [PYTHON_API.md](PYTHON_API.md)

## 4. 规则

```json
{
  "list": { "url": "/", "item": "a", "title": "a", "link": "a" }
}
```

详细见 [RULE_API.md](RULE_API.md)。

## 5. detail.blocks

```js
{ type: 'image', url: 'https://example.com/a.jpg', ratio: 1.6, radius: 12, caption: '封面' }
{ type: 'title', text: '标题', size: 'xl' }
{ type: 'text', text: '简介', muted: true, lines: 4 }
{ type: 'chips', items: ['标签1', '标签2'] }
{ type: 'button', text: '▶ 播放', style: 'pri', action: 'play' }
```

扩展包组件还会额外注册类型。

## 6. 组件包

```js
api.addComponent('my-card', function (it) {
  return '<div class="card">' + it.title + '</div>';
});
```

## 7. 错误

```js
throw new Error('页面结构变化');
```

测试页会显示堆栈和请求 URL。

## 8. 安全

脚本与 App 同上下文，能访问网络和页面数据。只运行自己信任的脚本。
