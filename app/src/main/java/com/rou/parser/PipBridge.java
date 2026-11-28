package com.rou.parser;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 界析 · 运行时 pip（纯 Python wheel 安装器）。
 *
 * 为什么不在 Python 里跑 pip：Chaquopy 的 pip 只在构建期可用；运行时安装需要自己实现。
 * 网络必须复用 App 的 OkHttp（DoH/代理），所以下载/查询放在 Java，Python 只负责把装好的目录挂进 sys.path。
 *
 * 能力边界（如实）：
 *   - 支持：PyPI 上带 *-none-any.whl 的纯 Python 包（含递归依赖）；
 *   - 不支持：需要编译的包（numpy/lxml…）——没有 NDK 交叉编译；会返回 needs_build 和说明；
 *   - 忽略版本约束（<、>=、~=），只按包名取最新/指定版本；
 *   - wheel 的 RECORD/entry_points 不生成可执行脚本，只保证 import 可用。
 *
 * 对外（JsBridge 转发）：
 *   pipInstall(job, spec, optsJson)   异步安装；进度/日志通过 window.__pipEv({...}) 推回
 *   pipList()                          已装清单
 *   pipRemove(pkg)                     卸载
 *   pipIndex(url)                      查看/设置索引（默认 https://pypi.org/pypi/）
 */
public class PipBridge {
    private static final String TAG = MainActivity.TAG;
    private static final String DEFAULT_INDEX = "https://pypi.org/pypi/";
    private static final String PY_TAG = "cp314";   // 本 App 固定 CPython 3.14（Chaquopy 17）
    private static final long MAX_WHEEL = 200L * 1024 * 1024;   // 200 MB
    private static final int MAX_DEPTH = 6;

    private final Context app;
    private volatile WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean busy = false;
    private final Set<String> visiting = new HashSet<String>();

    PipBridge(MainActivity act, WebView web) {
        this.app = act.getApplicationContext();
        this.web = web;
    }

    void detach() {
        web = null;
    }

    /* ================= 对外 ================= */

    public String listJson() {
        JSONObject out = new JSONObject();
        try {
            JSONObject db = readInstalled();
            JSONArray arr = new JSONArray();
            Iterator<String> it = db.keys();
            while (it.hasNext()) {
                String k = it.next();
                JSONObject rec = db.optJSONObject(k);
                if (rec == null) continue;
                JSONObject o = new JSONObject();
                o.put("pkg", k);
                o.put("version", rec.optString("version", ""));
                o.put("level", rec.optString("level", "pure"));
                String p = rec.optString("path", "");
                o.put("path", p);
                o.put("exists", p != null && !p.isEmpty() && new File(p).isDirectory());
                arr.put(o);
            }
            out.put("ok", true);
            out.put("packages", arr);
            out.put("site", siteRoot().getAbsolutePath());
            out.put("index", getIndex());
            out.put("busy", busy);
        } catch (Throwable t) {
            return errJson("list", t);
        }
        return out.toString();
    }

    public String removeJson(String pkg) {
        JSONObject out = new JSONObject();
        try {
            String key = normName(pkg);
            if (key.isEmpty()) {
                out.put("ok", false);
                out.put("err", "包名不能为空");
                return out.toString();
            }
            JSONObject db = readInstalled();
            JSONObject rec = db.optJSONObject(key);
            if (rec == null) {
                out.put("ok", false);
                out.put("err", "未安装: " + pkg);
                return out.toString();
            }
            String path = rec.optString("path", "");
            if (path != null && !path.isEmpty()) {
                File f = new File(path);
                String root = siteRoot().getAbsolutePath();
                if (f.getAbsolutePath().startsWith(root)) deleteRec(f);
                else throw new Exception("拒绝删除 site 目录之外的路径: " + path);
                pyRemoveSite(path);
            }
            db.remove(key);
            writeInstalled(db);
            out.put("ok", true);
            out.put("pkg", pkg);
        } catch (Throwable t) {
            return errJson("remove", t);
        }
        return out.toString();
    }

