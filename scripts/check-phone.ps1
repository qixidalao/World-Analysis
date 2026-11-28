# check-phone.ps1 — 一条命令：装对包 → 启动终端 → 实测 Python 是否可用
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-phone.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-phone.ps1 -Apk JieXi-arm64.apk
#
# 适合手机用 USB 连电脑（adb devices 能看到设备）时做验收：
#   1) 读设备 ABI / 型号 / Android 版本；
#   2) 自动选 JieXi-arm64.apk（手机）或 JieXi-py-x86_64.apk（模拟器）并安装；
#   3) 用调试 extra 注入一段 JS：Py.info() + Py.repl('print(...)')；
#   4) 从 logcat 抓 PYCHK / PYRUN 结果，打印 PASS / FAIL。
param(
    [string]$ApkDev = 'C:\Users\one\apkdev',
    [string]$Root   = '',
    [string]$Apk    = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$adb = Join-Path $ApkDev 'tools\android-sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "缺少 adb: $adb" }

$devices = @(& $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\sdevice$' })
if (-not $devices.Count) {
    Write-Host '没有检测到设备。请用 USB 连接手机并打开「USB 调试」，然后重试。' -ForegroundColor Yellow
    Write-Host '（不连电脑也可以：把 JieXi-arm64.apk 拷进手机直接安装。）'
    exit 1
}

$abi   = (& $adb shell getprop ro.product.cpu.abi).Trim()
$model = (& $adb shell getprop ro.product.model).Trim()
$rel   = (& $adb shell getprop ro.build.version.release).Trim()
Write-Host ("设备: " + $model + " · Android " + $rel + " · " + $abi)

if (-not $Apk) {
    if ($abi -match '^arm64') { $Apk = 'JieXi-arm64.apk' }
    elseif ($abi -match '^x86_64') { $Apk = 'JieXi-py-x86_64.apk' }
    else { $Apk = 'JieXi.apk' }
}
$path = Join-Path $Root $Apk
if (-not (Test-Path $path)) { throw "找不到 $path（先跑 build.ps1）" }
Write-Host ("安装 " + $Apk + " ...")
& $adb install -r $path
if ($LASTEXITCODE) { exit $LASTEXITCODE }

$js = @'
(function(){
  function log(s){ console.log(s) }
  try {
    if (!window.Py) { log('PYCHK nopy'); return 'ok' }
    var info = Py.info();
    log('PYCHK ' + JSON.stringify(info));
    if (info && info.ok) {
      Py.repl('print("PYRUN", 1 + 1)', '').then(
        function(r){ log('PYRUN ' + JSON.stringify(r)) },
        function(e){ log('PYRUNERR ' + e) });
    }
  } catch (e) { log('PYCHKERR ' + e) }
  return 'ok';
})()
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))

& $adb logcat -c
& $adb shell am force-stop com.rou.parser | Out-Null
Start-Sleep -Milliseconds 600
& $adb shell am start -n com.rou.parser/.MainActivity -e route "terminal" -e js "b64:$b64" | Out-Null
Start-Sleep -Seconds 9

$lines = @(& $adb logcat -d | Select-String -Pattern 'PYCHK \{|PYRUN \{|PYCHKERR|nopy' | ForEach-Object { ($_.Line -split 'CONSOLE LOG: ')[-1] })
Write-Host ''
Write-Host '—— 实测结果 ——'
$lines | ForEach-Object { Write-Host $_ }
$ok = ($lines -join "`n") -match '"ok":true'
if ($ok) {
    Write-Host ''
    Write-Host 'Python 可用的确证（上面 PYCHK ok:true）。' -ForegroundColor Green
    Write-Host '现在可以在终端里输入：python   然后试  1+1  /  import sys; sys.version'
} else {
    Write-Host ''
    Write-Host 'Python 没有起来。把上面这几行（尤其 PYCHK/PYCHKERR 的内容）发我，我来定位。' -ForegroundColor Yellow
    Write-Host '如果是 lean 包（JieXi.apk）则本来就无 Python，请用 JieXi-arm64.apk。'
}
