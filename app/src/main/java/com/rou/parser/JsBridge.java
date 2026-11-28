package com.rou.parser;

import android.content.Context;
import android.app.DownloadManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.database.Cursor;

import android.content.pm.PackageInfo;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;

/**
 * JS → Java 桥，暴露为 window.Native。
 * 契约见 docs/dev-frontend-conventions.md §3 与 assets/js/net.js：
 *   req(id, method, url, headersJson) / cfg(json) / depth(n) / ready()
 * 所有方法都在 JavaBridge 线程被调用，全部 try/catch 兜底，绝不让异常冒到 JS。
 */
public class JsBridge {
    private static final String TAG = MainActivity.TAG;

    private final MainActivity act;
    private volatile WebView web;
    private final TermBridge term;
    private final PipBridge pip;

    JsBridge(MainActivity act, WebView web) {
        this.act = act;
        this.web = web;
        this.term = new TermBridge(act, web);
        this.pip = new PipBridge(act, web);
    }

    /** Activity 销毁时断开，避免往已销毁的 WebView 回调。 */
    void detach() {
        web = null;
        try {
            term.detach();
        } catch (Throwable e) {
            Log.w(TAG, "term detach 失败: " + e);
        }
        try {
            pip.detach();
        } catch (Throwable e) {
            Log.w(TAG, "pip detach 失败: " + e);
        }
    }

    /* ---------------- pip（运行时纯 Python 包安装） ---------------- */

    @JavascriptInterface
    public String pipList() {
        return pip.listJson();
    }

    @JavascriptInterface
    public String pipRemove(String pkg) {
        return pip.removeJson(pkg);
    }

    @JavascriptInterface
    public String pipIndex(String url) {
        return pip.indexJson(url);
    }

    @JavascriptInterface
    public String pipInstall(String job, String spec, String optsJson) {
        return pip.installAsync(job, spec, optsJson);
    }

    @JavascriptInterface
    public String pipLoad(String pkg) {
        return pip.loadJson(pkg);
    }

    @JavascriptInterface
    public String pipUnload(String pkg) {
        return pip.unloadJson(pkg);
    }

    /* ---------------- 终端（真 shell，见 TermBridge） ---------------- */

    /** 会话信息：HOME / PATH / sh 路径 / ABI 等。 */
    @JavascriptInterface
    public String termInfo() {
        return term.infoJson();
    }

    /** 起一条命令（异步）：输出走 window.__termEv({j,t,d,c,ms})。 */
    @JavascriptInterface
    public String termRun(String job, String cmd, String cwd, String envJson, int timeoutMs) {
        return term.runJson(job, cmd, cwd, envJson, timeoutMs);
    }

    /** 中断指定命令（SIGKILL 整个进程组）。 */
    @JavascriptInterface
    public void termKill(String job) {
        term.killJson(job);
    }

    /** 中断全部命令（页面销毁时兜底）。 */
    @JavascriptInterface
    public void termKillAll() {
        term.killAll();
    }

    /** 路径信息（cd 校验 / 补全）。 */
    @JavascriptInterface
    public String termStat(String path, String cwd) {
        return term.statJson(path, cwd);
    }

    /** Tab 补全（allowCmd=false 时只补路径）。 */
    @JavascriptInterface
    public String termComplete(String prefix, String cwd, boolean allowCmd) {
        return term.completeJson(prefix, cwd, allowCmd);
    }

    /** 目录清单（右侧文件面板）。 */
    @JavascriptInterface
    public String termList(String path, String cwd) {
        return term.listJson(path, cwd);
    }

    /** 重命名。 */
    @JavascriptInterface
    public String termRename(String path, String newName, String cwd) {
        return term.renameJson(path, newName, cwd);
    }

    /** 删除（目录递归）。 */
    @JavascriptInterface
    public String termDelete(String path, String cwd) {
        return term.deleteJson(path, cwd);
    }

