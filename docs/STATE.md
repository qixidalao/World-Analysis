# 状态与启动

## 启动顺序

1. Java 初始化 WebView、桥、网络、热修复；
2. WebView 加载 `index.html`；
3. `core.js` 初始化 App/UI/DB；
4. `boot.js`：
   - 解析 `Native.appInfo()`
   - 初始化扩展包
   - 应用主题、语法配色、自定义 CSS
   - 选择站点
   - 渲染默认 Tab
   - 热修复注入

## 站点选择

```text
defaultSite（启用中）
→ lastSite（启用中）
→ 第一个启用站点
→ 无站点：显示选择站点
```

全禁用时顶部显示“选择站点”。

## 主页缓存

- `browseCache` 分钟
- 0 关闭
- 列表/详情页共用
- 强刷/站点变更会失效

## 设置同步

- `DB.setCfg` 写入后立即生效
- 主题/语法配色/自定义 CSS 由 `UI.applyTheme` 应用
- 站点启停由 `App.afterSiteChange` 重选/刷新

## 个人中心/设置

- 个人中心：资料、收藏、历史、反馈
- 设置：外观、播放、主页布局、网络、缓存、Python、扩展包、存储、关于
