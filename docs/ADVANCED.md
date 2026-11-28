# 高级用法

## 1. 多文件脚本

JS 站点支持多文件：

```text
index.js
parse.js
config.js
```

相对导入：

```js
import { cards } from './parse.js';
```

也支持动态导入和 CommonJS 形式：

```js
const m = await import('./parse.js');
const legacy = require('./legacy.js');
```

限制：

- 只支持相对路径；
- 不支持 npm / 动态 URL import；
- 不支持 Node.js 内置模块。

## 2. 站点参数

`config.js`：

```js
export const CONFIG = [
  { key: 'cookie', label: 'Cookie', type: 'string', default: '' },
  { key: 'quality', label: '清晰度', type: 'select', options: ['720', '1080'] }
];
```

Python `CONFIG` 同结构。

运行时：

```js
CFG.cookie
```

Python：

```python
CFG['cookie']
```

## 3. 请求头与网络

站点可配置：

- UA
- Referer
- Cookie
- 自定义 headers
- 网络模式：直连 / DoH / 代理
- 代理地址

代理按站点生效；代理认证字段当前仅记录，主网络层不透传用户名/密码。

## 4. 解析缓存

- 主页/列表/详情使用 `browseCache` 分钟数；
- 0 关闭；
- 上限 1440 分钟；
- 强制刷新会绕过；
- HLS 分片缓存独立，按 `play.cache` MB 做 LRU。

## 5. 自定义主页区块

设置 → 主页布局：

- 单输入框
- 直接写 HTML
- `js:` 开头执行 JS，`return` HTML
- `py:` 开头执行 Python，返回字符串
- 右上角“编辑器”打开全屏代码编辑器
- 右下角“CSS”只作用于当前区块

示例：

```js
js:
return `<h2>你好</h2><p>${ctx.home.welcomeText || ''}</p>`;
```

Python：

```py:
"<h2>你好</h2>"
```

CSS：

```css
h2 { color: var(--accent); }
```

## 6. 自定义语法

设置 → 外观 → 自定义语法：

- 名称
- 扩展名
- 关键字
- 类型
- 常量
- 函数
- 行注释/块注释

语法高亮只影响编辑器着色，不参与执行。

## 7. 语法配色

设置 → 外观 → 语法配色：

- 关键字、类型、字符串、数字、注释、函数、常量、内置、标点
- 预设色 + 自定义颜色
- 所有语言共用一套颜色

## 8. 扩展包

扩展包是 manifest + code：

- `addSyntax`：语法高亮
- `addComponent`：详情组件
- `addParserTemplate`：规则模板
- `addTheme`：主题
- `addPage`：页面
- `addLayout`：首页布局块

同 id 更高版本会升级；卸载会清理贡献点。

## 9. 热修复

- 只更新 Web 层 CSS/JS；
- RSA-SHA256 签名；
- 无签名/验签失败拒绝；
- 支持 `rollout` 灰度；
- 应用后校验版本标记，失败回滚上一版；
- 冷启动也会检查；
- 不能改 native/Python。

## 10. 应用内更新

- 关于 → 检查更新；
- 云端 `version.json` 包含版本号、下载地址、说明；
- 下载后交给系统安装器；
- 需要“安装未知应用”权限。

## 11. 日志与诊断

- 错误会写入日志；
- 支持多选复制；
- 脚本测试页有错误堆栈；
- 复杂问题附版本、站点、URL、日志。

## 12. 风险边界

- 扩展包不是强沙箱；
- JS 与 App 同上下文；
- Python 预编译模块是原生代码；
- 只安装可信来源。
