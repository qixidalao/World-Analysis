# sweep.ps1 - launch every route on the device, screenshot it, and report JS errors from logcat.
# ASCII only comments: Windows PowerShell 5.1 reads BOM-less files as ANSI.
# -Site local  -> uses the offline fake site (scripts/fake_site.py on 127.0.0.1:8000, site id local_test)
param(
    [string]$Device = '127.0.0.1:16384',
    [int]$Wait = 5000,
    [switch]$NoInstall,
    [ValidateSet('real', 'local')][string]$Site = 'real'
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$adb = 'C:\Users\one\apkdev\tools\android-sdk\platform-tools\adb.exe'
$pkg = 'com.rou.parser'
$outDir = Join-Path $root 'shots'
New-Item -ItemType Directory $outDir -Force | Out-Null

$base = if ($Site -eq 'local') { 'http://127.0.0.1:8000' } else { 'https://example.com' }
$siteId = if ($Site -eq 'local') { 'local_test' } else { 'demo_site' }
$netArgs = if ($Site -eq 'local') { @('-e', 'net', 'direct') } else { @('-e', 'net', 'proxy', '-e', 'proxy', '127.0.0.1:7890') }

& $adb -s $Device reverse tcp:7890 tcp:7890 | Out-Null
if ($Site -eq 'local') { & $adb -s $Device reverse tcp:8000 tcp:8000 | Out-Null }
if (-not $NoInstall) { & $adb -s $Device install -r (Join-Path $root 'RouParser.apk') 2>&1 | Select-String 'Success|Failure' }

$video = "$base/v/cmwv0k49x0003s6yugo1w55w0"
$routes = [ordered]@{
    'home'          = 'home'
    'browse'        = 'browse'
    'fav'           = 'fav'
    'mine'          = 'mine'
    'detail'        = "detail?url=$video"
    'list'          = "list?site=$siteId&url=$base/t/x&title=LIST"
    'search'        = "search?site=$siteId"
    'player'        = "player?site=$siteId&url=$video"
    'scripts'       = 'scripts'
    'scriptEdit'    = "scriptEdit?id=$siteId"
    'scriptDetail'  = "scriptDetail?id=$siteId"
    'newscript'     = 'newscript'
    'module'        = 'module'
    'terminal'      = 'terminal'
    'settings'      = 'settings'
    'settings.net'  = 'settings.net'
    'settings.play' = 'settings.play'
    'settings.ui'   = 'settings.ui'
    'settings.py'   = 'settings.py'
    'settings.storage' = 'settings.storage'
    'settings.about'   = 'settings.about'
    'logs'          = 'logs'
}

$rows = @()
foreach ($k in $routes.Keys) {
    $route = $routes[$k]
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($route))
    & $adb -s $Device shell am force-stop $pkg 2>$null | Out-Null
    Start-Sleep -Milliseconds 350
    & $adb -s $Device logcat -c 2>$null | Out-Null
    $a = @('-s', $Device, 'shell', 'am', 'start', '-n', "$pkg/.MainActivity", '-e', 'route', "b64:$b64") + $netArgs
    & $adb @a 2>&1 | Out-Null
    Start-Sleep -Milliseconds $Wait
    $png = Join-Path $outDir ("sweep-" + $Site + "-" + ($k -replace '\.', '-') + ".png")
    & $adb -s $Device shell screencap -p "/sdcard/sw.png" 2>$null | Out-Null
    & $adb -s $Device pull "/sdcard/sw.png" $png 2>$null | Out-Null
    $logs = & $adb -s $Device logcat -d 2>&1
    $errs = @($logs | Select-String -Pattern 'CONSOLE LOG: \[err|Uncaught|net ERR')
    $size = if (Test-Path $png) { [math]::Round((Get-Item $png).Length / 1KB) } else { 0 }
    $rows += [pscustomobject]@{ Page = $k; ShotKB = $size; Errors = $errs.Count }
    Write-Host ("{0,-16} {1,6} KB  errors={2}" -f $k, $size, $errs.Count)
}
Write-Host ''
$rows | Format-Table -AutoSize Page, ShotKB, Errors
