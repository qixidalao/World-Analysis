package com.rou.parser;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.LruCache;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.net.URLDecoder;
import java.util.Locale;
import java.util.Map;

/**
 * WebView 壳：加载 assets/index.html，注册 Native 桥，处理返回键与子资源代理。
 *
 * 调试入口（只靠 intent extra 触发，无 extra 时行为与普通启动完全一致）：
 *   -e js "&lt;javascript&gt;"          页面加载完执行，结果记到 Log tag ROU_JS
 *   -e route "page?a=1&amp;b=2"        执行 App.go(page,{a:'1',b:'2'})
 *   -e net "proxy|direct|doh|both"   写 DB.cfg().net.mode 并让 Net 重新生效
 *   -e proxy "127.0.0.1:7890"       配合 -e net 设置代理地址
 */
public class MainActivity extends Activity {
    static final String TAG = "rou.parser";
    static final String TAG_JS = "ROU_JS";

    private static final int BG = 0xFF0B1116;                 // 与页面 --bg 一致
    /** onPageFinished 之后再延时，确保 boot.js 里的 Net.config(DB.netCfg()) 已经跑完，
     *  否则我们注入的网络模式会被 boot 覆盖回 direct。 */
    private static final long DBG_DELAY = 500L;

    /* 子资源（封面图等）内存缓存上限 24MB，单个最大 8MB */
    private static final int RES_CACHE_MAX = 24 * 1024 * 1024;
    private static final int RES_MAX_ENTRY = 8 * 1024 * 1024;
    private static final int RES_TIMEOUT_MS = 8000;
    /* 同一主机连续失败 2 次就熔断 60s，避免每张封面都吃满超时 */
    private static final int RES_FAIL_LIMIT = 2;
    private static final long RES_QUARANTINE_MS = 60000L;

    /* 视频分片/清单不拦截（播放走 JS 桥） */
    private static final String[] MEDIA_EXT = {
            ".ts", ".m4s", ".m3u8", ".mp4", ".aac", ".mp3", ".flac", ".webm", ".key", ".vtt"
    };

    private WebView web;
    private HotFix hotfix;
    private JsBridge bridge;
    private volatile int lastDepth = 0;
    private long lastBackAt = 0;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private final LruCache<String, NetClient.Fetched> resCache =
            new LruCache<String, NetClient.Fetched>(RES_CACHE_MAX) {
                @Override
                protected int sizeOf(String k, NetClient.Fetched v) {
                    return v == null || v.bytes == null ? 1 : v.bytes.length;
                }
            };
    private int resHit = 0, resMiss = 0;

    /** 按主机记失败次数与熔断截止时间。 */
    private static final class HostFail {
        int count;
        long until;
    }
    private final Map<String, HostFail> hostFail = new java.util.concurrent.ConcurrentHashMap<String, HostFail>();

    /* 调试 extra */
    private String dbgJs, dbgRoute, dbgNet, dbgProxy;
    private boolean dbgDone = true;      // true = 没有待执行的调试动作

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        // 全屏 + 窗口底色，避免白屏闪烁
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setBackgroundColor(BG);

