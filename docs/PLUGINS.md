# 扩展包

扩展包是一个 JSON 文件：

```json
{
  "manifest": {
    "id": "my.pack",
    "name": "我的扩展",
    "version": "1.0.0",
    "engines": { "jiexi": ">=1.8.0" },
    "permissions": [],
    "contributes": {
      "components": ["my-card"]
    }
  },
  "code": "api.addComponent('my-card', function (it) { return '<div class=\"card\">' + it.title + '</div>'; });"
}
```

## 字段

- `id`：小写字母开头，3–64 位，只能包含 `a-z0-9_.-`
- `version`：递增版本号；同 id 更高版本会触发升级
- `engines.jiexi`：最低 App 版本，例如 `>=1.8.0`
- `permissions`：声明用途，安装前会弹窗；**不是强沙箱**
- `contributes`：声明贡献点，可空对象
- `code`：在 WebView 同上下文执行，只安装可信来源

## 可用 API

### 自定义语法高亮

```js
api.addSyntax('mylang', {
  keywords: ['if', 'else', 'return'],
  types: ['int', 'str'],
  constants: ['true', 'false'],
  functions: ['print', 'len'],
  lineComment: '//',
  blockComment: ['/*', '*/']
});
```

安装后，编辑器打开 `.mylang` 或对应扩展名文件时使用该高亮。

### 组件

```js
api.addComponent('my-card', function (it) {
  return '<div class="card">' + it.title + '</div>';
});
```

`contributes.components` 声明 `my-card`。

### 规则模板

```js
api.addParserTemplate({
  name: '示例列表',
  desc: '演示模板',
  rule: {
    list: {
      url: 'https://example.com',
      item: 'a',
      title: 'a'
    }
  }
});
```

`contributes.parsers` 声明模板名。

### 主题

```js
api.addTheme('mytheme', {
  accent: '#3BA7FF',
  bg: '#08111E',
  bg2: '#111D30'
});
```

安装后在“设置 → 扩展包 → 主题”应用或恢复默认。

### 页面

```js
api.addPage('mypage', {
  title: '我的页面',
  render: function (body) {
    body.innerHTML = '<h2>Hello</h2><p>由扩展包注册</p>';
  }
});
```

安装后在“设置 → 扩展包 → 页面”打开。

### 首页布局块

```js
api.addLayout('myblock', {
  title: '我的布局块',
  render: function (el) {
    el.innerHTML = '<div class="st-note">首页自定义块</div>';
  }
});
```

首页会在模块顺序中显示该块。

## 安装

1. 把 JSON 保存成可访问的 `https://` 地址；
2. 打开 设置 → 扩展包；
3. 点“安装”，把 URL 填入并拉取；
4. 确认权限后安装。

升级：同 id、版本更高时，从 URL 拉取新 JSON 再安装，会先清理旧贡献点。

## 注意

当前扩展包不是强沙箱，代码与 App 同上下文执行，只安装你信任的来源。
