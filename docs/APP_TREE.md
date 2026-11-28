# 页面树

```text
底部 Tab
├─ home 主页
│  ├─ 站点选择
│  ├─ 主页自定义（浮层）
│  └─ 模块：欢迎/功能卡/站点/继续/公告/自定义
├─ browse 浏览
│  ├─ list
│  ├─ detail
│  ├─ player
│  ├─ images / audio / book
│  └─ search
├─ fav 收藏
│  └─ 分段：收藏 / 历史
└─ mine 个人中心
   ├─ 编辑资料
   └─ 反馈与建议

设置（从主页/个人中心进入）
├─ settings
│  ├─ settings.site
│  ├─ settings.net
│  ├─ settings.play
│  ├─ settings.ui
│  ├─ settings.py
│  ├─ settings.packs
│  ├─ settings.storage
│  ├─ settings.about
│  └─ logs
├─ scripts / scriptDetail
├─ module / modules
└─ terminal

文档
└─ packdocs（文档中心，在线读取）

编辑器
└─ code-overlay（统一浮层）
```

## 页面注册

`App.pages[name] = function(root, params, st) {}`

- `root` 页面容器
- `params` 参数
- `st` 状态对象，可挂 cleanup

## Tab 注册

`App.tabs[name] = function(root) {}`，可挂 `openCustomize` 等入口。