    /** 把已安装模块加载到当前 Python 会话（启动时不再自动加载）。 */
    public String loadJson(String pkg) {
        JSONObject out = new JSONObject();
        try {
            JSONObject rec = readInstalled().optJSONObject(normName(pkg));
            if (rec == null) {
                out.put("ok", false);
                out.put("err", "未安装: " + pkg);
                return out.toString();
            }
            String path = rec.optString("path", "");
            if (path.isEmpty() || !new File(path).isDirectory()) {
                out.put("ok", false);
                out.put("err", "模块目录不存在: " + path);
                return out.toString();
            }
            pyAddSite(path);
            out.put("ok", true);
            out.put("pkg", pkg);
        } catch (Throwable t) {
            return errJson("load", t);
        }
        return out.toString();
    }

    /** 从当前 Python 会话卸载（不删除文件）。 */
    public String unloadJson(String pkg) {
        JSONObject out = new JSONObject();
        try {
            JSONObject rec = readInstalled().optJSONObject(normName(pkg));
            if (rec != null) pyRemoveSite(rec.optString("path", ""));
            out.put("ok", true);
            out.put("pkg", pkg);
        } catch (Throwable t) {
            return errJson("unload", t);
        }
        return out.toString();
    }

    public String indexJson(String url) {        JSONObject out = new JSONObject();
        try {
            String u = url == null ? "" : url.trim();
            if (u.isEmpty()) {
                out.put("ok", true);
                out.put("index", getIndex());
                return out.toString();
            }
            if (!u.startsWith("http://") && !u.startsWith("https://")) {
                out.put("ok", false);
                out.put("err", "索引地址必须以 http:// 或 https:// 开头");
                return out.toString();
            }
            if (!u.endsWith("/")) u += "/";
            File f = indexFile();
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            FileOutputStream fos = new FileOutputStream(f);
            try {
                fos.write(u.getBytes(StandardCharsets.UTF_8));
            } finally {
                fos.close();
            }
            out.put("ok", true);
            out.put("index", u);
        } catch (Throwable t) {
            return errJson("index", t);
        }
        return out.toString();
    }