        web = new WebView(this);
        web.setBackgroundColor(BG);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);      // 解除 file:// 跨域限制
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        // 页面有 <meta viewport width=device-width>，让 WebView 按 CSS 宽度铺满，不做缩放
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setUserAgentString(s.getUserAgentString() + " RouParser/1.0");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (m != null) {
                    Log.i(TAG, "CONSOLE " + m.messageLevel() + ": " + m.message()
                            + " @" + m.sourceId() + ":" + m.lineNumber());
                }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                Log.i(TAG, "页面加载完成 " + url);
                probeBridge();
                if (hotfix != null) hotfix.onPageFinished();
                runDebugActions();
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                Log.w(TAG, "加载错误 " + code + " " + desc + " " + failingUrl);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                return intercept(req);
            }
        });

        bridge = new JsBridge(this, web);
        web.addJavascriptInterface(bridge, "Native");
        hotfix = new HotFix(this, web);

        setContentView(web);
        readDebugExtras(getIntent());
        web.loadUrl("file:///android_asset/index.html");
    }

    /* ---------------- 屏幕方向（播放器横屏） ---------------- */

    /**
     * JS 桥调用：0=竖屏锁定，1=横屏，2=跟随系统。
     * 必须在 UI 线程改方向；失败只记日志，不影响播放。
     */
    void applyOrientation(int mode) {
        final int o;
        if (mode == 1) o = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
        else if (mode == 2) o = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        else o = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    setRequestedOrientation(o);
                    Log.i(TAG, "orientation -> " + o);
                } catch (Throwable e) {
                    Log.w(TAG, "orientation 失败: " + e);
                }
            }
        });
    }

    /* ---------------- 返回键 ---------------- */

    @Override
    @Deprecated
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        final WebView w = web;
        if (w == null) {
            backToSystem();
            return;
        }
        try {
            w.evaluateJavascript("window.__back&&window.__back()", new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if ("true".equals(value)) return;
                    // 页面栈已经到底：非主页先回主页
                    w.evaluateJavascript("window.__backRoot&&window.__backRoot()", new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value2) {
                            if ("true".equals(value2)) return;
                            // 已在主页：2 秒内再按一次才退出
                            long now = System.currentTimeMillis();
                            if (now - lastBackAt <= 2000) {
                                lastBackAt = 0;
                                backToSystem();
                            } else {
                                lastBackAt = now;
                                try {
                                    android.widget.Toast.makeText(MainActivity.this,
                                            "再按一次退出", android.widget.Toast.LENGTH_SHORT).show();
                                } catch (Throwable ignore) { }
                            }
                        }
                    });
                }
            });
        } catch (Throwable e) {
            backToSystem();
        }
    }

    /** 系统返回（根层：退出 Activity）。 */
    @SuppressWarnings("deprecation")
    private void backToSystem() {
        try { super.onBackPressed(); } catch (Throwable e) { finish(); }
    }

    /* ---------------- 生命周期 ---------------- */

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // 已在跑时再来一次 am start：补跑调试动作
        if (readDebugExtras(intent) && web != null) runDebugActions();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();      // 注意：不调 pauseTimers()，否则 hls 冻结
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        Log.i(TAG, "退出：子资源缓存 hit=" + resHit + " miss=" + resMiss);
        try { if (bridge != null) bridge.detach(); } catch (Throwable ignore) { }
        try { NetClient.get().cancelAll(); } catch (Throwable ignore) { }
        if (web != null) {
            try {
                web.removeJavascriptInterface("Native");
                web.stopLoading();
                web.loadUrl("about:blank");
                web.clearHistory();
                web.removeAllViews();
                web.destroy();
            } catch (Throwable ignore) { }
            web = null;
        }
        super.onDestroy();
    }

    /* ---------------- 供 JsBridge 用 ---------------- */

    void setDepth(int n) { lastDepth = n; }

    int getDepth() { return lastDepth; }

    /* ---------------- 子资源拦截（封面图等） ---------------- */

    private WebResourceResponse intercept(WebResourceRequest req) {
        try {
            if (req == null) return null;
            Uri u = req.getUrl();
            if (u == null) return null;
            String scheme = u.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return null;
            String method = req.getMethod();
            if (method != null && !"GET".equalsIgnoreCase(method)) return null;
            if (!NetClient.get().isImgProxy()) return null;

            String url = u.toString();
            String low = url.toLowerCase(Locale.US);
            if (isMediaLike(low, req)) return null;          // 视频分片/清单交给 JS 层

            NetClient.Fetched hit = resCache.get(url);
            if (hit != null) {
                resHit++;
                logResStats();
                return toResponse(hit);
            }
            String host = u.getHost() == null ? "" : u.getHost();
            if (isQuarantined(host)) return null;            // 该主机刚失败过，直接让 WebView 自己试

            String headers = headersJsonFor(req, url);
            NetClient.Fetched f = NetClient.get().fetchSync(url, headers, RES_TIMEOUT_MS, RES_MAX_ENTRY);
            if (f == null) {
                markFail(host);
                return null;                                 // 失败就让 WebView 自己试
            }
            clearFail(host);
            resCache.put(url, f);
            resMiss++;
            logResStats();
            return toResponse(f);
        } catch (Throwable e) {
            Log.w(TAG, "拦截异常: " + e);
            return null;
        }
    }

    private boolean isQuarantined(String host) {
        HostFail hf = hostFail.get(host);
        return hf != null && hf.until > System.currentTimeMillis();
    }

    private void markFail(String host) {
        HostFail hf = hostFail.get(host);
        if (hf == null) {
            hf = new HostFail();
            hostFail.put(host, hf);
        }
        synchronized (hf) {
            hf.count++;
            if (hf.count >= RES_FAIL_LIMIT) {
                hf.until = System.currentTimeMillis() + RES_QUARANTINE_MS;
                hf.count = 0;
                Log.w(TAG, "子资源熔断 60s: " + host);
            }
        }
    }

    private void clearFail(String host) {
        HostFail hf = hostFail.get(host);
        if (hf != null) {
            synchronized (hf) { hf.count = 0; hf.until = 0; }
        }
    }

    private static WebResourceResponse toResponse(NetClient.Fetched f) {
        String mime = (f.mime == null || f.mime.isEmpty()) ? "application/octet-stream" : f.mime;
        String enc = mime.startsWith("text/") ? "utf-8" : null;
        return new WebResourceResponse(mime, enc, new ByteArrayInputStream(f.bytes));
    }

    private void logResStats() {
        int n = resHit + resMiss;
        if (n % 25 == 0) {
            Log.i(TAG, "子资源 请求=" + n + " 命中=" + resHit + " 回源=" + resMiss
                    + " 缓存=" + resCache.size() + "/" + RES_CACHE_MAX + "B");
        }
    }

    /** 视频分片/清单不拦：扩展名、/hls/ 路径、Accept 头三条任一命中即放行。 */
    private static boolean isMediaLike(String lowUrl, WebResourceRequest req) {
        String u = lowUrl;
        int q = u.indexOf('?');
        if (q >= 0) u = u.substring(0, q);
        for (String ext : MEDIA_EXT) if (u.endsWith(ext)) return true;
        if (u.contains("/hls/")) return true;
        try {
            Map<String, String> h = req.getRequestHeaders();
            if (h != null) {
                for (Map.Entry<String, String> e : h.entrySet()) {
                    if (!"accept".equalsIgnoreCase(e.getKey())) continue;
                    String a = e.getValue() == null ? "" : e.getValue().toLowerCase(Locale.US);
                    if (a.startsWith("video/") || a.contains("mpegurl")) return true;
                }
            }
        } catch (Throwable ignore) { }
        return false;
    }

    /** 把 WebView 给的请求头转成 JSON（去掉不能让 OkHttp 处理的几个）。 */
    private static String headersJsonFor(WebResourceRequest req, String url) {
        JSONObject h = new JSONObject();
        try {
            Map<String, String> in = req.getRequestHeaders();
            if (in != null) {
                for (Map.Entry<String, String> e : in.entrySet()) {
                    String k = e.getKey(), val = e.getValue();
                    if (k == null || val == null) continue;
                    String lk = k.toLowerCase(Locale.US);
                    if (lk.equals("host") || lk.equals("connection") || lk.equals("accept-encoding")
                            || lk.equals("content-length") || lk.equals("range")) continue;
                    if (lk.equals("referer") && val.startsWith("file:")) continue;
                    try { h.put(k, val); } catch (Throwable ignore) { }
                }
            }
            if (h.length() == 0 || !h.has("Referer")) {
                // file:// 页面没有站点 Referer，图片 CDN 常校验，用目标站点自身兜一下
                Uri u = Uri.parse(url);
                if (u.getHost() != null) {
                    h.put("Referer", u.getScheme() + "://" + u.getHost() + "/");
                }
            }
        } catch (Throwable ignore) { }
        return h.toString();
    }

    /* ---------------- 调试入口 ---------------- */

    /** 读 intent extra；返回是否带调试动作。无 extra 时什么都不做。 */
    private boolean readDebugExtras(Intent it) {
        if (it == null) return false;
        try {
            String js = val(it.getStringExtra("js"));
            String route = val(it.getStringExtra("route"));
            String net = val(it.getStringExtra("net"));
            String proxy = val(it.getStringExtra("proxy"));
            if (js == null && route == null && net == null && proxy == null) return false;
            dbgJs = js;
            dbgRoute = route;
            dbgNet = net;
            dbgProxy = proxy;
            dbgDone = false;
            Log.i(TAG, "调试参数 route=" + route + " net=" + net + " proxy=" + proxy
                    + " js=" + (js == null ? "-" : js.length() + " 字符"));
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "调试参数读取失败: " + e);
            return false;
        }
    }

    /**
     * extra 值支持 "b64:<base64>" 前缀（避免 adb shell 的引号/空格/& 转义问题），
     * 也兼容直接给明文。
     */
    private static String val(String s) {
        if (s == null) return null;
        s = s.trim();
        if (!s.startsWith("b64:")) return s;
        try {
            String b = s.substring(4).replaceAll("\\s", "");
            b = b.replace('-', '+').replace('_', '/');       // 兼容 url-safe base64
            int pad = b.length() % 4;
            if (pad == 2) b = b + "==";
            else if (pad == 3) b = b + "=";
            return new String(Base64.decode(b, Base64.DEFAULT), "UTF-8");
        } catch (Throwable e) {
            Log.w(TAG, "b64 extra 解码失败（长度 " + s.length() + "）: " + e);
            return null;
        }
    }

    /** onPageFinished 之后延时执行：先网络模式，再路由，最后任意 js。 */
    private void runDebugActions() {
        if (dbgDone) return;
        dbgDone = true;
        long t = DBG_DELAY;
        if (dbgNet != null && !dbgNet.isEmpty()) {
            evalLater(buildNetJs(dbgNet.trim(), dbgProxy), t);
            t += 300;
        }
        if (dbgRoute != null && !dbgRoute.isEmpty()) {
            evalLater(buildRouteJs(dbgRoute.trim()), t);
            t += 300;
        }
        if (dbgJs != null && !dbgJs.isEmpty()) {
            evalLater(dbgJs, t);
        }
    }

    private void evalLater(final String js, long delay) {
        final WebView w = web;
        if (w == null || js == null) return;
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    w.evaluateJavascript(js, new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            Log.i(TAG_JS, "结果 " + value);
                        }
                    });
                } catch (Throwable e) {
                    Log.w(TAG, "调试 JS 执行失败: " + e);
                }
            }
        }, delay);
    }

    /** -e net / -e proxy → 写 DB.cfg().net 并让 Net 生效（1.5s 后再断言一次，防被 boot 覆盖）。 */
    private static String buildNetJs(String mode, String proxy) {
        StringBuilder sb = new StringBuilder();
        sb.append("(function(){try{var n=DB.cfg().net||{};n.mode=").append(JSONObject.quote(mode)).append(";");
        if (proxy != null && !proxy.trim().isEmpty()) {
            sb.append("n.proxy=").append(JSONObject.quote(proxy.trim())).append(";");
        }
        sb.append("DB.setCfg({net:n});Net.config(DB.netCfg());")
                // boot.js 若晚一步跑，会用旧配置覆盖；这里再断言一次
                .append("setTimeout(function(){try{var c=DB.cfg().net||{};c.mode=")
                .append(JSONObject.quote(mode)).append(";");
        if (proxy != null && !proxy.trim().isEmpty()) {
            sb.append("c.proxy=").append(JSONObject.quote(proxy.trim())).append(";");
        }
        sb.append("DB.setCfg({net:c});Net.config(DB.netCfg());")
                .append("console.log('NETCFG 复核 '+DB.netCfg().mode+' '+(DB.netCfg().proxy||'-'));")
                .append("}catch(e){}},1500);")
                .append("return 'net='+DB.netCfg().mode+' proxy='+(DB.netCfg().proxy||'-');")
                .append("}catch(e){return 'ERR '+e}})()");
        return sb.toString();
    }

    /** -e route "page?a=1&b=2" → App.go(page, {a:'1',b:'2'})。 */
    private static String buildRouteJs(String route) {
        String page = route;
        String qs = "";
        int q = route.indexOf('?');
        if (q >= 0) {
            page = route.substring(0, q);
            qs = route.substring(q + 1);
        }
        JSONObject params = new JSONObject();
        if (!qs.isEmpty()) {
            for (String kv : qs.split("&")) {
                if (kv.isEmpty()) continue;
                int e = kv.indexOf('=');
                String k = e < 0 ? kv : kv.substring(0, e);
                String v = e < 0 ? "" : kv.substring(e + 1);
                try {
                    k = URLDecoder.decode(k, "UTF-8");
                    v = URLDecoder.decode(v, "UTF-8");
                } catch (Throwable ignore) { }
                try { params.put(k, v); } catch (Throwable ignore) { }
            }
        }
        return "(function(){try{"
                + "var page=" + JSONObject.quote(page) + ",params=" + params.toString() + ";"
                // Tab 根页面（home/browse/fav/mine）注册在 App.tabs，必须先判 Tab，否则会打 "no page"
                + "if(App.TABS&&App.TABS.indexOf(page)>=0){App.setTab(page);}"
                + "else if(App.pages&&App.pages[page]){App.go(page,params);}"
                + "else{return 'ERR 没有页面 '+page;}"
                + "return 'route '+page+' params='+JSON.stringify(params);"
                + "}catch(e){return 'ERR '+e}})()";
    }

    /** 每次页面加载完把桥状态记一行日志，便于排查。 */
    private void probeBridge() {
        final WebView w = web;
        if (w == null) return;
        try {
            w.evaluateJavascript("(function(){try{"
                    + "var pages=(typeof App!=='undefined')?Object.keys(App.pages||{}).length:-1;"
                    + "var tab=(typeof App!=='undefined')?App.tab:'-';"
                    + "return 'Native='+(typeof window.Native)"
                    + "+' keys='+(window.Native?Object.keys(window.Native).sort().join(','):'-')"
                    + "+' netCb='+(typeof window.__netCb)+' depth='+window.__depth"
                    + "+' pages='+pages+' tab='+tab"
                    + "+' vw='+window.innerWidth+'x'+window.innerHeight+' dpr='+window.devicePixelRatio;"
                    + "}catch(e){return 'ERR '+e}})()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            Log.i(TAG, "BRIDGE " + value);
                        }
                    });
        } catch (Throwable e) {
            Log.w(TAG, "桥探测失败: " + e);
        }
    }
    String hotfixStatus() {
        return hotfix == null ? "{}" : hotfix.statusJson();
    }

    void hotfixCheck() {
        if (hotfix != null) hotfix.checkAsync();
    }

}
