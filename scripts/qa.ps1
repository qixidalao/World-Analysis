# qa.ps1 — 构建 → 安装 → 按路由启动 → 截图（lead 的验收工具）
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa.ps1 -Shot home
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa.ps1 -Route "module" -Shot module
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa.ps1 -Route "detail?url=https://example.com/v/xxx" -Shot detail
param(
    [string]$Route = '',
    [string]$Shot = '',
    [string]$Net = 'proxy',
    [string]$Proxy = '127.0.0.1:7890',
    [switch]$NoBuild,
    [int]$Wait = 6000,
    [string]$Device = '127.0.0.1:16384'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$adb = 'C:\Users\one\apkdev\tools\android-sdk\platform-tools\adb.exe'
$pkg = 'com.rou.parser'

if (-not $NoBuild) {
    Write-Host '[qa] build' -ForegroundColor Cyan
    powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'build.ps1') | Select-String 'OK  ->|error|失败'
}

Write-Host '[qa] adb reverse proxy' -ForegroundColor Cyan
& $adb -s $Device reverse tcp:7890 tcp:7890 | Out-Null

Write-Host '[qa] install' -ForegroundColor Cyan
& $adb -s $Device install -r (Join-Path $root 'RouParser.apk') 2>&1 | Select-String 'Success|Failure'

& $adb -s $Device shell am force-stop $pkg | Out-Null
Start-Sleep -Milliseconds 400

$argsList = @('shell', 'am', 'start', '-n', "$pkg/.MainActivity")
if ($Route) { $argsList += @('-e', 'route', $Route) }
if ($Net) { $argsList += @('-e', 'net', $Net) }
if ($Proxy) { $argsList += @('-e', 'proxy', $Proxy) }
& $adb -s $Device @argsList | Out-Null

Start-Sleep -Milliseconds $Wait

if ($Shot) {
    $tmp = "/sdcard/qa-$Shot.png"
    & $adb -s $Device shell screencap -p $tmp | Out-Null
    $out = Join-Path $root "shots\$Shot.png"
    New-Item -ItemType Directory (Split-Path $out) -Force | Out-Null
    & $adb -s $Device pull $tmp $out 2>&1 | Out-Null
    & $adb -s $Device shell rm -f $tmp | Out-Null
    Write-Host "[qa] shot -> $out" -ForegroundColor Green
}
