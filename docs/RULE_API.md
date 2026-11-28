# 规则 API

规则是 CSS 选择器驱动的解析配置，不执行远程代码。

## 最小规则

```json
{
  "name": "示例站点",
  "site": "https://example.com",
  "list": {
    "url": "/",
    "item": "a",
    "title": "a",
    "link": "a"
  }
}
```

## 字段

| 字段 | 含义 |
|---|---|
| `name` | 站点名 |
| `site` | 站点根地址 |
| `home` | 首页地址，可省略 |
| `search` | 搜索地址模板，支持 `{kw}` |
| `list` | 列表规则 |
| `detail` | 详情规则 |

## 列表

```json
{
  "list": {
    "url": "/list",
    "item": ".card",
    "title": ".title",
    "pic": "img",
    "picAttr": "src",
    "link": "a",
    "linkAttr": "href",
    "desc": ".desc"
  }
}
```

- `item` 是每项容器；
- 其余字段在容器内部找；
- `*Attr` 取属性而不是文本；
- 相对地址会自动补齐。

## 详情

```json
{
  "detail": {
    "title": "h1",
    "pic": "meta[property=og:image]",
    "picAttr": "content",
    "desc": ".desc",
    "play": "video source",
    "playAttr": "src",
    "eps": ".playlist a",
    "epTitle": "a",
    "epLink": "a",
    "epLinkAttr": "href"
  }
}
```

## 分页

规则可声明分页参数：

```json
{
  "page": {
    "param": "page",
    "start": 1
  }
}
```

App 会自动构造 `?page=n` 或 `&page=n`。

## 频道

脚本可返回：

```js
{
  type: 'home',
  cats: [
    { title: '电影', url: 'https://example.com/movie' }
  ]
}
```

浏览页会显示频道横条。

站点级自定义频道：

```json
{
  "tabs": [
    { "title": "推荐", "url": "https://example.com/" },
    { "title": "分类", "url": "https://example.com/list" }
  ]
}
```

## 远程规则源

规则模板页支持订阅 JSON URL：

- 只读取 `templates` / `rules`；
- 只接受含 `rule.list` 的项；
- 缓存到本地；
- 不执行远程脚本；
- 支持签名源 `payload + sig`。

## 调试

- 规则编辑器有表单/源码切换；
- 测试抓取会显示 HTTP 状态、选择器命中数量；
- 选择器为空时先检查是否在 iframe/JS 渲染页面；规则模式不执行 JS。
