# build.ps1 — Windows 原生构建（不依赖 Gradle / bash）
# aapt2 compile -> aapt2 link -> javac -> d8(含 libs/*.jar) -> 重打包(修正 assets 路径) -> zipalign -> apksigner
#
# 用法:  powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
#        powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -MinSdk 23 -TargetSdk 34
#
# 前置: C:\Users\one\apkdev\tools\jdk17  +  tools\android-sdk (build-tools 35.0.0 + platforms\android-35)
#
# 注意（踩过的坑）：
#   1) aapt2 在 Windows 上给 assets 生成的 zip 条目名是 "assets\js\core.js"（反斜杠），
#      Android 的 AssetManager 只认 "assets/js/core.js" → 页面里所有 css/js 全部 404。
#      所以第 5 步重打包时统一把条目名里的 \ 换成 /。
#   2) resources.arsc 必须保持 STORED（不压缩），重打包时按名字判断压缩方式，zipalign 再对齐。
param(
    [string]$ApkDev   = 'C:\Users\one\apkdev',
    [int]$MinSdk      = 23,
    [int]$TargetSdk   = 34,
    [string]$OutName  = 'RouParser.apk',
    # 可选：把 Chaquopy Python 运行时打进 APK（默认关闭，关闭时构建行为与以前完全一致）
    # 前置：先跑 pyruntime\fetch.ps1 下载工件
    [switch]$WithPython,
    [string]$PyAbi    = 'x86_64',
    [string]$PyVersion = '3.11'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdk  = Join-Path $ApkDev 'tools\android-sdk'
$jdk  = Join-Path $ApkDev 'tools\jdk17'

$d8        = Join-Path $sdk 'build-tools\35.0.0\d8.bat'
$zipalign  = Join-Path $sdk 'build-tools\35.0.0\zipalign.exe'
$apksigner = Join-Path $sdk 'build-tools\35.0.0\apksigner.bat'
$aapt2     = Join-Path $sdk 'build-tools\35.0.0\aapt2.exe'
$androidJar = Join-Path $sdk 'platforms\android-35\android.jar'
$javac     = Join-Path $jdk 'bin\javac.exe'
$keystore  = Join-Path $ApkDev 'keys\apkdev.jks'
$ksAlias   = 'apkdev'
$ksPass    = $env:APKDEV_KS_PASS

foreach ($p in @($aapt2, $d8, $zipalign, $apksigner, $androidJar, $javac, $keystore)) {
    if (-not (Test-Path $p)) { throw "缺少构建组件: $p" }
}

# 第三方 jar（OkHttp / Okio）：javac 编译期用，d8 运行时也要一起 dex
$libsDir = Join-Path $root 'app\libs'
$libJars = @()
if (Test-Path $libsDir) {
    $libJars = @(Get-ChildItem -Path $libsDir -Filter *.jar | Sort-Object Name | ForEach-Object { $_.FullName })
}
if (-not $libJars.Count) { Write-Host '警告: app\libs 下没有 jar（桥的网络能力会缺失）' -ForegroundColor Yellow }

# ---- 可选：Chaquopy Python（-WithPython） ----
$pyJar = $null
if ($WithPython) {
    # Chaquopy 17 要求 minSdk >= 24（见 com.chaquo.python.internal.Common.MIN_SDK_VERSION）
    if ($MinSdk -lt 24) {
        Write-Host "提示: -WithPython 需要 minSdk>=24，已自动把 $MinSdk 提为 24" -ForegroundColor Yellow
        $MinSdk = 24
    }
    $pyDir    = Join-Path $root 'pyruntime'
    $pyVendor = Join-Path $pyDir 'vendor'
    $pyJar    = Join-Path $pyVendor 'chaquopy_java-17.2.0.jar'
    if (-not (Test-Path $pyJar)) { throw "缺少 $pyJar`n先执行: powershell -NoProfile -ExecutionPolicy Bypass -File pyruntime\fetch.ps1" }
    $libJars += $pyJar
}
$javacCp = (@($androidJar) + $libJars) -join ';'

$env:JAVA_HOME = $jdk
$env:Path = (Join-Path $jdk 'bin') + ';' + $env:Path

$build = Join-Path $root 'build'
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory $build, "$build\obj", "$build\gen", "$build\dex" | Out-Null

# ---- 可选：组装 Chaquopy 资产与 so（-WithPython） ----
$pyAssets = $null
$pyLibs   = $null
if ($WithPython) {
    Write-Host '[py] 组装 Python assets / lib' -ForegroundColor Cyan
    $pyAssets = Join-Path $build 'pyruntime\assets\chaquopy'
    $pyLibs   = Join-Path $build "pyruntime\lib\$PyAbi"
    $pyTool   = Join-Path $root 'pyruntime\tools\build_pyassets.py'
    $pythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $pythonExe) { throw '需要 python 3.11 来组装 Python 资产（未在 PATH 找到 python）' }
    & $pythonExe $pyTool --vendor $pyVendor --out (Join-Path $build 'pyruntime') `
        --app (Join-Path $root 'app\src\main\python') --abi $PyAbi --py $PyVersion
    if ($LASTEXITCODE) { throw "build_pyassets.py 失败 ($LASTEXITCODE)" }
    if (-not (Test-Path (Join-Path $pyAssets 'build.json'))) { throw '缺少 assets/chaquopy/build.json' }
}

$res    = Join-Path $root 'app\src\main\res'
$assets = Join-Path $root 'app\src\main\assets'
$badBak = Get-ChildItem $assets -Recurse -File -Filter *.bak -ErrorAction SilentlyContinue
if ($badBak) { throw ('禁止打包备份文件: ' + ($badBak.FullName -join ', ')) }
$badCn = [string][char]0x8089 + [char]0x89C6 + [char]0x9891
$badTrad = [string][char]0x8089 + [char]0x89C6 + [char]0x983B
$badPat = 'rou' + '\.video|' + 'rou' + '_video|personal\.bak|' + $badCn + '|' + $badTrad
$badText = Get-ChildItem $assets -Recurse -File -Include *.js,*.html,*.css,*.json,*.txt -ErrorAction SilentlyContinue | Select-String -Pattern $badPat
if ($badText) { throw ('assets 含受限内容: ' + (($badText | Select-Object -First 3 | ForEach-Object { $_.Path + ':' + $_.LineNumber }) -join '; ')) }
$pySrc = Join-Path $root 'app\src\main\python'
$badPy = Get-ChildItem $pySrc -Recurse -File -Include *.py -ErrorAction SilentlyContinue | Select-String -Pattern $badPat
if ($badPy) { throw ('Python 资产含受限内容: ' + (($badPy | Select-Object -First 3 | ForEach-Object { $_.Path + ':' + $_.LineNumber }) -join '; ')) }
$mani   = Join-Path $root 'app\src\main\AndroidManifest.xml'

Write-Host '[1/6] aapt2 compile res' -ForegroundColor Cyan
& $aapt2 compile --dir $res -o "$build\res.zip"
if ($LASTEXITCODE) { throw "aapt2 compile 失败 ($LASTEXITCODE)" }

Write-Host '[2/6] aapt2 link' -ForegroundColor Cyan
& $aapt2 link -o "$build\base.apk" `
    -I $androidJar `
    --manifest $mani `
    -A $assets `
    --java "$build\gen" `
    --min-sdk-version $MinSdk `
    --target-sdk-version $TargetSdk `
    --auto-add-overlay `
    "$build\res.zip"
if ($LASTEXITCODE) { throw "aapt2 link 失败 ($LASTEXITCODE)" }

Write-Host '[3/6] javac' -ForegroundColor Cyan
$srcDirs = @((Join-Path $root 'app\src\main\java'), "$build\gen")
if ($WithPython) { $srcDirs += (Join-Path $root 'pyruntime\java') }
$srcs = @(Get-ChildItem -Path $srcDirs -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if (-not $srcs.Count) { throw '没有找到 Java 源码' }
& $javac -source 8 -target 8 -nowarn -encoding UTF-8 `
    -classpath $javacCp -d "$build\obj" @srcs
if ($LASTEXITCODE) { throw "javac 失败 ($LASTEXITCODE)" }

Write-Host ('[4/6] d8 -> classes.dex  (' + $libJars.Count + ' 个 jar + class 文件)') -ForegroundColor Cyan
$classes = @(Get-ChildItem "$build\obj" -Recurse -Filter *.class | ForEach-Object { $_.FullName })
if (-not $classes.Count) { throw '没有找到 class 文件' }
# d8 同时接受 .class 和 .jar；jar 里的类会被一起 dex 进来，输出目录里通常只有 classes.dex
& $d8 --lib $androidJar --min-api $MinSdk --release --output "$build\dex" @classes @libJars
if ($LASTEXITCODE) { throw "d8 失败 ($LASTEXITCODE)" }

$dexFiles = @(Get-ChildItem "$build\dex" -Filter *.dex | Sort-Object Name)
if (-not $dexFiles.Count) { throw 'd8 没有产出 dex' }
if ($dexFiles.Count -gt 1) { Write-Host ('注意: d8 产出 ' + $dexFiles.Count + ' 个 dex，全部打包') -ForegroundColor Yellow }

Write-Host '[5/6] 重打包（修正 zip 条目名 + 塞 dex）+ zipalign' -ForegroundColor Cyan
$unsigned = "$build\unsigned.apk"
Copy-Item "$build\base.apk" $unsigned -Force
$zip = [System.IO.Compression.ZipFile]::Open($unsigned, 'Update')
try {
    # 关键：aapt2 在 Windows 上把 assets 写成 "assets\js\core.js"，AssetManager 只认 "/"。
    # 只改名受影响的条目，resources.arsc 等原样保留（必须是 STORED）。
    $renamed = 0
    $targets = @($zip.Entries | Where-Object { $_.FullName.Contains('\') })
    foreach ($e in $targets) {
        $oldName = $e.FullName
        $newName = $oldName.Replace('\', '/')
        $ms = New-Object System.IO.MemoryStream
        $ins = $e.Open()
        try { $ins.CopyTo($ms) } finally { $ins.Dispose() }
        $e.Delete()
        if ($zip.GetEntry($newName)) {
            Write-Host ('  跳过重复条目 ' + $newName) -ForegroundColor Yellow
        } else {
            $ne = $zip.CreateEntry($newName, [System.IO.Compression.CompressionLevel]::Optimal)
            $outs = $ne.Open()
            try { $ms.WriteTo($outs) } finally { $outs.Dispose() }
            $renamed++
        }
        $ms.Dispose()
    }
    Write-Host ('  修正 zip 条目名: ' + $renamed + ' 个')
    foreach ($d in $dexFiles) {
        $name = if ($d.Name -match '^classes\d*\.dex$') { $d.Name } else { 'classes.dex' }
        $old = $zip.GetEntry($name)
        if ($old) { $old.Delete() }
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $d.FullName, $name,
            [System.IO.Compression.CompressionLevel]::Optimal)
    }

    if ($WithPython) {
        Write-Host '  [py] Python 资产/so 交给 add_entries.py 追加（强制 STORED）'
    }
} finally { $zip.Dispose() }

if ($WithPython) {
    # 关键：.NET ZipArchive 的 NoCompression 实际是 deflate level 0（method=8），
    # 而 Chaquopy 资产与 lib/*.so 必须是 STORED（method=0）才能随机读 / 直接 mmap。
    $pyAdd = Join-Path $root 'pyruntime\tools\add_entries.py'
    $pythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $pythonExe) { throw '需要 python 来追加 Python 资产' }
    & $pythonExe $pyAdd --apk $unsigned --assets $pyAssets --libs $pyLibs --abi $PyAbi --out "$build\unsigned2.apk"
    if ($LASTEXITCODE) { throw "add_entries.py 失败 ($LASTEXITCODE)" }
    Move-Item "$build\unsigned2.apk" $unsigned -Force
}
& $zipalign -p -f 4 $unsigned "$build\aligned.apk"
if ($LASTEXITCODE) { throw "zipalign 失败 ($LASTEXITCODE)" }

# 自检：assets 条目名用 /、resources.arsc 未被压缩、classes.dex 存在
$chk = [System.IO.Compression.ZipFile]::OpenRead("$build\aligned.apk")
try {
    $bad  = @($chk.Entries | Where-Object { $_.FullName.Contains('\') })
    $arsc = @($chk.Entries | Where-Object { $_.FullName -eq 'resources.arsc' })
    $dex  = @($chk.Entries | Where-Object { $_.FullName -eq 'classes.dex' })
    $page = @($chk.Entries | Where-Object { $_.FullName -eq 'assets/index.html' })
    $net  = @($chk.Entries | Where-Object { $_.FullName -eq 'assets/js/net.js' })
    if ($WithPython) {
        $pyBj  = @($chk.Entries | Where-Object { $_.FullName -eq 'assets/chaquopy/build.json' })
        $pyBoot= @($chk.Entries | Where-Object { $_.FullName -eq 'assets/chaquopy/bootstrap.imy' })
        $pyLib = @($chk.Entries | Where-Object { $_.FullName -eq "lib/$PyAbi/libpython3.$($PyVersion.Split('.')[1]).so" })
        $pyJni = @($chk.Entries | Where-Object { $_.FullName -eq "lib/$PyAbi/libchaquopy_java.so" })
        $pyBootCompressed = ($pyBoot.Count -gt 0 -and $pyBoot[0].CompressedLength -ne $pyBoot[0].Length)
    }
} finally { $chk.Dispose() }
if ($bad.Count) { throw ('zip 条目名仍含反斜杠: ' + $bad[0].FullName) }
if (-not $dex.Count) { throw 'APK 里没有 classes.dex' }
if (-not $page.Count) { throw 'APK 里没有 assets/index.html' }
if (-not $net.Count) { throw 'APK 里没有 assets/js/net.js' }
if ($arsc.Count -and $arsc[0].CompressedLength -ne $arsc[0].Length) {
    throw 'resources.arsc 被压缩了（Android 9+ 会拒绝安装）'
}
if ($WithPython) {
    if (-not $pyBj.Count)   { throw 'APK 里没有 assets/chaquopy/build.json' }
    if (-not $pyBoot.Count) { throw 'APK 里没有 assets/chaquopy/bootstrap.imy' }
    if (-not $pyJni.Count)  { throw 'APK 里没有 lib/<abi>/libchaquopy_java.so' }
    if (-not $pyLib.Count)  { throw ("APK 里没有 lib/<abi>/libpython3.*.so") }
    if ($pyBootCompressed)  { throw 'assets/chaquopy/bootstrap.imy 被压缩了（Chaquopy 需要 STORED）' }
}

Write-Host '[6/6] apksigner' -ForegroundColor Cyan
$out = Join-Path $root $OutName
if (Test-Path $out) { Remove-Item $out -Force }
& $apksigner sign --ks $keystore --ks-key-alias $ksAlias `
    --ks-pass "pass:$ksPass" --key-pass "pass:$ksPass" `
    --out $out "$build\aligned.apk"
if ($LASTEXITCODE) { throw "apksigner 失败 ($LASTEXITCODE)" }

& $apksigner verify -v $out | Select-Object -First 4
$size = '{0:N0} KB' -f ((Get-Item $out).Length / 1KB)
Write-Host "OK  ->  $out  ($size)" -ForegroundColor Green
