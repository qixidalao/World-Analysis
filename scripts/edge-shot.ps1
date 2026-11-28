# edge-shot.ps1 - render the SPA in headless Edge and screenshot it (fast UI QA, no APK build).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\edge-shot.ps1 -Route "browse" -Proxy "http://127.0.0.1:7890"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\edge-shot.ps1 -Route "detail&url=https://example.com/v/xxx" -Shot detail
param(
    [string]$Route = 'home',
    [string]$Shot = '',
    [int]$Wait = 15000,
    [switch]$DumpDom,
    [string]$Proxy = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$page = 'file:///' + (Join-Path $root 'app\src\main\assets\index.html').Replace('\', '/')
if ($Route) { $page += '#go=' + $Route }
if (-not $Shot) { $Shot = ($Route -split '&')[0] }
$outDir = Join-Path $root 'shots'
New-Item -ItemType Directory $outDir -Force | Out-Null
$out = Join-Path $outDir ($Shot + '.png')
$ud = Join-Path $env:TEMP ('edgeqa-' + [guid]::NewGuid().ToString('N').Substring(0, 6))

$a = @()
$a += '--headless=new'
$a += '--disable-gpu'
$a += '--hide-scrollbars'
$a += '--no-first-run'
$a += '--no-default-browser-check'
$a += '--allow-file-access-from-files'
$a += '--disable-web-security'
$a += ('--user-data-dir=' + $ud)
$a += '--window-size=900,1600'
$a += ('--virtual-time-budget=' + $Wait)
$a += '--autoplay-policy=no-user-gesture-required'
$a += '--mute-audio'
$a += '--enable-logging=stderr'
$a += '--v=0'
$a += ('--screenshot=' + $out)
if ($Proxy) { $a += ('--proxy-server=' + $Proxy) }
if ($DumpDom) { $a += '--dump-dom' }
$a += $page

$log = Join-Path $outDir ($Shot + '.log')
$p = Start-Process -FilePath $edge -ArgumentList $a -NoNewWindow -PassThru -RedirectStandardError $log -RedirectStandardOutput (Join-Path $outDir ($Shot + '.dom')); $p.WaitForExit(180000) | Out-Null
if (Test-Path $out) { Write-Host ("[edge] shot -> {0} ({1:N0} KB)" -f $out, ((Get-Item $out).Length / 1KB)) -ForegroundColor Green }
else { Write-Host '[edge] no screenshot produced' -ForegroundColor Red }
$err = Select-String -Path $log -Pattern 'CONSOLE|Uncaught|ERROR:' -ErrorAction SilentlyContinue | Select-Object -First 12
if ($err) { Write-Host '[edge] console:' -ForegroundColor Yellow; $err | ForEach-Object { $_.Line.Trim() } }
