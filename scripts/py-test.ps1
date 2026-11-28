# py-test.ps1 - Python 子系统探针（真机；异步结果用 console.log 打到 logcat）
param([string]$Device = '127.0.0.1:16384')
$adb = 'C:\Users\one\apkdev\tools\android-sdk\platform-tools\adb.exe'
$pkg = 'com.rou.parser'

$js = @"
(function(){
  var log = function (k, v) { console.log('PYTEST ' + k + ' = ' + v); };
  log('info', JSON.stringify(Py.info()));
  Py.eval('1+1').then(function(r){ log('eval', JSON.stringify(r)) });
  Py.check('def parse(url, html):\n    return {}\n').then(function(r){ log('check_ok', JSON.stringify(r)) });
  Py.check('def broken(:\n').then(function(r){ log('check_bad', JSON.stringify(r)) });
  Py.put('t_demo', 'NAME="t_demo"\ndef parse(url, html):\n    return {"type":"detail","detail":{"title":"user-script"}}\n').then(function(r){
    log('put', JSON.stringify(r));
    Py.dispatch('t_demo', 'http://x/v/1', '<h1>hi</h1>').then(function(d){ log('dispatch', JSON.stringify(d)) });
  });
  Py.run('def parse(url, html):\n    return {"type":"detail","detail":{"title":"inline"}}\n', 'http://x/v/1', '<h1>hi</h1>').then(function(r){ log('run', JSON.stringify(r)) });
  Py.list().then(function(r){ log('list', JSON.stringify(r).slice(0,160)) });
})();
"@

$b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))
& $adb -s $Device shell am force-stop $pkg 2>$null | Out-Null
Start-Sleep -Milliseconds 300
& $adb -s $Device logcat -c 2>$null | Out-Null
& $adb -s $Device shell am start -n "$pkg/.MainActivity" -e js "b64:$b" 2>&1 | Out-Null
Start-Sleep -Seconds 16
& $adb -s $Device logcat -d 2>&1 | Select-String -Pattern 'PYTEST' | ForEach-Object { $_.Line.Substring([Math]::Min(24, $_.Line.Length)) }
