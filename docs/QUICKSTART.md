# 快速上手

## 1. 安装

手机使用：

```text
releases/JieXi-<version>-arm64.apk
```

模拟器或 x86_64 设备：

```text
releases/JieXi-<version>-x86_64.apk
```

没有 Python 运行时的轻量包：

```text
releases/JieXi-<version>-lean.apk
```

安装时允许“安装未知应用”。

## 2. 第一次打开

- 首次启动会带一个中性示例站点；
- 主页顶部可切换站点；
- 底部四个 Tab：主页、浏览、收藏、个人中心；
- 所有设置从主页右上角进入，或从“首页 → 设置”进入。

## 3. 添加一个站点

1. 打开“脚本”页；
2. 新建站点；
3. 选择类型：
   - **规则**：用 CSS 选择器抓取，最直观；
   - **JS**：`parse(url, html)` 返回页面数据；
   - **Python**：内置 CPython，`parse(url, html)` 返回页面数据；
4. 填写站点名、地址；
5. 保存；
6. 回到主页，在站点选择器里选择它。

## 4. 最小 JS 脚本

```js
export default {
  name: '示例站点',
  site: 'https://example.com',
  home() { return this.site + '/'; },
  search(kw) { return this.site + '/search?q=' + encodeURIComponent(kw); },
  parse(url, html) {
    return { type: 'home', heroes: [], cats: [], sections: [] };
  }
};
```

入口必须有 `parse`。

## 5. 最小规则

```json
{
  "name": "示例站点",
  "site": "https://example.com",
  "list": { "url": "/", "item": "a", "title": "a", "link": "a" }
}
```

在规则编辑器的表单模式里逐项填写即可。

## 6. 最小 Python 脚本

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

## 7. 测试

脚本编辑器右上角有测试入口：

1. 填一个 URL；
2. 运行；
3. 查看返回类型、卡片数量、错误堆栈；
4. 通过后回到主页刷新。

## 8. 终端

底部“主页 → 设置 → 终端”或主页功能卡进入。

```sh
ls
cd files
python
```

Python 模式顶部切换，或 `F6`。

## 9. 模块

“设置 → Python → 模块管理”或主页“模块”卡：

1. 顶部搜索模块；
2. 点安装；
3. 纯 Python 模块安装后自动加载到当前会话；
4. “已安装”里分“直接安装 / 依赖”，并标来源；
5. 需要预编译但没有适配轮子的模块会被拒绝安装，不会硬下。

## 10. 更新

- 设置 → 关于 → 检查更新；
- 发现新版本后“下载并安装”；
- 安装未知应用权限需要允许；
- 也可以手动安装 `releases/` 里的 APK。

## 11. 文档

设置 → 关于 → **文档中心**。

文档在线读取；失败时会提示：

```text
请到 QQ 群 123456789 获取文档或反馈
```

## 12. 遇到问题

先看 [FAQ](FAQ.md) 和 [常见错误](FAQ.md#常见错误)，仍然不行再到 QQ 群反馈，附：

- 版本号；
- 脚本类型；
- 请求 URL；
- 错误文本；
- 日志页导出的内容。
