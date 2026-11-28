# fetch.ps1 — 下载 Chaquopy 17.2.0 (CPython 3.11.17-0) 运行时工件
# 只依赖 curl；走阿里云 Maven 镜像（本机直连 repo.maven.apache.org / chaquo.com 均超时）。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File pyruntime\fetch.ps1
#   powershell ... -Abi arm64-v8a       # 追加 arm64 运行时（可选）
#
# 产物写入 pyruntime\vendor\，供 build.ps1 -WithPython 使用。
param(
    [string]$Abi = 'x86_64',
    [string]$PyVersion = '3.11',        # 3.10 / 3.11 / 3.12 / 3.13 / 3.14
    [string]$Base = 'https://maven.aliyun.com/repository/public/'
)
$ErrorActionPreference = 'Stop'

# 版本映射（来自 com.chaquo.python.internal.Common.PYTHON_VERSIONS: 完整版本 -> build 号）
$targetVer = @{ '3.10' = '3.10.22-0'; '3.11' = '3.11.17-0'; '3.12' = '3.12.15-0'; '3.13' = '3.13.16-0'; '3.14' = '3.14.8-0' }
if (-not $targetVer.ContainsKey($PyVersion)) { throw "不支持的 PyVersion: $PyVersion" }
$tv = $targetVer[$PyVersion]

$vendor = Join-Path $PSScriptRoot 'vendor'
New-Item -ItemType Directory -Force $vendor | Out-Null

function Get-Artifact([string]$rel, [string]$name) {
    $out = Join-Path $vendor $name
    if ((Test-Path $out) -and (Get-Item $out).Length -gt 1000) {
        Write-Host "  已存在 $name" -ForegroundColor DarkGray; return
    }
    Write-Host "  下载 $rel" -ForegroundColor Cyan
    & curl.exe -4 -sS --ssl-no-revoke -m 600 -L -o $out -w "    HTTP=%{http_code} size=%{size_download}`n" ($Base + $rel)
    if ($LASTEXITCODE -or (Get-Item $out).Length -lt 1000) { throw "下载失败: $rel" }
}

# 1) Java 桥（dex 用）
Get-Artifact 'com/chaquo/python/runtime/chaquopy_java/17.2.0/chaquopy_java-17.2.0.jar' 'chaquopy_java-17.2.0.jar'
# 2) 每个 ABI 的 JNI 桥 + Python 内置扩展
Get-Artifact "com/chaquo/python/runtime/libchaquopy_java/17.2.0/libchaquopy_java-17.2.0-$PyVersion-$Abi.so" "libchaquopy_java-17.2.0-$PyVersion-$Abi.so"
Get-Artifact "com/chaquo/python/runtime/chaquopy/17.2.0/chaquopy-17.2.0-$PyVersion-$Abi.so" "chaquopy-17.2.0-$PyVersion-$Abi.so"
# 3) bootstrap（java/_chaquopy 等启动模块，.imy = zip）
Get-Artifact "com/chaquo/python/runtime/bootstrap/17.2.0/bootstrap-17.2.0-$PyVersion.imy" "bootstrap-17.2.0-$PyVersion.imy"
# 4) target：libpython3.x.so + lib-dynload（CPython 标准库扩展开 .so）
Get-Artifact "com/chaquo/python/target/$tv/target-$tv-$Abi.zip" "target-$tv-$Abi.zip"
# 5) target 标准库（这里取打好的 .pyc 版，省去本地 compileall）
Get-Artifact "com/chaquo/python/target/$tv/target-$tv-stdlib-pyc.zip" "target-$tv-stdlib-pyc.zip"

Write-Host "`n完成。vendor 内容:" -ForegroundColor Green
Get-ChildItem $vendor | Select-Object Name, Length | Format-Table -AutoSize
Write-Host @"

注意:
  * target 版本号不是 17.2.0，而是 Python 完整版本 + Chaquopy build 号（如 3.11.17-0）。
  * 这些工件来自 Maven Central 的 com.chaquo.python.runtime / com.chaquo.python 两个 group，
    阿里云 public 镜像 (= Central 代理) 可直取。官方 https://chaquo.com/maven 同样提供。
  * lib/<abi> 还需要 target zip 里的 7 个 .so（libpython3.11.so 等）+ 上面 2 个 .so，
    由 build.ps1 -WithPython 自动展开，无需手工处理。
"@
