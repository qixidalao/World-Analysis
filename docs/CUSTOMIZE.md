# 主页与外观自定义

## 主页模块

主页右上角调色板 → 主页自定义：

- 欢迎语标题/正文
- 功能卡、站点、继续观看、公告开关
- 模块顺序上移/下移
- 轮播高度、卡片列数
- 背景图
- 自定义区块

## 自定义区块

只有一个输入框，三种写法：

### 直接写 HTML

```html
<h2>你好</h2>
<p>这是 HTML 区块</p>
```

标题请用 `<h1>/<h2>/<h3>`；`<h>` 会兼容成 `<h3>`。

### JS

第一行 `js:`，代码体 `return` 一个 HTML 字符串。

```js
js:
return `<h2>你好</h2><p>${ctx.home.welcomeText || ''}</p>`;
```

`ctx.cfg` 是完整配置，`ctx.home` 是主页配置。

### Python

第一行 `py:`，表达式结果作为 HTML。

```py
py:
"<h2>你好</h2><p>来自 Python</p>"
```

Python 需要当前 APK 内置解释器。已安装并加载的预编译模块可以在 Python 里 `import` 后用来生成 HTML；JS 只能使用 WebView 里的 JS 库，不能直接 import Python 模块。

## 输入框按钮

- 左上：**编辑器**，打开统一全屏代码编辑器
- 右上：**CSS**，编辑当前区块 CSS
- 按钮在输入框内顶部工具栏，不遮挡文字

编辑器保存只回浮层；不会触发单选框。

## 保存区块脚本

输入框下方三个单选框：

```text
○ 主页   ○ 设置页   ○ 当前页
```

只作用于 **保存区块脚本** 按钮。

## 区块 CSS

- 只作用于当前区块
- 自动加 `#home-custom-block` 前缀
- `:root/html/body` 不处理

```css
h2 { color: var(--accent); }
.box { padding: 8px; }
```

## 全局 CSS

外观 → 自定义 CSS：

```css
:root {
  --accent: #3BA7FF;
  --hero-h: 220px;
  --font-scale: 1.05;
}
```

常用变量：

- `--accent`
- `--hero-h`
- `--font-scale`
- `--r-s / --r-m / --r-l`

## 语法配色

外观 → 语法配色：

- 预设色 + 自定义颜色
- 关键字/类型/字符串/数字/注释/函数/常量/内置/标点
- 所有语言通用