    /** 新建目录。 */
    @JavascriptInterface
    public String termMkdir(String path, String cwd) {
        return term.mkdirJson(path, cwd);
    }

    /** 写文本文件。 */
    @JavascriptInterface
    public String termWrite(String path, String text, String cwd) {
        return term.writeFileJson(path, text, cwd);
    }

    /** 读文本文件。 */
    @JavascriptInterface
    public String termRead(String path, String cwd, int maxBytes) {
        return term.readFileJson(path, cwd, maxBytes);
    }

    /* ---------------- 网络 ---------------- */

    @JavascriptInterface
    public void req(String id, String method, String url, String headersJson) {
        try {
            if (id == null || url == null || url.isEmpty()) {
                Log.w(TAG, "req 参数不完整 id=" + id + " url=" + url);
                return;
            }
            String m = (method == null || method.trim().isEmpty()) ? "GET" : method.trim();
            NetClient.get().req(web, id, m, url, headersJson);
        } catch (Throwable e) {
            Log.e(TAG, "req 异常: " + e);
        }
    }

    /** 应用网络配置 {mode,proxy,doh,timeout,ua,imgProxy}，无回调。 */
    @JavascriptInterface
    public void cfg(String json) {
        try {
            NetClient.get().apply(json);
        } catch (Throwable e) {
            Log.e(TAG, "cfg 异常: " + e);
        }
    }

    /* ---------------- Python（可选，build.ps1 -WithPython 才有实现） ---------------- */

    /**
     * 执行一段 Python 表达式，返回 JSON 字符串：
     *   {"ok":true,"repr":"2"} 或 {"ok":false,"err":"python-not-linked"}
     * 走反射调用 com.rou.parser.PyBridge，未接入 Python 时编译期不依赖 Chaquopy。
     */
    @JavascriptInterface
    public String pyEval(String code) {
        return pyCall("evalJson", code);
    }

    /** 运行时自检：Python 版本 / ABI / 启动错误。 */
    @JavascriptInterface
    public String pyInfo() {
        return pyCall("versionJson", "");
    }

    /** 跑 Python 解析脚本：engine.dispatch(script, url, html) → JSON（html 可由 Java 抓好后传入）。 */
    @JavascriptInterface
    public String pyDispatch(String script, String url, String html) {
        return py3("dispatchJson", script, url, html == null ? "" : html);
    }

    /** 写入用户脚本 <filesDir>/py/<id>.py（App 内保存 py 脚本时调用）。 */
    @JavascriptInterface
    public String pyPut(String id, String src) {
        return py2("putScriptJson", id, src);
    }

    /** 读取用户脚本源码。 */
    @JavascriptInterface
    public String pyRead(String id) {
        return py1s("readScriptJson", id);
    }

    /** Python 语法检查（compile）。 */
    @JavascriptInterface
    public String pyCheck(String src) {
        return py1s("checkSyntax", src);
    }

    /** 直接跑一段 py 源码（编辑器「测试运行」，不落盘）。 */
    @JavascriptInterface
    public String pyRun(String src, String url, String html) {
        return py3("runSourceJson", src == null ? "" : src, url == null ? "" : url, html == null ? "" : html);
    }

    /** 重置 Python REPL 命名空间。 */
    @JavascriptInterface
    public String pyReset() {
        return pyZero("resetJson");
    }

    /** 内置 + 用户脚本清单。 */
    @JavascriptInterface
    public String pyList() {
        return pyZero("listScriptsJson");
    }

    /* ---- 终端用的交互解释器 / 脚本执行 ---- */

    /** 执行一次交互输入（终端 py> 模式）：{"more":true} / {"out","err"} / {"exit":true}。 */
    @JavascriptInterface
    public String pyRepl(String code, String cwd) {
        return py2("replJson", code, cwd);
    }

    /** python <file> [args]：真解释器执行脚本，返回 {code,out,err}。 */
    @JavascriptInterface
    public String pyExecFile(String path, String argvJson, String cwd) {
        return py3("execFileJson", path, argvJson == null ? "[]" : argvJson, cwd);
    }

