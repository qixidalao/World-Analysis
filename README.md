# 界析 · JieXi

一个可编程的 Android 解析客户端。

站点规则、JS/Python 脚本、界面组件、扩展包都在本地；不依赖远程后端。原生 Android + WebView SPA，安装即用。

> 本项目用于学习 Android / WebView / 脚本引擎 / 解析技术。请遵守目标站点条款与当地法律，不要用于侵权或非法内容。

---

## 当前版本

**1.10.36 / versionCode 92**

| 包 | 适用 |
|---|---|
| [JieXi-1.10.36-arm64.apk](releases/JieXi-1.10.36-arm64.apk) | 手机、arm64 设备，含 CPython 3.14 |
| [JieXi-1.10.36-x86_64.apk](releases/JieXi-1.10.36-x86_64.apk) | x86_64 模拟器/设备，含 Python |
| [JieXi-1.10.36-lean.apk](releases/JieXi-1.10.36-lean.apk) | 无 Python 运行时，体积小 |

校验值和安装说明见 [releases/README.md](releases/README.md)。

```sh
adb install -r releases/JieXi-1.10.36-arm64.apk
```

- minSdk：Python 包 24，lean 23
- ABI：arm64-v8a / x86_64
- 当前为开发签名 `apkdev`，不是商店正式签名

---

## 功能

| 模块 | 说明 |
|---|---|
| 站点 | 新建/编辑/启停/删除；默认站点；禁用站点仍显示 |
| 解析 | 规则（CSS 选择器）/ JS / Python 三种方式 |
| 多文件 | 文件标签、入口、相对 import、动态 `import()`、CommonJS |
| 参数 | `CONFIG` / `config` 自动生成表单，运行时 `CFG` |
| 组件 | 图片、标题、正文、头像、头图、键值、统计、进度、评分、列表、图集、按钮等 |
| 规则 | CSS 表单/JSON 源码；列表/详情/分页/频道；在线规则源与签名源 |
| 主页 | 欢迎语、功能卡、站点、继续观看、公告、自定义区块、背景图 |
| 自定义布局 | 模块顺序、轮播高度、卡片列数；保存返回目标 |
| 浏览 | 主页缓存 0–1440 分钟；列表自动翻页 |
| 播放 | HLS / m3u8、WebView 播放、横屏、手势、续播、分片 IndexedDB 缓存 |
| 模块 | 开发者/官方 PyPI/第三方商店，搜索、来源、依赖、自动加载、预编译提示 |
| 终端 | shell、Python、JS、文件面板、快捷键 |
| 扩展包 | 语法、组件、规则模板、主题、页面、首页布局块 |
| 自定义语法 | 关键字/类型/常量/函数/注释，按扩展名生效 |
| 语法配色 | 预设色 + 自定义色，所有语言共用 |
| 热修复 | RSA-SHA256 签名、rollout 灰度、回滚 |
| 更新 | 关于页检查更新、下载并安装 APK |
| 日志 | 多选、全选、复制选中、错误过滤 |

---

## 文档

完整目录见 [docs/index.md](docs/index.md)。

### 入门

- [快速上手](docs/QUICKSTART.md)
- [用户手册](docs/USER_GUIDE.md)
- [脚本 API](docs/SCRIPT_API.md)
- [规则 API](docs/RULE_API.md)
- [Python API](docs/PYTHON_API.md)

### 进阶

- [高级用法](docs/ADVANCED.md)
- [扩展包](docs/PLUGINS.md)
- [界面自定义](docs/CUSTOMIZE.md)
- [模块商店](docs/MODULES.md)
- [终端](docs/TERMINAL.md)

### 维护

- [热修复与更新](docs/HOTFIX_UPDATE.md)
- [安全模型](docs/SECURITY.md)
- [FAQ](docs/FAQ.md)
- [构建](docs/BUILD.md)
- [发布记录](docs/RELEASE.md)
- [架构](docs/ARCHITECTURE.md)
- [页面树](docs/APP_TREE.md)
- [状态](docs/STATE.md)
- [编辑器 SDK](docs/EDITOR.md)
- [UI 组件](docs/UI.md)

App 内：**设置 → 关于 → 文档中心**（在线读取；失败提示 QQ 群 123456789）。

---

## 快速跑通

1. 新建站点 → 选择规则 / JS / Python；
2. 写 `parse(url, html)`，返回 `home` / `list` / `detail` / `player`；
3. 编辑器测试 URL；
4. 回主页选择站点；
5. 浏览、搜索、详情、播放。

最小 JS：

```js
export default {
  name: '示例站点',
  site: 'https://example.com',
  home() { return this.site + '/'; },
  parse(url, html) {
    return { type: 'home', heroes: [], cats: [], sections: [] };
  }
};
```

更多见 [快速上手](docs/QUICKSTART.md)。

---

## 构建

手工构建，不依赖 Gradle 出包：

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1 -WithPython -PyAbi arm64-v8a -PyVersion 3.14 -OutName JieXi-arm64.apk
```

细节、签名、三 ABI、Python 资产见 [BUILD.md](docs/BUILD.md)。

---

## 目录

```text
app/                 Android 应用
  src/main/assets/   WebView SPA（js/css/pages）
  src/main/java/     JsBridge / NetClient / TermBridge / HotFix
  src/main/python/   CPython 脚本引擎
pyruntime/           Chaquopy 打包运行时
docs/                文档
releases/            已编译 APK
build.ps1            手工构建脚本
```

---

## 安全与限制

已做：

- 热修复验签、回滚、灰度；
- 扩展包权限确认、升级/卸载清理；
- 规则源签名校验；
- 外链不劫持 SPA；
- 发布 APK 扫描 R18/备份文件。

未做：

- 扩展包强沙箱；
- 支付/许可证（商业功能）。
- 原生播放器/持久 PTY；
- 生产商店签名。

详见 [SECURITY.md](docs/SECURITY.md)。

---

## 许可

本项目以 **AGPL-3.0** 发布，见 [LICENSE](LICENSE)。

第三方依赖（hls.js / OkHttp / Okio / Chaquopy 等）保留各自许可。

本项目**不内置任何站点规则或成人内容**；仓库中的示例只使用 `example.com`。
