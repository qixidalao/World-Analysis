# 架构

## 分层

```text
Android Java
  MainActivity / WebView
  JsBridge / NetClient / TermBridge / HotFix / FileProvider?（未用）
       ↓
WebView SPA
  core.js        App / UI / Log / 路由
  data.js        DB / 配置
  net.js         原生请求桥
  engine.js      JS / 规则解析
  pages/*        页面
  packs          扩展包注册
       ↓
Python (可选)
  engine.py      脚本加载 / parse / 配置
  repl.py
  pipinst.py
```

## 路由

- `App.tabs`：home / browse / fav / mine
- `App.stacks`：每个 Tab 的页面栈
- `App.go(name, params)`：压栈
- `App.replace`：替换栈顶
- `App.back`：出栈
- `App.setTab`：切换 Tab

## 状态

- 当前站点：DB `lastSite` / `defaultSite`
- 启用站点：`sites[].enabled !== false`
- 主页缓存：`browseCache`
- 缓存失效：`App.invalidateHome`

## 网络

- 请求走 `JsBridge.req` → `NetClient`
- 全局模式：直连 / DoH / 代理
- 站点覆盖：UA / Referer / Cookie / headers / proxy
- 外链走系统浏览器，不导航 SPA

## 脚本

- JS：`new Function` 打包模块，支持相对 import/动态 import/CommonJS
- Python：Chaquopy CPython 3.14
- 规则：CSS 选择器
- 统一返回 `home/list/detail/player`

## 扩展包

- manifest 校验
- code 同上下文执行
- 贡献点：syntax/components/parsers/themes/pages/layouts
- 升级/卸载清理贡献点

## 热修复

- WebView 加载后注入 CSS/JS
- RSA-SHA256
- rollout
- 版本标记检查/回滚

## 更新

- `version.json`
- DownloadManager
- 系统安装器
