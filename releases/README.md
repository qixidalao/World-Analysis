# 发布包

## 1.10.36 / 92

| 文件 | 用途 | SHA-256 |
|---|---|---|
| [JieXi-1.10.36-arm64.apk](https://github.com/qixidalao/World-Analysis/releases/download/v1.10.36/JieXi-1.10.36-arm64.apk) | 手机、arm64 设备，含 Python | `E50AA25021FB0AB4941932A23E8468CFCFC51E94E995B6DCDAF2494F868D1FE6` |
| [JieXi-1.10.36-x86_64.apk](https://github.com/qixidalao/World-Analysis/releases/download/v1.10.36/JieXi-1.10.36-x86_64.apk) | x86_64 模拟器/设备，含 Python | `F7EBDC4932CC41130916CB2BA73EE6D0A9D51C35155D018661CF7196435C0044` |
| [JieXi-1.10.36-lean.apk](https://github.com/qixidalao/World-Analysis/releases/download/v1.10.36/JieXi-1.10.36-lean.apk) | 无 Python 运行时，体积小 | `A861BB4D1D7958F45060A53281B81E7235B832417300271E07D19450FB0C5052` |

## 安装

```sh
adb install -r JieXi-1.10.36-arm64.apk
```

手机直接点 APK 安装；需要允许“安装未知应用”。

APK 已从 Git 工作树移除，改由 GitHub Releases 提供。

## 说明

- 当前使用开发签名 `apkdev`，不是商店正式签名；
- arm64/x86_64 包内置 CPython 3.14；
- lean 包没有 Python，JS/规则仍可用；
- 更新通道：`https://cloud.lenv.top/pub/jiexi/version.json`。
