package com.rou.parser;

import android.content.Context;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 界析 · Python 子系统引导层（只在 build.ps1 -WithPython 时参与编译/打包）。
 *
 * MainActivity / JsBridge 全部通过反射调用本类，因此默认构建（不带 -WithPython）
 * 不需要 chaquopy_java.jar 也能编译，行为与之前完全一致。
 *
 * 启动流程：
 *   Python.start(new AndroidPlatform(app))
 *     -> 解包 assets/chaquopy/{stdlib-common.imy,bootstrap.imy,bootstrap-native/<abi>}
 *     -> onStart(): java.android.initialize(ctx, build.json, [app, requirements, stdlib-<abi>])
 *     -> AssetFinder 接管 assets 里的 app-common.imy / stdlib-*.imy
 *   Python.start 成功后：
 *     engine.set_user_dir(filesDir/py)  —— 用户脚本目录（App 内新建/编辑的 .py 落在这里）
 *
 * 对外能力（JsBridge 反射调用，全部返回 JSON 字符串，永不抛）：
 *   versionJson / evalJson / dispatchJson / putScript / readScript / listScripts
 *   / checkSyntax / runSource
 */
public final class PyBridge {
    private static final Object LOCK = new Object();
    private static volatile boolean started;
    private static volatile String startError;
    private static volatile Context appCtx;
    private static volatile String userDir = "";
    private static volatile PyObject replGlobals;

    private PyBridge() { }

    public static boolean isStarted() { return started; }

    public static String getStartError() { return startError; }

    /** 用户脚本目录：<filesDir>/py */
    public static String getUserDir(Context any) {
        if (userDir != null && !userDir.isEmpty()) return userDir;
        try {
            Context app = (any == null ? appCtx : any.getApplicationContext());
            if (app != null) userDir = new File(app.getFilesDir(), "py").getAbsolutePath();
        } catch (Throwable ignore) { }
        return userDir == null ? "" : userDir;
    }

    /** 启动解释器（幂等）并初始化用户脚本目录。失败只记录，不抛给调用方。 */
    public static boolean ensureStarted(Context any) {
        if (started) return true;
        synchronized (LOCK) {
            if (started) return true;
            if (startError != null || any == null) return false;
            try {
                Context app = any.getApplicationContext();
                appCtx = app;
                getUserDir(app);
                Python.start(new AndroidPlatform(app));
                started = true;
                /* 用户脚本目录：先建目录，再让 engine 挂到 sys.path */
                try {
                    File d = new File(userDir);
                    if (!d.exists()) d.mkdirs();
                    Python.getInstance().getModule("engine").callAttr("set_user_dir", userDir);
                    /* 模块不随启动自动挂载：由用户在「模块商店」里点“加载到当前会话” */
                } catch (Throwable e) {
                    startError = "set_user_dir: " + e;
                }
                return true;
            } catch (Throwable t) {
                startError = t.getClass().getSimpleName() + ": " + t.getMessage();
                return false;
            }
        }
    }

    /* ---------------- 基础 ---------------- */

    private static JSONObject base(boolean ok) {
        JSONObject o = new JSONObject();
        try { o.put("ok", ok); } catch (Throwable ignore) { }
        return o;
    }

    private static JSONObject notStarted() {
        JSONObject o = base(false);
        try { o.put("err", startError == null ? "python not started" : startError); } catch (Throwable ignore) { }
        return o;
    }

    private static JSONObject errJson(Throwable t) {
        JSONObject o = base(false);
        try {
            o.put("err", t.getClass().getSimpleName() + ": " + t.getMessage());
        } catch (Throwable ignore) { }
        return o;
    }

    /** 解释器版本 / ABI / 用户脚本目录 —— 也用作健康检查。 */
    public static String versionJson(Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        JSONObject out = base(true);
        try {
            out.put("version", Python.getInstance().getModule("sys").get("version").toString());
            out.put("abi", AndroidPlatform.ABI);
            out.put("userDir", getUserDir(any));
            out.put("python", Python.getInstance().getModule("sys").get("version_info").toString());
        } catch (Throwable t) {
            return errJson(t).toString();
        }
        return out.toString();
    }

    /**
     * 执行一段 Python（表达式优先，失败按语句 exec）。
     * {"ok":true,"repr":"2"} / {"ok":false,"err":"..."}
     */
    public static String evalJson(String code, Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        JSONObject out = base(true);
        try {
            Python py = Python.getInstance();
            PyObject builtins = py.getModule("builtins");
            /* 持久 globals：终端里定义的变量跨次保留（REPL 语义） */
            PyObject globals = replGlobals;
            if (globals == null) {
                globals = builtins.callAttr("dict");
                globals.callAttr("__setitem__", "__builtins__", builtins);
                globals.callAttr("__setitem__", "__name__", "jxb_repl");
                replGlobals = globals;
            }
            PyObject r = null;
            boolean expr = true;
            try {
                r = builtins.callAttr("eval", code, globals, globals);
            } catch (Throwable evalErr) {
                expr = false;
                builtins.callAttr("exec", code, globals, globals);
            }
            out.put("kind", expr ? "eval" : "exec");
            out.put("repr", r == null ? "None" : r.toString());
        } catch (Throwable t) {
            return errJson(t).toString();
        }
        return out.toString();
    }

