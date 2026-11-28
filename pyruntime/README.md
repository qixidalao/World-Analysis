# pyruntime — Chaquopy 17.2.0 (CPython 3.11.17) 手工接入

默认构建**不使用**这里的任何东西；只有 `build.ps1 -WithPython` 才会读取。

```powershell
# 一次性下载工件（约 20 MB，走阿里云 Maven 镜像；本机直连 chaquo.com/Central 会超时）
powershell -NoProfile -ExecutionPolicy Bypass -File pyruntime\fetch.ps1

# 带 Python 构建
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -WithPython -OutName RouParser-py.apk
```

产物（`vendor/` 被 .gitignore 忽略，不入库）：

| 文件 | 作用 | 最终去向 |
|---|---|---|
| `chaquopy_java-17.2.0.jar` | `Python` / `AndroidPlatform` / `PyObject` 等 Java 类 | 被 `d8` dex 进 `classes.dex` |
| `libchaquopy_java-17.2.0-3.11-x86_64.so` | JNI 桥（`startNative` 等） | `lib/x86_64/libchaquopy_java.so` |
| `chaquopy-17.2.0-3.11-x86_64.so` | Python 内置扩展 `_chaquopy`（含 `AssetFile`） | `lib/x86_64/chaquopy.so` |
| `bootstrap-17.2.0-3.11.imy` | `java` 包 / setuptools（zip） | `assets/chaquopy/bootstrap.imy` |
| `target-3.11.17-0-x86_64.zip` | `libpython3.11.so` 等 8 个 .so + 59 个 lib-dynload | `lib/x86_64/` + `assets/chaquopy/{bootstrap-native,stdlib-x86_64}.imy` |
| `target-3.11.17-0-stdlib-pyc.zip` | 630 个 .pyc 标准库 | `assets/chaquopy/stdlib-common.imy` |
| `cacert.pem` | SSL 根证书（从 gradle 插件 jar 提取） | `assets/chaquopy/cacert.pem` |

详细原理、证据、未验证项与替代方案见 `docs/13-Python接入方案.md`。
