package com.rou.parser;

import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.Authenticator;
import okhttp3.Call;
import okhttp3.Credentials;
import okhttp3.Dns;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.Route;

/**
 * 网络层：OkHttp 单例 + 可选 DoH / HTTP 代理。
 *
 * 模式（JS 通过 Native.cfg 设置）：
 *   direct  直连（系统 DNS）
 *   doh     直连 + 自定义 Dns（阿里/腾讯/CF 的 JSON DoH 端点）
 *   proxy   直连 + HTTP 代理（支持 user:pass@host:port）
 *   both    代理 + DoH（双保险；有代理时目标域名由代理解析，DoH 只用于直连场景）
 *
 * 线程：所有请求跑在固定 4 线程池里；回调 webView.post() 回 WebView 线程。
 * 异常一律转成 {"err":"..."}，不往 JS 抛。
 */
public final class NetClient {
    private static final String TAG = MainActivity.TAG;
    private static final long DOH_TTL_MS = 10 * 60 * 1000L;   // DoH 结果缓存 10 分钟
    private static final int DEFAULT_TIMEOUT_S = 20;

    /* 判定为二进制的 URL 后缀（其余看 Content-Type） */
    private static final String[] BIN_EXT = {
            ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".avif", ".bmp",
            ".ts", ".mp4", ".m4s", ".m3u8", ".mp3", ".aac", ".flac", ".bin",
            ".zip", ".apk", ".woff2", ".ttf", ".pdf"
    };

    private static volatile NetClient inst;

    public static NetClient get() {
        NetClient n = inst;
        if (n == null) {
            synchronized (NetClient.class) {
                n = inst;
                if (n == null) { n = new NetClient(); inst = n; }
            }
        }
        return n;
    }

    /* ---------------- 配置 ---------------- */
    private volatile String mode = "direct";
    private volatile String proxyStr = "";
    private volatile String dohUrl = "https://223.5.5.5/resolve";
    private volatile String defaultUa = "";
    private volatile int timeoutSec = DEFAULT_TIMEOUT_S;
    private volatile boolean imgProxy = true;        // 是否用本层代理 WebView 子资源（封面图等）

    /* ---------------- 运行态 ---------------- */
    private final OkHttpClient base;                 // 基础客户端：默认 DNS，不带代理
    private volatile OkHttpClient client;            // 实际使用（按配置派生）
    private final ExecutorService pool;              // 固定 4 线程
    private final Set<Call> active = new CopyOnWriteArraySet<Call>();
    private DohDns dohDns;                            // 复用 DoH 缓存
    private String dohDnsEndpoint;