    /** python -c '<code>'。 */
    @JavascriptInterface
    public String pyExecCode(String code, String argvJson, String cwd) {
        return py3("execCodeJson", code, argvJson == null ? "[]" : argvJson, cwd);
    }

    /** 交互会话变量（终端 ƒ 面板）。 */
    @JavascriptInterface
    public String pyVars() {
        return pyZero("replVarsJson");
    }

    /* ---- 反射调用 PyBridge（签名：3 参 / 2 参 / 1 参 / 0 参 + Context 结尾） ---- */

    private static String jsonErr(Throwable e) {
        try {
            return new JSONObject().put("ok", false)
                    .put("err", e.getClass().getSimpleName() + ": " + e.getMessage()).toString();
        } catch (Throwable ignore) {
            return "{\"ok\":false,\"err\":\"reflect-failed\"}";
        }
    }

    private String pyInvoke(String method, Class<?>[] types, Object[] args) {
        try {
            Class<?> c = Class.forName("com.rou.parser.PyBridge");
            java.lang.reflect.Method m = c.getMethod(method, types);
            Object r = m.invoke(null, args);
            return r == null ? "{\"ok\":false,\"err\":\"null-result\"}" : r.toString();
        } catch (ClassNotFoundException e) {
            return "{\"ok\":false,\"err\":\"python-not-linked\"}";
        } catch (Throwable e) {
            return jsonErr(e);
        }
    }

    private String py3(String method, String a, String b, String c) {
        return pyInvoke(method,
                new Class<?>[]{String.class, String.class, String.class, Context.class},
                new Object[]{a, b, c, act.getApplicationContext()});
    }

    private String py2(String method, String a, String b) {
        return pyInvoke(method,
                new Class<?>[]{String.class, String.class, Context.class},
                new Object[]{a, b, act.getApplicationContext()});
    }

    private String py1s(String method, String a) {
        return pyInvoke(method,
                new Class<?>[]{String.class, Context.class},
                new Object[]{a, act.getApplicationContext()});
    }

    private String pyZero(String method) {
        return pyInvoke(method,
                new Class<?>[]{Context.class},
                new Object[]{act.getApplicationContext()});
    }

    private String pyCall(String method, String arg) {
        try {
            Class<?> c = Class.forName("com.rou.parser.PyBridge");
            java.lang.reflect.Method m = null;
            Object r;
            Context ctx = act.getApplicationContext();
            try {
                /* 主签名：(String, Context) —— evalJson(code, ctx) */
                m = c.getMethod(method, String.class, Context.class);
                r = m.invoke(null, arg, ctx);
            } catch (NoSuchMethodException nsme) {
                /* 兼容：(Context) —— versionJson(ctx) */
                m = c.getMethod(method, Context.class);
                r = m.invoke(null, ctx);
            }
            return r == null ? "{\"ok\":false,\"err\":\"null-result\"}" : r.toString();
        } catch (ClassNotFoundException e) {
            return "{\"ok\":false,\"err\":\"python-not-linked\"}";
        } catch (Throwable e) {
            try {
                return new JSONObject().put("ok", false)
                        .put("err", e.getClass().getSimpleName() + ": " + e.getMessage()).toString();
            } catch (Throwable ignore) {
                return "{\"ok\":false,\"err\":\"reflect-failed\"}";
            }
        }
    }

    /* ---------------- 页面状态 ---------------- */

    /** 屏幕方向：0=竖屏锁定，1=横屏，2=跟随系统（播放器全屏用）。 */
    @JavascriptInterface
    public void orient(int mode) {
        try {
            act.applyOrientation(mode);
        } catch (Throwable e) {
            Log.e(TAG, "orient 异常: " + e);
        }
    }

    /** 页面栈深度（>0 时返回键先交给页面）。 */
    @JavascriptInterface
    public void depth(int n) {
        try {
            act.setDepth(n);
        } catch (Throwable e) {
            Log.e(TAG, "depth 异常: " + e);
        }
    }

