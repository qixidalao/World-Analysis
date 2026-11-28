# install.ps1 — 按「连接设备的 ABI」自动挑选正确的 APK 并安装
#
# 用法（在工程根目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Lean      # 强制 lean 包
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Apk JieXi-arm64.apk
#
# 为什么需要它：Python 运行时是按 ABI 打包的。
#   手机（arm64-v8a）→ JieXi-arm64.apk
#   模拟器（x86_64） → JieXi-py-x86_64.apk
#   其它 / 只想要 shell → JieXi.apk（716 KB，无 Python）
# 把 x86_64 包装到 arm64 手机上会报 INSTALL_FAILED_NO_MATCHING_ABIS / -113。
param(
    [string]$ApkDev = 'C:\Users\one\apkdev',
    [string]$Root   = '',
    [switch]$Lean,
    [string]$Apk    = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$adb = Join-Path $ApkDev 'tools\android-sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "缺少 adb: $adb" }

function Pick-Apk([string]$abi) {
    if ($abi -match '^arm64') { return 'JieXi-arm64.apk' }
    if ($abi -match '^x86_64') { return 'JieXi-py-x86_64.apk' }
    return 'JieXi.apk'
}

$devices = @(& $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\sdevice$' })
if (-not $devices.Count) {
    Write-Host '没有检测到已连接的设备（adb devices 为空）。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '直接把 APK 拷到手机安装也可以：'
    Write-Host '  手机（arm64）：' + (Join-Path $Root 'JieXi-arm64.apk')
    Write-Host '  通用 / 无 Python：' + (Join-Path $Root 'JieXi.apk')
    Write-Host '  模拟器（x86_64）：' + (Join-Path $Root 'JieXi-py-x86_64.apk')
    Write-Host ''
    Write-Host '（手机通常能在「设置 → 关于手机 → 处理器」看到 arm64 / 64 位；' +
        '或在终端里 uname -m 应为 aarch64）'
    exit 1
}

if ($Lean) {
    $name = 'JieXi.apk'
} elseif ($Apk) {
    $name = $Apk
} else {
    $abi = (& $adb shell getprop ro.product.cpu.abi).Trim()
    $name = Pick-Apk $abi
    Write-Host ("设备 ABI: " + $abi + "  ->  " + $name)
}

$path = Join-Path $Root $name
if (-not (Test-Path $path)) { throw "找不到 $path（先跑 build.ps1）" }
Write-Host ("安装 " + $name + " (" + [math]::Round((Get-Item $path).Length / 1MB, 2) + " MB) ...")
& $adb install -r $path
if ($LASTEXITCODE) { exit $LASTEXITCODE }

# 装完顺手拉起终端页，方便立刻验证 python / pyinfo
& $adb shell am force-stop com.rou.parser | Out-Null
Start-Sleep -Milliseconds 500
& $adb shell am start -n com.rou.parser/.MainActivity -e route "terminal" | Out-Null
Write-Host '已启动「界析」终端页。' -ForegroundColor Green
Write-Host '在提示符下输入  pyinfo  可确认 Python 是否可用；输入  python  进入交互解释器。'
