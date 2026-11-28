# 构建

## 环境

- Windows 10/11 或 Linux
- JDK 17
- Android SDK platform 35、build-tools 35.0.0
- Python 3.11+（只用于运行构建辅助脚本）
- 可选：Chaquopy 17.x / CPython 3.14（内置 Python 包）
- PowerShell 7+ / Windows PowerShell 5.1

## 手工构建链

```text
aapt2 compile/link
→ javac
→ d8
→ 合并 assets / libs / dex
→ zipalign
→ apksigner
```

## 命令

### 轻量包

```powershell
.\build.ps1 -OutName JieXi.apk
```

没有 Python，只保留 JS / 规则。

### arm64 + Python

```powershell
.\build.ps1 -WithPython -PyAbi arm64-v8a -PyVersion 3.14 -OutName JieXi-arm64.apk
```

### x86_64 + Python

```powershell
.\build.ps1 -WithPython -PyAbi x86_64 -PyVersion 3.14 -OutName JieXi-x86_64.apk
```

## 签名

`build.ps1` 从环境变量读口令：

```powershell
$env:APKDEV_KS_PASS = "your-password"
```

默认 keystore：

```text
keys/apkdev.jks
alias: apkdev
```

生产发布请替换为自己的 keystore，不要用开发签名。

## 守卫

构建前会检查：

- assets 内 `.bak`；
- assets 文本中的受限字样；
- Python 源码中的受限字样；
- 最终 APK 由独立脚本再扫一遍 `.imy`。

## 产物

- arm64 约 26 MB；
- x86_64 约 26 MB；
- lean 约 0.8 MB；
- 版本号来自 `AndroidManifest.xml`，`app/build.gradle` 与 `core.js` 兜底值需同步。

## 发布

把 APK 放到 `releases/`，更新：

- `releases/README.md`
- `docs/RELEASE.md`
- 云端 `version.json`

详见 [发布记录](RELEASE.md)。