    /* ---------------- 脚本执行 ---------------- */

    /** engine.dispatch(script, url, html) —— html 为空时 Python 侧自己抓（需要网络）。 */
    public static String dispatchJson(String script, String url, String html, Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        JSONObject out = base(true);
        try {
            Python py = Python.getInstance();
            PyObject engine = py.getModule("engine");
            PyObject r = engine.callAttr("dispatch", script, url, html == null ? "" : html);
            String js = r == null ? "{}" : r.toString();
            out.put("data", new JSONObject(js));
        } catch (Throwable t) {
            return errJson(t).toString();
        }
        return out.toString();
    }

    /** engine.run_source(src, url, html) —— 编辑器「测试运行」用，不落盘。 */
    public static String runSourceJson(String src, String url, String html, Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        JSONObject out = base(true);
        try {
            PyObject engine = Python.getInstance().getModule("engine");
            PyObject r = engine.callAttr("run_source", src == null ? "" : src, url == null ? "" : url,
                    html == null ? "" : html);
            out.put("data", new JSONObject(r == null ? "{}" : r.toString()));
        } catch (Throwable t) {
            return errJson(t).toString();
        }
        return out.toString();
    }

    /** engine.check(src) —— 语法检查。 */
    public static String checkSyntax(String src, Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        try {
            PyObject r = Python.getInstance().getModule("engine").callAttr("check", src == null ? "" : src);
            return r == null ? "{\"ok\":false,\"err\":\"null\"}" : r.toString();
        } catch (Throwable t) {
            return errJson(t).toString();
        }
    }

    /* ---------------- 用户脚本文件 ---------------- */

    private static boolean validId(String id) {
        return id != null && id.matches("^[a-z][a-z0-9_]{2,31}$");
    }

    /** 写入用户脚本 <filesDir>/py/<id>.py（App 内新建/编辑后调用）。 */
    public static String putScriptJson(String id, String src, Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        JSONObject out = base(true);
        try {
            if (!validId(id)) {
                out.put("ok", false);
                out.put("err", "脚本 id 不合法（^[a-z][a-z0-9_]{2,31}$）");
                return out.toString();
            }
            File d = new File(getUserDir(any));
            if (!d.exists() && !d.mkdirs()) throw new Exception("无法创建目录: " + d);
            File f = new File(d, id + ".py");
            FileOutputStream fos = new FileOutputStream(f);
            try {
                fos.write((src == null ? "" : src).getBytes(StandardCharsets.UTF_8));
            } finally {
                fos.close();
            }
            out.put("path", f.getAbsolutePath());
            out.put("bytes", f.length());
            /* 让 engine 立刻能看到这个新脚本 */
            try {
                Python.getInstance().getModule("engine").callAttr("set_user_dir", d.getAbsolutePath());
            } catch (Throwable ignore) { }
        } catch (Throwable t) {
            return errJson(t).toString();
        }
        return out.toString();
    }

    /** 读取用户脚本（不存在返回 ok=false）。 */
    public static String readScriptJson(String id, Context any) {
        JSONObject out = base(true);
        try {
            if (!validId(id)) {
                out.put("ok", false);
                out.put("err", "id 不合法");
                return out.toString();
            }
            File f = new File(getUserDir(any), id + ".py");
            if (!f.exists()) {
                out.put("ok", false);
                out.put("err", "not found");
                return out.toString();
            }
            byte[] buf = new byte[(int) f.length()];
            java.io.FileInputStream fis = new java.io.FileInputStream(f);
            try {
                int off = 0;
                while (off < buf.length) {
                    int n = fis.read(buf, off, buf.length - off);
                    if (n <= 0) break;
                    off += n;
                }
            } finally {
                fis.close();
            }
            out.put("src", new String(buf, StandardCharsets.UTF_8));
        } catch (Throwable t) {
            return errJson(t).toString();
        }
        return out.toString();
    }

    /** 重置 REPL 命名空间（终端「重置」按钮）。 */
    public static String resetJson(Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        try {
            replGlobals = null;
            /* 终端用的交互会话在 engine 里维护，一并重置 */
            try {
                Python.getInstance().getModule("engine").callAttr("repl_reset");
            } catch (Throwable ignore) { }
            return base(true).put("reset", true).toString();
        } catch (Throwable t) {
            return errJson(t).toString();
        }
    }

    /* ---------------- 终端：交互解释器 / 脚本执行 ---------------- */