    /** 异步安装：立即返回 {ok:true, job}，后续事件走 __pipEv。 */
    public String installAsync(String jobId, String spec, String optsJson) {
        JSONObject out = new JSONObject();
        try {
            final String raw = spec == null ? "" : spec.trim();
            final boolean directUrl = raw.startsWith("http://") || raw.startsWith("https://");
            if (directUrl) {
                JSONObject o0 = new JSONObject(optsJson == null || optsJson.isEmpty() ? "{}" : optsJson);
                if (!o0.optBoolean("store", false)) {
                    out.put("ok", false);
                    out.put("err", "预编译模块只能从「模块商店」安装，命令不支持直链");
                    return out.toString();
                }
            }
            final Spec sp = directUrl ? null : parseSpec(raw);
            if (!directUrl && sp == null) {
                out.put("ok", false);
                out.put("err", "包名不合法（例：requests、requests==2.32.3，或 wheel 的 http(s) 地址）");
                return out.toString();
            }
            if (busy) {
                out.put("ok", false);
                out.put("err", "已有安装任务在跑，请等它结束");
                return out.toString();
            }
            JSONObject opts = new JSONObject(optsJson == null || optsJson.isEmpty() ? "{}" : optsJson);
            final boolean deps = opts.optBoolean("deps", true);
            String idx = opts.optString("index", "");
            final String index = (idx == null || idx.isEmpty()) ? getIndex() : idx;
            final String id = (jobId == null || !jobId.matches("[A-Za-z0-9_-]{1,40}"))
                    ? "p" + System.currentTimeMillis() : jobId;

            busy = true;
            visiting.clear();
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    JSONObject done = new JSONObject();
                    try {
                        JSONObject rec = directUrl
                                ? installUrl(id, raw, index, deps, 0)
                                : installOne(id, sp.name, sp.ver, index, deps, 0);
                        done.put("ok", true);
                        done.put("pkg", rec.optString("pkg"));
                        done.put("version", rec.optString("version"));
                        done.put("path", rec.optString("path"));
                        done.put("level", rec.optString("level", "pure"));
                        done.put("installed", rec.optJSONArray("installed"));
                    } catch (Throwable e) {
                        try {
                            done.put("ok", false);
                            done.put("pkg", directUrl ? raw : sp.name);
                            done.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
                            if (e instanceof NeedsBuild) {
                                done.put("level", "needs_build");
                                done.put("guide", ((NeedsBuild) e).guide);
                            }
                        } catch (Throwable ignore) { }
                    } finally {
                        busy = false;
                        try {
                            done.put("j", id);
                            done.put("t", "done");
                        } catch (Throwable ignore) { }
                        emit(done);
                    }
                }
            }, "pip-" + id);
            t.setDaemon(true);
            t.start();

            out.put("ok", true);
            out.put("job", id);
            out.put("pkg", directUrl ? raw : sp.name);
            out.put("index", index);
        } catch (Throwable t) {
            return errJson("install", t);
        }
        return out.toString();
    }

    /* ================= 安装实现 ================= */

    private static final class Spec {
        final String name;
        final String ver;

        Spec(String name, String ver) {
            this.name = name;
            this.ver = ver;
        }
    }

    private static Spec parseSpec(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return null;
        s = s.replace(" ", "");
        int i = s.indexOf("==");
        if (i < 0) i = s.indexOf("=");
        String name = i >= 0 ? s.substring(0, i) : s;
        String ver = i >= 0 ? s.substring(i + (s.indexOf("==") == i ? 2 : 1)) : null;
        if (!name.matches("[A-Za-z0-9_.\\-]+")) return null;
        if (ver != null && !ver.matches("[A-Za-z0-9_.\\-+!]+")) return null;
        return new Spec(name, ver);
    }

    private static final class NeedsBuild extends Exception {
        final String guide;

        NeedsBuild(String msg, String guide) {
            super(msg);
            this.guide = guide;
        }
    }

    private JSONObject installOne(String id, String name, String ver, String index,
                                  boolean deps, int depth) throws Exception {
        if (depth > MAX_DEPTH) throw new Exception("依赖层级过深（>" + MAX_DEPTH + "），已停止");
        String key = normName(name);
        if (!visiting.add(key)) {
            log(id, "跳过循环依赖: " + name);
            JSONObject o = new JSONObject();
            o.put("pkg", name);
            o.put("version", "");
            o.put("path", "");
            o.put("level", "skip");
            return o;
        }
        try {
            String metaUrl = index + enc(name) + (ver == null ? "" : "/" + enc(ver)) + "/json";
            log(id, "查询 " + metaUrl);
            JSONObject meta = getJson(metaUrl);
            if (meta == null) throw new Exception("查询失败（网络或索引不可用）：" + metaUrl);
            JSONObject info = meta.optJSONObject("info");
            if (info == null) throw new Exception("索引返回格式不对（缺 info）");
            String version = info.optString("version", "");
            if (version.isEmpty()) throw new Exception("索引没有版本号");
            log(id, "找到 " + name + " " + version);

            JSONArray files = meta.optJSONArray("urls");
            if (files == null) {
                JSONObject rel = meta.optJSONObject("releases");
                if (rel != null) files = rel.optJSONArray(version);
            }
            JSONObject wheel = pickWheel(files, deviceAbi(), Build.VERSION.SDK_INT);
            if (wheel == null) {
                boolean hasSdist = hasSdist(files);
                String msg = "没有可用的 wheel：PyPI 上没有纯 Python 包（*-none-any.whl），"
                        + "也没有适配本机的 Android 预编译轮子（" + PY_TAG + "-android_*_" + deviceAbi() + ".whl）";
                if (hasSdist) msg += "，只有源码包";
                msg += "；当前运行时没有 NDK 交叉编译能力";
                throw new NeedsBuild(msg, buildGuide(name, version));
            }

            final String fn = wheel.optString("filename", "wheel.whl");
            final boolean androidWheel = isAndroidWheel(fn);
            if (androidWheel) log(id, "使用 Android 预编译轮子: " + fn);
            String url = wheel.optString("url", "");
            long size = wheel.optLong("size", 0);
            log(id, "下载 " + fn + (size > 0 ? "（" + human(size) + "）" : ""));

            File tmp = File.createTempFile("pip-", "-" + safeFile(fn), app.getCacheDir());
            final String jid = id;
            boolean ok = NetClient.get().downloadToFile(url, uaJson(true), 120000, MAX_WHEEL, tmp,
                    new NetClient.Progress() {
                        @Override
                        public void onProgress(long got, long total) {
                            prog(jid, got, total);
                        }
                    });
            if (!ok || !tmp.isFile() || tmp.length() == 0) {
                try {
                    tmp.delete();
                } catch (Throwable ignore) { }
                throw new Exception("下载失败（HTTP/代理/DoH 不可用？）: " + url);
            }

            String want = null;
            try {
                JSONObject dig = wheel.optJSONObject("digests");
                if (dig != null) want = dig.optString("sha256", "");
            } catch (Throwable ignore) { }
            if (want != null && !want.isEmpty()) {
                String got = sha256(tmp);
                if (!want.equalsIgnoreCase(got)) {
                    tmp.delete();
                    throw new Exception("sha256 校验失败（文件可能被篡改/截断）");
                }
                log(id, "sha256 校验通过");
            }

            File dest = new File(siteRoot(), safeFile(key) + "-" + safeFile(version));
            if (dest.exists()) deleteRec(dest);
            if (!dest.mkdirs() && !dest.isDirectory()) throw new Exception("无法创建目录: " + dest);
            int n = unzip(tmp, dest);
            try {
                tmp.delete();
            } catch (Throwable ignore) { }
            if (n <= 0) throw new Exception("wheel 解压失败（空包？）");
            log(id, "解压 " + n + " 个文件 → " + dest.getAbsolutePath());

            JSONObject db = readInstalled();
            JSONObject old = db.optJSONObject(key);
            if (old != null) {
                String op = old.optString("path", "");
                if (!op.isEmpty() && !op.equals(dest.getAbsolutePath())) {
                    File of = new File(op);
                    if (of.getAbsolutePath().startsWith(siteRoot().getAbsolutePath())) deleteRec(of);
                    pyRemoveSite(op);
                }
            }
            JSONObject rec = new JSONObject();
            rec.put("version", version);
            rec.put("path", dest.getAbsolutePath());
            rec.put("level", androidWheel ? "android" : "pure");
            rec.put("ts", System.currentTimeMillis() / 1000L);
            db.put(key, rec);
            writeInstalled(db);
            pyAddSite(dest.getAbsolutePath());
            log(id, "登记完成 " + name + " " + version + "（目录已加入 sys.path）");

            JSONArray installed = new JSONArray();
            installed.put(name);
            if (deps) {
                JSONArray reqs = info.optJSONArray("requires_dist");
                if (reqs != null) {
                    for (int i = 0; i < reqs.length(); i++) {
                        String r = reqs.optString(i, "");
                        String dep = depName(r);
                        if (dep == null) continue;
                        String dk = normName(dep);
                        JSONObject cur = readInstalled().optJSONObject(dk);
                        if (cur != null) {
                            log(id, "依赖已在: " + dep + " " + cur.optString("version"));
                            continue;
                        }
                        log(id, "安装依赖: " + dep + "（来自 " + name + "）");
                        try {
                            JSONObject sub = installOne(id, dep, null, index, deps, depth + 1);
                            installed.put(sub.optString("pkg", dep));
                        } catch (Throwable e) {
                            log(id, "依赖 " + dep + " 失败：" + (e.getMessage() == null ? e : e.getMessage()));
                        }
                    }
                }
            }

            JSONObject out = new JSONObject();
            out.put("pkg", name);
            out.put("version", version);
            out.put("path", dest.getAbsolutePath());
            out.put("level", androidWheel ? "android" : "pure");
            out.put("installed", installed);
            return out;
        } finally {
            visiting.remove(key);
        }
    }

    /** 先纯 Python wheel，再找本机可用的 Android 预编译轮子（cp311 + abi + api<=sdk）。 */
    private static JSONObject pickWheel(JSONArray files, String abi, int sdk) {
        if (files == null) return null;
        JSONObject pure = null;
        JSONObject android = null;
        int bestApi = -1;
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f == null) continue;
            String fn = f.optString("filename", "").toLowerCase(Locale.US);
            if (!fn.endsWith(".whl")) continue;
            if (fn.endsWith("-none-any.whl")) {
                if (pure == null) pure = f;
                if (fn.contains("-py3-none-any.whl")) pure = f;
                continue;
            }
            if (!isAndroidWheel(fn)) continue;
            if (fn.indexOf("-" + PY_TAG + "-") < 0) continue;
            if (fn.indexOf("_" + abi + ".whl") < 0) continue;
            int api = androidApi(fn);
            if (api <= 0 || api > sdk) continue;
            if (api >= bestApi) {
                bestApi = api;
                android = f;
            }
        }
        return pure != null ? pure : android;
    }

    private static boolean isAndroidWheel(String fn) {
        return fn != null && fn.toLowerCase(Locale.US).contains("-android_");
    }

    private static int androidApi(String fn) {
        int i = fn.indexOf("-android_");
        if (i < 0) return -1;
        i += "-android_".length();
        int j = i;
        while (j < fn.length() && Character.isDigit(fn.charAt(j))) j++;
        if (j <= i) return -1;
        try {
            return Integer.parseInt(fn.substring(i, j));
        } catch (Throwable e) {
            return -1;
        }
    }

    private static String deviceAbi() {
        try {
            String a = Build.SUPPORTED_ABIS[0];
            if (a == null) return "arm64_v8a";
            a = a.trim().toLowerCase(Locale.US);
            return a.replace('-', '_');
        } catch (Throwable e) {
            return "arm64_v8a";
        }
    }

    /** wheel 标签是否适配本机：纯 Python，或 cp311 + android + 本机 ABI。 */
    private static boolean wheelCompatible(String fn, String abi, int sdk) {
        if (fn == null) return false;
        String f = fn.toLowerCase(Locale.US);
        if (f.endsWith("-none-any.whl")) return true;
        if (!isAndroidWheel(f)) return false;
        boolean pyTagOK = f.indexOf("-" + PY_TAG + "-") >= 0
                || f.indexOf("-py3-none-android_") >= 0;
        if (!pyTagOK) return false;
        if (f.indexOf("_" + abi + ".whl") < 0) return false;
        int api = androidApi(f);
        return api > 0 && api <= sdk;
    }

    private static boolean hasSdist(JSONArray files) {
        if (files == null) return false;
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f == null) continue;
            String fn = f.optString("filename", "").toLowerCase(Locale.US);
            if (fn.endsWith(".tar.gz") || fn.endsWith(".zip")) return true;
        }
        return false;
    }

    /** 直接安装 wheel 直链（自建服务器/私有索引最省事的方式）。 */
    private JSONObject installUrl(String id, String url, String index, boolean deps, int depth) throws Exception {
        if (depth > MAX_DEPTH) throw new Exception("依赖层级过深（>" + MAX_DEPTH + "）");
        String fn = url;
        int q = fn.indexOf('?');
        if (q >= 0) fn = fn.substring(0, q);
        int s = fn.lastIndexOf('/');
        if (s >= 0) fn = fn.substring(s + 1);
        try {
            fn = URLDecoder.decode(fn, "UTF-8");
        } catch (Throwable ignore) { }
        String lower = fn.toLowerCase(Locale.US);
        if (!lower.endsWith(".whl")) throw new Exception("直链必须是 .whl 文件（当前只支持 wheel）");
        String abi = deviceAbi();
        int sdk = Build.VERSION.SDK_INT;
        if (!wheelCompatible(lower, abi, sdk)) {
            throw new NeedsBuild("wheel 与本机不兼容：需要 *-none-any.whl，或 "
                    + PY_TAG + "-android_*_" + abi + ".whl（api ≤ " + sdk + "）",
                    buildGuide(fn, "直链"));
        }
        String base = fn.substring(0, fn.length() - 4);
        int a = base.indexOf('-');
        int b = a < 0 ? -1 : base.indexOf('-', a + 1);
        if (a <= 0 || b <= a) throw new Exception("wheel 文件名无法解析: " + fn);
        String name = base.substring(0, a).replace('_', '-');
        String ver = base.substring(a + 1, b);
        String key = normName(name);
        if (!visiting.add(key)) throw new Exception("依赖循环: " + name);
        try {
            log(id, "直接下载 wheel: " + fn);
            File tmp = File.createTempFile("pip-", "-" + safeFile(fn), app.getCacheDir());
            final String jid = id;
            boolean ok = NetClient.get().downloadToFile(url, uaJson(true), 120000, MAX_WHEEL, tmp,
                    new NetClient.Progress() {
                        @Override
                        public void onProgress(long got, long total) {
                            prog(jid, got, total);
                        }
                    });
            if (!ok || !tmp.isFile() || tmp.length() == 0) {
                try {
                    tmp.delete();
                } catch (Throwable ignore) { }
                throw new Exception("下载失败: " + url);
            }
            log(id, "直链未提供 sha256，跳过校验（请只安装可信来源）");
            boolean androidWheel = isAndroidWheel(fn);
            File dest = new File(siteRoot(), safeFile(key) + "-" + safeFile(ver));
            if (dest.exists()) deleteRec(dest);
            if (!dest.mkdirs() && !dest.isDirectory()) throw new Exception("无法创建目录: " + dest);
            int n = unzip(tmp, dest);
            try {
                tmp.delete();
            } catch (Throwable ignore) { }
            if (n <= 0) throw new Exception("wheel 解压失败（空包？）");

            JSONObject db = readInstalled();
            JSONObject old = db.optJSONObject(key);
            if (old != null) {
                String op = old.optString("path", "");
                if (!op.isEmpty() && !op.equals(dest.getAbsolutePath())
                        && op.startsWith(siteRoot().getAbsolutePath())) {
                    deleteRec(new File(op));
                    pyRemoveSite(op);
                }
            }
            JSONObject rec = new JSONObject();
            rec.put("version", ver);
            rec.put("path", dest.getAbsolutePath());
            rec.put("level", androidWheel ? "android" : "pure");
            rec.put("ts", System.currentTimeMillis() / 1000L);
            db.put(key, rec);
            writeInstalled(db);
            pyAddSite(dest.getAbsolutePath());
            log(id, "登记完成 " + name + " " + ver + "（目录已加入 sys.path）");

            JSONArray installed = new JSONArray();
            installed.put(name);
            if (deps) {
                for (String dep : wheelRequires(dest)) {
                    if (normName(dep).isEmpty()) continue;
                    JSONObject cur = readInstalled().optJSONObject(normName(dep));
                    if (cur != null) {
                        log(id, "依赖已在: " + dep + " " + cur.optString("version"));
                        continue;
                    }
                    log(id, "安装依赖: " + dep);
                    try {
                        JSONObject sub = installOne(id, dep, null, index, deps, depth + 1);
                        installed.put(sub.optString("pkg", dep));
                    } catch (Throwable e) {
                        log(id, "依赖 " + dep + " 失败：" + (e.getMessage() == null ? e : e.getMessage()));
                    }
                }
            }
            JSONObject out = new JSONObject();
            out.put("pkg", name);
            out.put("version", ver);
            out.put("path", dest.getAbsolutePath());
            out.put("level", androidWheel ? "android" : "pure");
            out.put("installed", installed);
            return out;
        } finally {
            visiting.remove(key);
        }
    }

    /** 从 wheel 的 METADATA 读 Requires-Dist（直链安装没有 PyPI JSON 可用）。 */
    private static List<String> wheelRequires(File dest) {
        List<String> out = new ArrayList<String>();
        File[] ds = dest.listFiles();
        if (ds == null) return out;
        for (File d : ds) {
            if (d == null || !d.isDirectory() || !d.getName().endsWith(".dist-info")) continue;
            File meta = new File(d, "METADATA");
            if (!meta.isFile()) continue;
            java.io.BufferedReader r = null;
            try {
                r = new java.io.BufferedReader(new java.io.InputStreamReader(
                        new FileInputStream(meta), StandardCharsets.UTF_8));
                String line;
                while ((line = r.readLine()) != null) {
                    if (!line.regionMatches(true, 0, "Requires-Dist:", 0, 14)) continue;
                    String dep = depName(line.substring(14).trim());
                    if (dep != null && !out.contains(dep)) out.add(dep);
                }
            } catch (Throwable ignore) {
            } finally {
                try {
                    if (r != null) r.close();
                } catch (Throwable ignore) { }
            }
        }
        return out;
    }

    private static String depName(String req) {
        if (req == null) return null;
        String r = req.trim();
        if (r.isEmpty() || r.startsWith("#")) return null;
        int semi = r.indexOf(';');
        if (semi >= 0) {
            String marker = r.substring(semi + 1).trim();
            /* 带 extra / python 版本条件的依赖先跳过（本安装器不计算环境标记） */
            if (marker.contains("extra") || marker.contains("python_version")) return null;
            r = r.substring(0, semi);
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < r.length(); i++) {
            char c = r.charAt(i);
            if (c == '<' || c == '>' || c == '=' || c == '!' || c == '~'
                    || c == '[' || c == '(' || c == ' ' || c == '@') break;
            sb.append(c);
        }
        String name = sb.toString().trim();
        if (name.isEmpty() || name.equalsIgnoreCase("python")) return null;
        return name;
    }

    private static int unzip(File wheel, File dest) throws Exception {
        int count = 0;
        ZipFile z = new ZipFile(wheel);
        try {
            Enumeration<? extends ZipEntry> en = z.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                String n = e.getName().replace('\\', '/');
                if (n.isEmpty() || n.startsWith("/") || n.contains("..")) continue;
                File out = new File(dest, n);
                if (e.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                InputStream in = z.getInputStream(e);
                OutputStream os = new FileOutputStream(out);
                try {
                    byte[] buf = new byte[64 * 1024];
                    int r;
                    while ((r = in.read(buf)) > 0) os.write(buf, 0, r);
                } finally {
                    try {
                        os.close();
                    } catch (Throwable ignore) { }
                    try {
                        in.close();
                    } catch (Throwable ignore) { }
                }
                count++;
            }
        } finally {
            try {
                z.close();
            } catch (Throwable ignore) { }
        }
        return count;
    }

    /* ================= 网络 / 元数据 ================= */

    private JSONObject getJson(String url) {
        NetClient.Fetched f = NetClient.get().fetchSync(url, uaJson(false), 30000, 8 * 1024 * 1024);
        if (f == null || f.bytes == null || f.bytes.length == 0) return null;
        try {
            return new JSONObject(new String(f.bytes, StandardCharsets.UTF_8));
        } catch (Throwable e) {
            Log.w(TAG, "pip JSON 解析失败: " + e);
            return null;
        }
    }

    private static String uaJson(boolean acceptJson) {
        return acceptJson
                ? "{\"User-Agent\":\"JieXi-Pip/1.0\",\"Accept\":\"application/octet-stream\"}"
                : "{\"User-Agent\":\"JieXi-Pip/1.0\",\"Accept\":\"application/json\"}";
    }

    /* ================= 存储 ================= */

    private File siteRoot() {
        File d = new File(app.getFilesDir(), "py/site");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private File installedFile() {
        return new File(siteRoot(), "installed.json");
    }

    private File indexFile() {
        return new File(app.getFilesDir(), "py/pip-index.txt");
    }

    private String getIndex() {
        try {
            File f = indexFile();
            if (f.isFile() && f.length() > 0 && f.length() < 4096) {
                byte[] b = new byte[(int) f.length()];
                FileInputStream in = new FileInputStream(f);
                try {
                    int off = 0;
                    while (off < b.length) {
                        int n = in.read(b, off, b.length - off);
                        if (n <= 0) break;
                        off += n;
                    }
                } finally {
                    try {
                        in.close();
                    } catch (Throwable ignore) { }
                }
                String s = new String(b, StandardCharsets.UTF_8).trim();
                if (s.startsWith("http://") || s.startsWith("https://")) {
                    return s.endsWith("/") ? s : s + "/";
                }
            }
        } catch (Throwable ignore) { }
        return DEFAULT_INDEX;
    }

    private JSONObject readInstalled() {
        JSONObject db = new JSONObject();
        try {
            File f = installedFile();
            if (!f.isFile()) return db;
            byte[] b = new byte[(int) f.length()];
            FileInputStream in = new FileInputStream(f);
            try {
                int off = 0;
                while (off < b.length) {
                    int n = in.read(b, off, b.length - off);
                    if (n <= 0) break;
                    off += n;
                }
            } finally {
                try {
                    in.close();
                } catch (Throwable ignore) { }
            }
            JSONObject o = new JSONObject(new String(b, StandardCharsets.UTF_8));
            return o;
        } catch (Throwable e) {
            return db;
        }
    }

    private void writeInstalled(JSONObject db) throws Exception {
        File f = installedFile();
        File parent = f.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        FileOutputStream out = new FileOutputStream(f);
        try {
            out.write(db.toString().getBytes(StandardCharsets.UTF_8));
        } finally {
            out.close();
        }
    }

    private static void deleteRec(File f) {
        if (f == null) return;
        if (f.isDirectory()) {
            File[] cs = f.listFiles();
            if (cs != null) for (File c : cs) deleteRec(c);
        }
        try {
            f.delete();
        } catch (Throwable ignore) { }
    }

    /* ================= Python 侧挂载（反射，lean 包没有 PyBridge） ================= */

    private void pyAddSite(String path) {
        pySite("addSiteDir", path);
    }

    private void pyRemoveSite(String path) {
        pySite("removeSiteDir", path);
    }

    private void pySite(String method, String path) {
        try {
            Class<?> c = Class.forName("com.rou.parser.PyBridge");
            Method m = c.getMethod(method, String.class, Context.class);
            m.invoke(null, path, app);
        } catch (Throwable e) {
            Log.w(TAG, "pip 挂载 sys.path 失败（可能没内置 Python）: " + e);
        }
    }

    /* ================= 事件 ================= */

    private void log(String id, String m) {
        JSONObject ev = new JSONObject();
        try {
            ev.put("j", id);
            ev.put("t", "log");
            ev.put("m", m);
        } catch (Throwable ignore) {
            return;
        }
        emit(ev);
    }

    private void prog(String id, long got, long total) {
        JSONObject ev = new JSONObject();
        try {
            ev.put("j", id);
            ev.put("t", "prog");
            ev.put("got", got);
            ev.put("total", total);
        } catch (Throwable ignore) {
            return;
        }
        emit(ev);
    }

    private void emit(JSONObject ev) {
        final WebView w = web;
        if (w == null) return;
        final String js = "window.__pipEv&&window.__pipEv(" + ev.toString() + ")";
        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    w.evaluateJavascript(js, null);
                } catch (Throwable ignore) { }
            }
        });
    }

    /* ================= 工具 ================= */

    static String normName(String pkg) {
        if (pkg == null) return "";
        return pkg.trim().toLowerCase(Locale.US).replace('-', '_');
    }

    private static String safeFile(String s) {
        return (s == null ? "" : s).replaceAll("[^A-Za-z0-9_.\\-]", "_");
    }

    private static String enc(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8");
        } catch (Throwable e) {
            return s;
        }
    }

    private static String human(long n) {
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return String.format(Locale.US, "%.1f KB", n / 1024.0);
        if (n < 1024L * 1024 * 1024) return String.format(Locale.US, "%.1f MB", n / (1024.0 * 1024));
        return String.format(Locale.US, "%.2f GB", n / (1024.0 * 1024 * 1024));
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        FileInputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        } finally {
            try {
                in.close();
            } catch (Throwable ignore) { }
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }

    private static String buildGuide(String pkg, String ver) {
        return "「" + pkg + " " + ver + "」带 C/C++ 扩展，PyPI 没有 *-none-any.whl。\n"
                + "当前 App 没有 NDK 交叉编译能力，无法在手机上直接编译。\n"
                + "可选：\n"
                + "  1) 找纯 Python 的替代包；\n"
                + "  2) 在电脑上用 Chaquopy 构建期 pip 安装后重新打包 APK；\n"
                + "  3) 用 Termux + proot-distro 安装完整 Linux 再装。";
    }

    private static String errJson(String where, Throwable t) {
        Log.w(TAG, "pip " + where + " 失败: " + t);
        try {
            return new JSONObject().put("ok", false)
                    .put("err", t.getClass().getSimpleName() + ": " + t.getMessage()).toString();
        } catch (Throwable ignore) {
            return "{\"ok\":false,\"err\":\"pip-failed\"}";
        }
    }
}