    /** 启动完成：把版本/设备信息回给 JS（window.__nativeInfo）。 */
    @JavascriptInterface
    public void ready() {
        try {
            final WebView w = web;
            if (w == null) return;
            String ver = "1.0";
            try {
                PackageInfo pi = act.getPackageManager().getPackageInfo(act.getPackageName(), 0);
                ver = pi.versionName == null ? String.valueOf(pi.versionCode) : pi.versionName;
            } catch (Throwable ignore) { }
            String info = "{v:" + JSONObject.quote(ver)
                    + ",sdk:" + Build.VERSION.SDK_INT
                    + ",model:" + JSONObject.quote(Build.MODEL == null ? "" : Build.MODEL)
                    + ",brand:" + JSONObject.quote(Build.BRAND == null ? "" : Build.BRAND)
                    + ",pkg:" + JSONObject.quote(act.getPackageName())
                    + "}";
            w.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        w.evaluateJavascript("window.__nativeInfo=" + info + ";", null);
                    } catch (Throwable e) {
                        Log.w(TAG, "ready 回写失败: " + e);
                    }
                }
            });
            Log.i(TAG, "ready " + info);
        } catch (Throwable e) {
            Log.e(TAG, "ready 异常: " + e);
        }
    }
    @JavascriptInterface
    public String hotfixStatus() {
        return act.hotfixStatus();
    }

    @JavascriptInterface
    public String hotfixCheck() {
        act.hotfixCheck();
        return act.hotfixStatus();
    }

    @JavascriptInterface
    public String pySetConfig(String site, String json) {
        return pyInvoke("setConfigJson",
                new Class<?>[]{String.class, String.class},
                new Object[]{site, json});
    }

    @JavascriptInterface
    public String pyConfig(String site) {
        return pyInvoke("configJson",
                new Class<?>[]{String.class},
                new Object[]{site});
    }

    @JavascriptInterface
    public String pyPutFiles(String site, String json) {
        return pyInvoke("putFilesJson",
                new Class<?>[]{String.class, String.class},
                new Object[]{site, json});
    }

    @JavascriptInterface
    public String pyConfigSrc(String src) {
        return pyInvoke("configFromSourceJson", new Class<?>[]{String.class}, new Object[]{src});
    }

    @JavascriptInterface
    public String imgData(String url) {
        return NetClient.get().imageData(url);
    }

    /** 异步下载主页背景图到 filesDir/home/bg，完成后回调 window.__imgFetch(cb,json)。 */
    @JavascriptInterface
    public void imgFetch(String url, String name, String cb) {
        final WebView w = web;
        if (w == null) return;
        final String key = safeName(name);
        final String callback = cb == null ? "" : cb;
        new Thread(new Runnable() {
            @Override public void run() {
                String res;
                try {
                    File dir = new File(act.getFilesDir(), "home/bg");
                    File out = new File(dir, key + ".img");
                    res = NetClient.get().imageToFile(url, out);
                } catch (Throwable e) {
                    res = "{\"ok\":false,\"err\":\"" + e.getClass().getSimpleName() + "\"}";
                }
                final String json = res;
                w.post(new Runnable() {
                    @Override public void run() {
                        WebView v = web;
                        if (v == null) return;
                        try {
                            v.evaluateJavascript("window.__imgFetch&&window.__imgFetch(" +
                                    JSONObject.quote(callback) + "," + JSONObject.quote(json) + ")", null);
                        } catch (Throwable ignored) { }
                    }
                });
            }
        }).start();
    }

    /** 本地图片 data URL 落盘，返回 {ok,path}。 */
    @JavascriptInterface
    public String saveImageData(String name, String dataUrl) {
        try {
            int idx = dataUrl == null ? -1 : dataUrl.indexOf("base64,");
            if (idx < 0) return "{\"ok\":false,\"err\":\"bad-data\"}";
            byte[] bytes = Base64.decode(dataUrl.substring(idx + 7), Base64.DEFAULT);
            File dir = new File(act.getFilesDir(), "home/bg");
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, safeName(name) + ".img");
            FileOutputStream fos = new FileOutputStream(out);
            try { fos.write(bytes); } finally { fos.close(); }
            return "{\"ok\":true,\"path\":\"" + out.getAbsolutePath().replace("\\", "/") + "\",\"bytes\":" + bytes.length + "}";
        } catch (Throwable e) {
            return "{\"ok\":false,\"err\":\"" + e.getClass().getSimpleName() + "\"}";
        }
    }

    private static String safeName(String s) {
        String n = s == null ? "" : s.replaceAll("[^A-Za-z0-9._-]", "_");
        if (n.length() == 0) n = "bg";
        return n.length() > 60 ? n.substring(0, 60) : n;
    }

    @JavascriptInterface
    public String appInfo() {
        try {
            PackageInfo pi = act.getPackageManager().getPackageInfo(act.getPackageName(), 0);
            JSONObject o = new JSONObject();
            o.put("versionName", pi.versionName == null ? "" : pi.versionName);
            o.put("versionCode", Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode);
            o.put("packageName", act.getPackageName());
            return o.toString();
        } catch (Throwable e) {
            return "{\"versionName\":\"\",\"versionCode\":0}";
        }
    }

    @JavascriptInterface
    public String pySysPath() {
        return pyInvoke("sysPathJson", new Class<?>[]{}, new Object[]{});
    }

    @JavascriptInterface
    public void reqProxy(String id, String method, String url, String headersJson, String proxy) {
        try {
            if (id == null || url == null || url.isEmpty()) return;
            String m = (method == null || method.trim().isEmpty()) ? "GET" : method.trim();
            NetClient.get().req(web, id, m, url, headersJson, proxy);
        } catch (Throwable e) { Log.e(TAG, "reqProxy 异常: " + e); }
    }

    @JavascriptInterface
    public void updateApk(final String url) {
        try {
            if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
            final DownloadManager dm = (DownloadManager) act.getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request rq = new DownloadManager.Request(Uri.parse(url));
            rq.setTitle("JieXi 更新");
            rq.setMimeType("application/vnd.android.package-archive");
            rq.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            rq.setDestinationInExternalFilesDir(act, Environment.DIRECTORY_DOWNLOADS, "JieXi-update.apk");
            final long id = dm.enqueue(rq);
            new Thread(new Runnable() {
                @Override public void run() {
                    try {
                        for (int i = 0; i < 300; i++) {
                            Thread.sleep(2000);
                            Cursor c = dm.query(new DownloadManager.Query().setFilterById(id));
                            if (c == null) return;
                            try {
                                if (!c.moveToFirst()) return;
                                int st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                                if (st == DownloadManager.STATUS_FAILED) return;
                                if (st == DownloadManager.STATUS_SUCCESSFUL) {
                                    final Uri u = dm.getUriForDownloadedFile(id);
                                    if (u == null) return;
                                    act.runOnUiThread(new Runnable() {
                                        @Override public void run() {
                                            Intent it = new Intent(Intent.ACTION_VIEW);
                                            it.setDataAndType(u, "application/vnd.android.package-archive");
                                            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                                            act.startActivity(it);
                                        }
                                    });
                                    return;
                                }
                            } finally { c.close(); }
                        }
                    } catch (Throwable e) { Log.e(TAG, "updateApk wait: " + e); }
                }
            }, "apk-update").start();
        } catch (Throwable e) { Log.e(TAG, "updateApk: " + e); }
    }

    @JavascriptInterface
    public void openUrl(String url) {
        try {
            if (url == null || url.isEmpty()) return;
            Intent it = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            act.startActivity(it);
        } catch (Throwable e) { Log.e(TAG, "openUrl: " + e); }
    }

}