    /** 执行一次交互输入：{"more":true} / {"out","err"} / {"exit":true}。 */
    public static String replJson(String code, String cwd, Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        try {
            PyObject r = Python.getInstance().getModule("engine")
                    .callAttr("repl", code == null ? "" : code, cwd == null ? "" : cwd);
            return r == null ? "{\"ok\":false,\"err\":\"null\"}" : r.toString();
        } catch (Throwable t) {
            return errJson(t).toString();
        }
    }

    /** python <file> [args]：真解释器执行脚本，返回 {"code","out","err"}。 */
    public static String execFileJson(String path, String argvJson, String cwd, Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        try {
            PyObject r = Python.getInstance().getModule("engine")
                    .callAttr("exec_file", path == null ? "" : path,
                            argvJson == null ? "[]" : argvJson,
                            cwd == null ? "" : cwd);
            return r == null ? "{\"ok\":false,\"err\":\"null\"}" : r.toString();
        } catch (Throwable t) {
            return errJson(t).toString();
        }
    }

    /** python -c '<code>'：直接执行源码。 */
    public static String execCodeJson(String code, String argvJson, String cwd, Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        try {
            PyObject r = Python.getInstance().getModule("engine")
                    .callAttr("exec_code", code == null ? "" : code,
                            argvJson == null ? "[]" : argvJson,
                            cwd == null ? "" : cwd);
            return r == null ? "{\"ok\":false,\"err\":\"null\"}" : r.toString();
        } catch (Throwable t) {
            return errJson(t).toString();
        }
    }

    /** 交互会话变量清单（终端 ƒ 面板）。 */
    public static String replVarsJson(Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        try {
            PyObject r = Python.getInstance().getModule("engine").callAttr("repl_vars");
            return r == null ? "{\"ok\":false,\"err\":\"null\"}" : r.toString();
        } catch (Throwable t) {
            return errJson(t).toString();
        }
    }

    /** 运行时 pip：把装好的包目录挂进 sys.path。 */
    public static String addSiteDir(String path, Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        try {
            PyObject r = Python.getInstance().getModule("engine")
                    .callAttr("add_site_dir", path == null ? "" : path);
            return r == null ? "{\"ok\":false,\"err\":\"null\"}" : r.toString();
        } catch (Throwable t) {
            return errJson(t).toString();
        }
    }

    /** 卸载时从 sys.path 摘掉包目录。 */
    public static String removeSiteDir(String path, Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        try {
            PyObject r = Python.getInstance().getModule("engine")
                    .callAttr("remove_site_dir", path == null ? "" : path);
            return r == null ? "{\"ok\":false,\"err\":\"null\"}" : r.toString();
        } catch (Throwable t) {
            return errJson(t).toString();
        }
    }
    /** 内置 + 用户脚本清单。 */
    public static String listScriptsJson(Context any) {
        if (!ensureStarted(any)) return notStarted().toString();
        try {
            PyObject r = Python.getInstance().getModule("engine").callAttr("list_scripts");
            return r == null ? "{\"ok\":false,\"err\":\"null\"}" : r.toString();
        } catch (Throwable t) {
            return errJson(t).toString();
        }
    }
    public static String setConfigJson(String script, String cfgJson) {
        if (!ensureStarted(appCtx)) return notStarted().toString();
        try {
            Python.getInstance().getModule("engine").callAttr("set_config",
                    script == null ? "" : script, cfgJson == null ? "{}" : cfgJson);
            return "{\"ok\":true}";
        } catch (Throwable t) { return errJson(t).toString(); }
    }

    public static String configJson(String script) {
        if (!ensureStarted(appCtx)) return notStarted().toString();
        try {
            PyObject r = Python.getInstance().getModule("engine").callAttr("config_of",
                    script == null ? "" : script);
            return r == null ? "{\"ok\":false}" : r.toString();
        } catch (Throwable t) { return errJson(t).toString(); }
    }

    public static String putFilesJson(String script, String json) {
        if (!ensureStarted(appCtx)) return notStarted().toString();
        try {
            PyObject r = Python.getInstance().getModule("engine").callAttr("set_files",
                    script == null ? "" : script, json == null ? "{}" : json);
            return r == null ? "{\"ok\":false}" : r.toString();
        } catch (Throwable t) { return errJson(t).toString(); }
    }

    public static String configFromSourceJson(String src) {
        try {
            PyObject r = Python.getInstance().getModule("engine").callAttr("config_from_source", src == null ? "" : src);
            return r == null ? "{\"ok\":false}" : r.toString();
        } catch (Throwable t) { return errJson(t).toString(); }
    }

    public static String sysPathJson() {
        try {
            PyObject r = Python.getInstance().getModule("engine").callAttr("sys_path");
            return r == null ? "{\"ok\":false}" : r.toString();
        } catch (Throwable t) { return errJson(t).toString(); }
    }

}