    private NetClient() {
        base = new OkHttpClient.Builder()
                .connectTimeout(DEFAULT_TIMEOUT_S, TimeUnit.SECONDS)
                .readTimeout(DEFAULT_TIMEOUT_S, TimeUnit.SECONDS)
                .writeTimeout(DEFAULT_TIMEOUT_S, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .followRedirects(true)
                .followSslRedirects(true)
                .build();
        client = base;
        pool = Executors.newFixedThreadPool(4, new java.util.concurrent.ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "rou-net");
                t.setDaemon(true);
                return t;
            }
        });
    }

    /* ---------------- 配置应用（Native.cfg） ---------------- */

    /** 解析 JS 传来的 {mode,proxy,doh,timeout,ua} 并重建客户端。 */
    public synchronized void apply(String json) {
        try {
            JSONObject o = new JSONObject(json == null ? "{}" : json);
            String m = o.optString("mode", mode);
            if (m == null || m.isEmpty()) m = "direct";
            m = m.toLowerCase(Locale.US);
            if (!"direct".equals(m) && !"doh".equals(m) && !"proxy".equals(m) && !"both".equals(m)) {
                Log.w(TAG, "未知网络模式 " + m + "，按 direct 处理");
                m = "direct";
            }
            mode = m;
            proxyStr = o.optString("proxy", "").trim();
            String d = o.optString("doh", "").trim();
            if (!d.isEmpty()) dohUrl = d;
            defaultUa = o.optString("ua", "");
            imgProxy = o.optBoolean("imgProxy", imgProxy);
            int t = o.optInt("timeout", timeoutSec);
            timeoutSec = Math.max(5, Math.min(60, t));
            rebuild();
            Log.i(TAG, "cfg mode=" + mode + " proxy=" + (proxyStr.isEmpty() ? "-" : proxyStr)
                    + " doh=" + dohUrl + " timeout=" + timeoutSec + "s imgProxy=" + imgProxy);
        } catch (Throwable e) {
            Log.e(TAG, "cfg 解析失败: " + e);
        }
    }

    /** 按当前配置从 base 派生客户端（复用连接池 / 调度器）。 */
    private void rebuild() {
        OkHttpClient.Builder b = base.newBuilder()
                .connectTimeout(timeoutSec, TimeUnit.SECONDS)
                .readTimeout(timeoutSec, TimeUnit.SECONDS)
                .writeTimeout(timeoutSec, TimeUnit.SECONDS);

        boolean useDoh = "doh".equals(mode) || "both".equals(mode);
        boolean useProxy = "proxy".equals(mode) || "both".equals(mode);

        if (useDoh) {
            if (dohDns == null || !dohUrl.equals(dohDnsEndpoint)) {
                dohDns = new DohDns(dohUrl);
                dohDnsEndpoint = dohUrl;
            }
            b.dns(dohDns);
        } else {
            b.dns(Dns.SYSTEM);
        }

        ProxyCfg p = useProxy ? parseProxy(proxyStr) : null;
        if (p != null) {
            b.proxy(p.proxy);
            if (p.user != null) {
                b.proxyAuthenticator(buildProxyAuth(p.user, p.pass));
            }
        }
        client = b.build();
    }

    private OkHttpClient clientForProxy(String proxy) {
        if (proxy == null || proxy.trim().isEmpty()) return client;
        OkHttpClient.Builder b = base.newBuilder()
                .connectTimeout(timeoutSec, TimeUnit.SECONDS)
                .readTimeout(timeoutSec, TimeUnit.SECONDS)
                .writeTimeout(timeoutSec, TimeUnit.SECONDS);
        ProxyCfg p = parseProxy(proxy.trim());
        if (p != null) {
            b.proxy(p.proxy);
            if (p.user != null) b.proxyAuthenticator(buildProxyAuth(p.user, p.pass));
        }
        return b.build();
    }

    private static Authenticator buildProxyAuth(final String user, final String pass) {
        return new Authenticator() {
            @Override
            public Request authenticate(Route route, Response response) throws IOException {
                if (response.request().header("Proxy-Authorization") != null) return null; // 已试过，别死循环
                String cred = Credentials.basic(user, pass == null ? "" : pass);
                return response.request().newBuilder().header("Proxy-Authorization", cred).build();
            }
        };
    }

    /* ---------------- 代理解析 ---------------- */

    private static final class ProxyCfg {
        Proxy proxy;
        String user;
        String pass;
    }

    /** 支持 127.0.0.1:7890 / http://127.0.0.1:7890 / user:pass@host:port */
    private static ProxyCfg parseProxy(String s) {
        if (s == null) return null;
        s = s.trim();
        if (s.isEmpty()) return null;
        String user = null, pass = null;
        String hostPort = s;
        int at = s.lastIndexOf('@');
        if (at >= 0) {
            String auth = s.substring(0, at);
            hostPort = s.substring(at + 1);
            int c = auth.indexOf(':');
            if (c >= 0) { user = auth.substring(0, c); pass = auth.substring(c + 1); }
            else user = auth;
        }
        String low = hostPort.toLowerCase(Locale.US);
        if (low.startsWith("http://")) hostPort = hostPort.substring(7);
        else if (low.startsWith("https://")) hostPort = hostPort.substring(8);
        else if (low.startsWith("socks5://") || low.startsWith("socks://")) {
            // 只支持 HTTP CONNECT 代理；socks 走系统不现实，退化成直连并提示
            Log.w(TAG, "不支持 socks 代理: " + s);
            return null;
        }
        int slash = hostPort.indexOf('/');
        if (slash >= 0) hostPort = hostPort.substring(0, slash);

        String host;
        int port = 7890;
        int c = hostPort.lastIndexOf(':');
        if (c > 0) {
            host = hostPort.substring(0, c);
            try { port = Integer.parseInt(hostPort.substring(c + 1).trim()); }
            catch (Exception e) { Log.w(TAG, "代理端口解析失败，按 7890: " + hostPort); }
        } else {
            host = hostPort;
        }
        if (host.isEmpty()) return null;
        InetSocketAddress addr;
        try {
            addr = new InetSocketAddress(host, port);       // 本机/局域网一般能立刻解析
        } catch (Throwable e) {
            addr = InetSocketAddress.createUnresolved(host, port);
        }
        if (addr.isUnresolved()) Log.w(TAG, "代理地址未解析: " + host + ":" + port);
        ProxyCfg p = new ProxyCfg();
        p.proxy = new Proxy(Proxy.Type.HTTP, addr);
        p.user = user;
        p.pass = pass;
        return p;
    }

    /* ---------------- 请求入口 ---------------- */

    /**
     * 发起请求（异步）。完成后回调 window.__netCb(id, json)。
     * headersJson: JSON 对象，任意键直接当请求头。
     */
    public void req(final WebView web, final String id, final String method, final String url,
                    final String headersJson) {
        req(web, id, method, url, headersJson, null);
    }

    public void req(final WebView web, final String id, final String method, final String url,
                    final String headersJson, final String proxy) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                long t0 = System.currentTimeMillis();
                String json;
                int status = 0;
                long bytesLen = 0;
                try {
                    JSONObject out = doRequest(method, url, headersJson, t0, proxy);
                    status = out.optInt("status", 0);
                    bytesLen = out.has("b64") ? out.optString("b64", "").length() : out.optString("txt", "").length();
                    json = out.toString();
                } catch (Throwable e) {
                    json = errJson(e, t0);
                }
                long ms = System.currentTimeMillis() - t0;
                Log.i(TAG, "net " + (method == null ? "GET" : method) + " " + url
                        + " -> " + (status > 0 ? String.valueOf(status) : "ERR")
                        + " " + bytesLen + "B " + ms + "ms  id=" + id);
                callback(web, id, json);
            }
        });
    }

    private JSONObject doRequest(String method, String url, String headersJson, long t0) throws Exception {
        return doRequest(method, url, headersJson, t0, null);
    }

    private JSONObject doRequest(String method, String url, String headersJson, long t0, String proxy) throws Exception {
        Request.Builder rb = new Request.Builder();
        try {
            rb.url(url);
        } catch (IllegalArgumentException e) {
            throw new IOException("URL 无效: " + url);
        }

        boolean hasUa = applyHeaders(rb, headersJson);

        String m = method == null ? "GET" : method.trim().toUpperCase(Locale.US);
        if ("POST".equals(m)) rb.post(RequestBody.create(null, new byte[0]));   // 空 body
        else if ("HEAD".equals(m)) rb.head();
        else if ("PUT".equals(m)) rb.put(RequestBody.create(null, new byte[0]));
        else rb.get();

        Call call = clientForProxy(proxy).newCall(rb.build());
        active.add(call);
        try {
            Response resp = call.execute();
            try {
                String finalUrl = resp.request().url().toString();
                int code = resp.code();
                ResponseBody body = resp.body();
                byte[] bytes = body != null ? body.bytes() : new byte[0];
                MediaType mt = body != null ? body.contentType() : null;
                String ctype = resp.header("Content-Type");

                JSONObject out = new JSONObject();
                out.put("status", code);
                out.put("url", finalUrl);
                out.put("ms", System.currentTimeMillis() - t0);
                String ct = ctype != null ? ctype : (mt != null ? mt.toString() : "");
                if (isBinary(finalUrl, ct, bytes)) {
                    out.put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                } else {
                    out.put("txt", decodeText(bytes, mt));
                }
                return out;
            } finally {
                resp.close();
            }
        } finally {
            active.remove(call);
        }
    }

    /** 把 headersJson 里的键值按原样设成请求头；返回是否已带 User-Agent。 */
    private boolean applyHeaders(Request.Builder rb, String headersJson) {
        boolean hasUa = false;
        if (headersJson != null && !headersJson.isEmpty()) {
            try {
                JSONObject h = new JSONObject(headersJson);
                java.util.Iterator<String> it = h.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    String v = h.optString(k, null);
                    if (k == null || k.isEmpty() || v == null) continue;
                    v = v.replace("\r", "").replace("\n", "");   // 头里不许换行
                    try { rb.header(k, v); } catch (Throwable e) { rb.addHeader(k, v); }
                    if ("user-agent".equalsIgnoreCase(k)) hasUa = true;
                }
            } catch (Throwable e) {
                Log.w(TAG, "headers 解析失败: " + e);
            }
        }
        if (!hasUa && defaultUa != null && !defaultUa.isEmpty()) {
            rb.header("User-Agent", defaultUa);
        }
        return hasUa;
    }

    /** 回调到 WebView 线程；jsStr 用 JSONObject.quote 转义。 */
    private void callback(final WebView web, final String id, final String json) {
        if (web == null) return;
        final String js = "window.__netCb(" + JSONObject.quote(id == null ? "" : id) + ","
                + JSONObject.quote(json == null ? "{}" : json) + ")";
        try {
            web.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        web.evaluateJavascript(js, null);
                    } catch (Throwable e) {
                        Log.w(TAG, "回调 JS 失败: " + e);
                    }
                }
            });
        } catch (Throwable e) {
            Log.w(TAG, "web.post 失败: " + e);
        }
    }

    private static String errJson(Throwable e, long t0) {
        String msg;
        if (e instanceof UnknownHostException) msg = "域名解析失败: " + e.getMessage();
        else if (e instanceof java.net.SocketTimeoutException) msg = "超时: " + e.getMessage();
        else if (e instanceof java.net.ConnectException) msg = "连接失败: " + e.getMessage();
        else if (e instanceof javax.net.ssl.SSLException) msg = "TLS 失败: " + e.getMessage();
        else if (e instanceof IOException) msg = "网络错误: " + e.getMessage();
        else msg = e.getClass().getSimpleName() + ": " + e.getMessage();
        try {
            JSONObject o = new JSONObject();
            o.put("err", msg == null ? "未知错误" : msg);
            o.put("ms", System.currentTimeMillis() - t0);
            return o.toString();
        } catch (Throwable ignore) {
            return "{\"err\":\"未知错误\"}";
        }
    }

    /* ---------------- 响应判定 / 解码 ---------------- */

    private static boolean isBinary(String url, String ctype, byte[] bytes) {
        String u = url == null ? "" : url.toLowerCase(Locale.US);
        int q = u.indexOf('?');
        if (q >= 0) u = u.substring(0, q);
        int h = u.indexOf('#');
        if (h >= 0) u = u.substring(0, h);
        for (String ext : BIN_EXT) if (u.endsWith(ext)) return true;

        String ct = ctype == null ? "" : ctype.toLowerCase(Locale.US).trim();
        if (ct.isEmpty()) return looksBinary(bytes);   // 没有 Content-Type：嗅探
        if (ct.startsWith("text/")) return false;
        if (ct.contains("json") || ct.contains("xml") || ct.contains("javascript")
                || ct.contains("ecmascript") || ct.contains("x-www-form-urlencoded")) return false;
        return true;
    }

    /** 粗嗅探：前 1KB 里有 NUL 就当二进制。 */
    private static boolean looksBinary(byte[] b) {
        if (b == null) return false;
        int n = Math.min(b.length, 1024);
        for (int i = 0; i < n; i++) if (b[i] == 0) return true;
        return false;
    }

    /** 按 Content-Type charset 解码（默认 UTF-8；gbk/gb2312 → GBK；无 charset 时试探）。 */
    private static String decodeText(byte[] b, MediaType mt) {
        if (b == null || b.length == 0) return "";
        Charset cs = null;
        if (mt != null) {
            try {
                cs = mt.charset(null);
            } catch (Throwable ignore) { }
        }
        if (cs != null) {
            try { return new String(b, cs); } catch (Throwable ignore) { }
        }
        // 没给 charset：先按 UTF-8 严格解，非法再退 GBK（中文站点常见）
        try {
            Charset utf8 = Charset.forName("UTF-8");
            String s = new String(b, utf8);
            if (!containsReplacement(b, s)) return s;
        } catch (Throwable ignore) { }
        try {
            return new String(b, Charset.forName("GBK"));
        } catch (Throwable ignore) {
            return new String(b, Charset.forName("UTF-8"));
        }
    }

    /** UTF-8 严格解码是否会出替换符（用于 charset 缺失时的兜底判断）。 */
    private static boolean containsReplacement(byte[] b, String s) {
        if (s.indexOf('\uFFFD') >= 0) return true;
        try {
            java.nio.charset.CharsetDecoder dec = Charset.forName("UTF-8")
                    .newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT);
            dec.decode(java.nio.ByteBuffer.wrap(b));
            return false;
        } catch (Throwable e) {
            return true;
        }
    }

    /* ---------------- 子资源同步抓取（WebView shouldInterceptRequest 用） ---------------- */

    /** 同步抓取结果（给 WebViewClient 用）。 */
    public static final class Fetched {
        public final byte[] bytes;
        public final String mime;
        Fetched(byte[] b, String m) { bytes = b; mime = m; }
    }

    public boolean isImgProxy() { return imgProxy; }

    /**
     * 同步抓一个子资源（封面图/字体/css）。只应在 IO 线程调用。
     * 走当前 proxy/doh 配置，超时 timeoutMs；失败或超过 maxBytes 返回 null。
     */
    public Fetched fetchSync(String url, String headersJson, int timeoutMs, int maxBytes) {
        if (url == null) return null;
        OkHttpClient c = client.newBuilder()
                .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build();
        Call call = null;
        try {
            Request.Builder rb = new Request.Builder();
            rb.url(url);
            applyHeaders(rb, headersJson);
            rb.get();
            call = c.newCall(rb.build());
            Response resp = call.execute();
            try {
                if (resp.code() < 200 || resp.code() >= 300) {
                    Log.w(TAG, "子资源 HTTP " + resp.code() + " " + url);
                    return null;
                }
                ResponseBody body = resp.body();
                if (body == null) return null;
                long len = body.contentLength();
                if (len > maxBytes) {
                    Log.w(TAG, "子资源过大 " + len + "B，交给 WebView: " + url);
                    return null;
                }
                byte[] bytes = body.bytes();
                if (bytes.length == 0) return null;
                if (bytes.length > maxBytes) {
                    Log.w(TAG, "子资源过大 " + bytes.length + "B，交给 WebView: " + url);
                    return null;
                }
                return new Fetched(bytes, mimeOf(url, resp.header("Content-Type")));
            } finally {
                resp.close();
            }
        } catch (Throwable e) {
            Log.w(TAG, "子资源抓取失败 " + url + ": " + e);
            return null;
        } finally {
            if (call != null) { try { call.cancel(); } catch (Throwable ignore) { } }
        }
    }

    /** 下载进度回调（字节数）。 */
    public interface Progress {
        void onProgress(long got, long total);
    }

    /**
     * 流式下载到文件（pip 装 wheel 用）。走当前 proxy/DoH 配置，边下边写，不占大内存。
     * 失败/超限返回 false 并删掉残文件。
     */
    public boolean downloadToFile(String url, String headersJson, int timeoutMs, long maxBytes,
                                  File dest, Progress cb) {
        if (url == null || dest == null) return false;
        OkHttpClient c = client.newBuilder()
                .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build();
        Call call = null;
        FileOutputStream out = null;
        java.io.InputStream in = null;
        boolean ok = false;
        try {
            Request.Builder rb = new Request.Builder();
            rb.url(url);
            applyHeaders(rb, headersJson);
            rb.get();
            call = c.newCall(rb.build());
            Response resp = call.execute();
            try {
                if (!resp.isSuccessful()) {
                    Log.w(TAG, "下载 HTTP " + resp.code() + " " + url);
                    return false;
                }
                ResponseBody body = resp.body();
                if (body == null) return false;
                long total = body.contentLength();
                in = body.byteStream();
                out = new FileOutputStream(dest);
                byte[] buf = new byte[64 * 1024];
                long got = 0;
                int n;
                long last = 0;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    got += n;
                    if (got > maxBytes) {
                        Log.w(TAG, "下载超过上限 " + maxBytes + "B: " + url);
                        return false;
                    }
                    long now = System.currentTimeMillis();
                    if (cb != null && (now - last >= 200 || (total > 0 && got >= total))) {
                        last = now;
                        try {
                            cb.onProgress(got, total);
                        } catch (Throwable ignore) { }
                    }
                }
                out.flush();
                ok = true;
                return true;
            } finally {
                try {
                    resp.close();
                } catch (Throwable ignore) { }
            }
        } catch (Throwable e) {
            Log.w(TAG, "下载失败 " + url + ": " + e);
            return false;
        } finally {
            try {
                if (in != null) in.close();
            } catch (Throwable ignore) { }
            try {
                if (out != null) out.close();
            } catch (Throwable ignore) { }
            if (call != null) { try { call.cancel(); } catch (Throwable ignore) { } }
            if (!ok && dest.exists()) {
                try {
                    dest.delete();
                } catch (Throwable ignore) { }
            }
        }
    }

    /** Content-Type 优先，其次按扩展名猜。 */
    public static String mimeOf(String url, String ctype) {        if (ctype != null) {
            String ct = ctype.trim();
            int sc = ct.indexOf(';');
            if (sc > 0) ct = ct.substring(0, sc).trim();
            if (!ct.isEmpty()) return ct;
        }
        String u = url == null ? "" : url.toLowerCase(Locale.US);
        int q = u.indexOf('?');
        if (q >= 0) u = u.substring(0, q);
        if (u.endsWith(".png")) return "image/png";
        if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
        if (u.endsWith(".webp")) return "image/webp";
        if (u.endsWith(".gif")) return "image/gif";
        if (u.endsWith(".avif")) return "image/avif";
        if (u.endsWith(".svg")) return "image/svg+xml";
        if (u.endsWith(".ico")) return "image/x-icon";
        if (u.endsWith(".css")) return "text/css";
        if (u.endsWith(".js")) return "application/javascript";
        if (u.endsWith(".woff2")) return "font/woff2";
        if (u.endsWith(".woff")) return "font/woff";
        if (u.endsWith(".ttf")) return "font/ttf";
        if (u.endsWith(".json")) return "application/json";
        if (u.endsWith(".html") || u.endsWith(".htm")) return "text/html";
        return "application/octet-stream";
    }

    /* ---------------- 生命周期 ---------------- */

    public void cancelAll() {
        for (Call c : active) {
            try { c.cancel(); } catch (Throwable ignore) { }
        }
        active.clear();
    }

    public void shutdown() {
        cancelAll();
        try { pool.shutdownNow(); } catch (Throwable ignore) { }
        try { base.dispatcher().executorService().shutdown(); } catch (Throwable ignore) { }
        try { base.connectionPool().evictAll(); } catch (Throwable ignore) { }
    }

    /* ---------------- DoH ---------------- */

    /**
     * 自定义 Dns：用 JSON DoH 端点解析 A 记录，10 分钟内存缓存。
     * 注意：查询自身的请求走 base（系统 DNS）客户端，绝不能走本 Dns，否则死循环。
     */
    private static final class DohDns implements Dns {
        private final String endpoint;
        private final Map<String, Entry> cache = new ConcurrentHashMap<String, Entry>();

        DohDns(String endpoint) {
            this.endpoint = endpoint;
        }

        static final class Entry {
            final List<InetAddress> addrs;
            final long exp;
            Entry(List<InetAddress> a, long e) { addrs = a; exp = e; }
        }

        @Override
        public List<InetAddress> lookup(String hostname) throws UnknownHostException {
            if (hostname == null) throw new UnknownHostException("hostname == null");
            if (isIpLiteral(hostname)) return Dns.SYSTEM.lookup(hostname);

            long now = System.currentTimeMillis();
            Entry e = cache.get(hostname);
            if (e != null && e.exp > now) return e.addrs;

            List<InetAddress> addrs = null;
            try {
                addrs = query(hostname);
            } catch (Throwable ex) {
                Log.w(TAG, "DoH 查询失败 " + hostname + ": " + ex);
            }
            if (addrs == null || addrs.isEmpty()) {
                // 兜底系统 DNS（可能被污染，但总比整个请求失败好）
                addrs = Dns.SYSTEM.lookup(hostname);
                Log.w(TAG, "DoH 无结果，回退系统 DNS: " + hostname);
            }
            List<InetAddress> copy = new ArrayList<InetAddress>(addrs);
            cache.put(hostname, new Entry(copy, now + DOH_TTL_MS));
            return copy;
        }

        private List<InetAddress> query(String host) throws Exception {
            String url = endpoint + (endpoint.indexOf('?') >= 0 ? "&" : "?")
                    + "name=" + host + "&type=A";
            Request r = new Request.Builder()
                    .url(url)
                    .header("accept", "application/dns-json")
                    .get()
                    .build();
            Response resp = baseClientForDoh.newCall(r).execute();
            try {
                if (!resp.isSuccessful()) throw new IOException("DoH HTTP " + resp.code());
                ResponseBody body = resp.body();
                if (body == null) throw new IOException("DoH 空响应");
                String s = body.string();
                JSONObject o = new JSONObject(s);
                JSONArray ans = o.optJSONArray("Answer");
                List<InetAddress> list = new ArrayList<InetAddress>();
                if (ans != null) {
                    for (int i = 0; i < ans.length(); i++) {
                        JSONObject a = ans.optJSONObject(i);
                        if (a == null) continue;
                        if (a.optInt("type") != 1) continue;          // 只要 A 记录
                        String ip = a.optString("data", "");
                        if (ip.isEmpty()) continue;
                        try { list.add(InetAddress.getByName(ip)); } catch (Throwable ignore) { }
                    }
                }
                return list;
            } finally {
                resp.close();
            }
        }

        private static boolean isIpLiteral(String h) {
            if (h.isEmpty()) return false;
            if (h.indexOf(':') >= 0) return true;             // IPv6 字面量
            for (int i = 0; i < h.length(); i++) {
                char c = h.charAt(i);
                if (!(c == '.' || (c >= '0' && c <= '9'))) return false;
            }
            return true;                                       // 纯数字点分
        }
    }

    /** DoH 自身请求用的直连客户端（系统 DNS、无代理），避免递归。 */
    private static volatile OkHttpClient baseClientForDoh;

    static {
        baseClientForDoh = new OkHttpClient.Builder()
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(8, TimeUnit.SECONDS)
                .writeTimeout(8, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build();
    }
    /** 同步抓取图片为 data URL（主页背景图缓存用；限制 4MB）。 */
    public String imageData(String url) {
        try {
            Request req = new Request.Builder().url(url).get().build();
            Response resp = client.newCall(req).execute();
            try {
                if (!resp.isSuccessful()) return "{\"ok\":false,\"err\":\"HTTP " + resp.code() + "\"}";
                ResponseBody body = resp.body();
                byte[] bytes = body == null ? new byte[0] : body.bytes();
                if (bytes.length == 0 || bytes.length > 4 * 1024 * 1024) {
                    return "{\"ok\":false,\"err\":\"empty-or-too-large\"}";
                }
                String ct = resp.header("Content-Type");
                if (ct == null || !ct.startsWith("image/")) ct = "image/jpeg";
                return "{\"ok\":true,\"type\":\"" + ct + "\",\"b64\":\"" +
                        Base64.encodeToString(bytes, Base64.NO_WRAP) + "\"}";
            } finally { resp.close(); }
        } catch (Throwable e) {
            return "{\"ok\":false,\"err\":\"" + e.getClass().getSimpleName() + "\"}";
        }
    }

    /** 下载图片到文件（异步线程调用），返回 JSON 字符串。 */
    public String imageToFile(String url, File out) {
        try {
            Request req = new Request.Builder().url(url).get().build();
            Response resp = client.newCall(req).execute();
            try {
                if (!resp.isSuccessful()) return "{\"ok\":false,\"err\":\"HTTP " + resp.code() + "\"}";
                ResponseBody body = resp.body();
                byte[] bytes = body == null ? new byte[0] : body.bytes();
                if (bytes.length == 0 || bytes.length > 12 * 1024 * 1024) {
                    return "{\"ok\":false,\"err\":\"empty-or-too-large\"}";
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                FileOutputStream fos = new FileOutputStream(out);
                try { fos.write(bytes); } finally { fos.close(); }
                String ct = resp.header("Content-Type");
                if (ct == null || !ct.startsWith("image/")) ct = "image/jpeg";
                return "{\"ok\":true,\"path\":\"" + out.getAbsolutePath().replace("\\", "/") +
                        "\",\"type\":\"" + ct + "\",\"bytes\":" + bytes.length + "}";
            } finally { resp.close(); }
        } catch (Throwable e) {
            return "{\"ok\":false,\"err\":\"" + e.getClass().getSimpleName() + "\"}";
        }
    }

}
