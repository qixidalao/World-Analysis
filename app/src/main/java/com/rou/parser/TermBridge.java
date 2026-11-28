package com.rou.parser;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 界析 · 终端进程桥（P-09 的「真 shell」）。
 *
 * 设计要点：
 *   1. 每次命令都是独立进程：/system/bin/setsid /system/bin/sh -c "<cmd>"
 *      - setsid 让命令成为新进程组的组长，中断时 kill -9 -- -<pgid> 能连带子进程一起收掉；
 *      - 没有 PTY（不需要 NDK），命令看到的是管道：输出无缓冲、无回显，正好适合本终端的日志式渲染。
 *   2. 输出异步推回 JS：window.__termEv({j:任务号,t:'o'|'e'|'x',d:文本,c:退出码,ms:耗时})，
 *      不阻塞 WebView 的 JS 线程（同步等待会让界面卡死）。
 *   3. 工作目录 / 环境变量由 JS 侧维护并逐条传入，Java 只做「按 cwd 起进程」，所以 cd/export 是立即生效的。
 *   4. 单任务输出上限 512 KB、默认超时 30 s（最长 120 s），超限/超时都杀掉整个进程组。
 *   5. 文件面板用到的 lstat/readlink 也在这里：软链接要显示「名字 → 目标」，而不是只看到跟随后的目录。
 *
 * 由 JsBridge 转发（window.Native.term*），本类不直接注册给 WebView。
 */
public class TermBridge {
    private static final String TAG = MainActivity.TAG;

    private static final String SH = "/system/bin/sh";
    private static final String SETSID = "/system/bin/setsid";
    private static final String KILL = "/system/bin/kill";
    private static final int MAX_JOB_OUT = 512 * 1024;
    private static final int DEFAULT_TIMEOUT_MS = 30000;
    private static final int MAX_TIMEOUT_MS = 120000;

    private final Context app;
    private volatile WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<String, Job> jobs = new ConcurrentHashMap<String, Job>();
    private final AtomicInteger seq = new AtomicInteger();

    TermBridge(MainActivity act, WebView web) {
        this.app = act.getApplicationContext();
        this.web = web;
    }

    /** Activity 销毁时调用：断开回调并收掉所有子进程。 */
    void detach() {
        web = null;
        killAll();
    }

    /* ================= 会话信息 ================= */

    /** 文件名 / 目录 / PATH / sh 路径 / ABI 等。 */
    public String infoJson() {
        JSONObject out = new JSONObject();
        try {
            File home = homeDir();
            File bin = new File(app.getFilesDir(), "bin");
            out.put("ok", true);
            out.put("home", home.getAbsolutePath());
            out.put("bin", bin.getAbsolutePath());
            out.put("files", app.getFilesDir().getAbsolutePath());
            out.put("cache", app.getCacheDir().getAbsolutePath());
            out.put("sh", SH);
            out.put("setsid", new File(SETSID).exists());
            out.put("sdk", Build.VERSION.SDK_INT);
            out.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "?");
            out.put("model", Build.MODEL == null ? "" : Build.MODEL);
            out.put("uid", android.os.Process.myUid());
            JSONArray path = new JSONArray();
            for (File f : pathDirs()) path.put(f.getAbsolutePath());
            out.put("path", path);
        } catch (Throwable t) {
            return err("info", t);
        }
        return out.toString();
    }

    /** HOME = filesDir/home（不存在则建，并写一份 README）。 */
    private File homeDir() {
        File d = new File(app.getFilesDir(), "home");
        if (!d.exists()) d.mkdirs();
        File readme = new File(d, "README.txt");
        if (!readme.exists()) {
            writeText(readme, readmeText());
        }
        File hbin = new File(d, "bin");
        if (!hbin.exists()) hbin.mkdirs();
        return d;
    }

    private static String readmeText() {
        return "# 界析终端 · 工作目录\n"
                + "\n"
                + "这里是 App 私有目录下的 home（应用卸载后一并删除），\n"
                + "终端启动时的当前目录就是这里。\n"
                + "\n"
                + "常用：\n"
                + "  ls -l            看文件\n"
                + "  cd bin           进子目录（cd ~ 回 home，cd .. 上一级）\n"
                + "  echo hi > a.txt  写文件\n"
                + "  cat a.txt        看内容\n"
                + "  python           进入 Python 3 交互解释器（exit() 退出）\n"
                + "  python t.py      运行脚本\n"
                + "  js               进入 JS 交互解释器（exit 退出）\n"
                + "  rou help         直接调用 App 的能力（抓网页 / 跑解析器 / 打开页面）\n"
                + "  help             终端全部内置命令\n"
                + "\n"
                + "注：这里是 App 沙箱，不是设备根目录；/sdcard 需要存储权限，当前版本未申请。\n"
                + "终端右侧的文件面板可以直接浏览 / 重命名 / 删除 / 新建，也能跳到 /system 等系统目录（只读）。\n";
    }

    private List<File> pathDirs() {
        List<File> dirs = new ArrayList<File>();
        File bin = new File(app.getFilesDir(), "bin");
        if (!bin.exists()) bin.mkdirs();
        File hbin = new File(homeDir(), "bin");
        if (!hbin.exists()) hbin.mkdirs();
        dirs.add(bin);
        dirs.add(hbin);
        String[] sys = {"/system/bin", "/system/xbin", "/vendor/bin", "/product/bin"};
        for (String p : sys) {
            File f = new File(p);
            if (f.isDirectory()) dirs.add(f);
        }
        return dirs;
    }

    /* ================= 执行命令 ================= */

    /**
     * 起一条命令（异步）。
     * 返回 {"ok":true,"job":"…","cwd":"…","pid":123}，输出通过 __termEv 推回。
     */
    public String runJson(String jobId, String cmd, String cwd, String envJson, int timeoutMs) {
        JSONObject out = new JSONObject();
        try {
            if (cmd == null || cmd.trim().isEmpty()) {
                out.put("ok", false);
                out.put("err", "命令为空");
                return out.toString();
            }
            String id = (jobId != null && jobId.matches("[A-Za-z0-9_-]{1,40}"))
                    ? jobId : "j" + seq.incrementAndGet();
            Job prev = jobs.get(id);
            if (prev != null) {
                killJob(prev);
                jobs.remove(id);
            }
            File dir = resolveDir(cwd);
            List<String> argv = new ArrayList<String>();
            if (new File(SETSID).exists()) argv.add(SETSID);
            argv.add(SH);
            argv.add("-c");
            /* 先把自己的 pid 写进缓存目录：libcore 的 Process.pid() 在部分版本返回 -1，
               而 setsid 之后 sh 的 pid 就是进程组 id，中断时靠它一次性收掉整组。 */
            final File pidFile = new File(app.getCacheDir(), "term-" + id + ".pid");
            try {
                if (pidFile.exists()) pidFile.delete();
            } catch (Throwable ignore) { }
            argv.add("echo $$ > " + pidFile.getAbsolutePath() + "; " + cmd);

            ProcessBuilder pb = new ProcessBuilder(argv);
            pb.directory(dir);
            pb.redirectErrorStream(false);
            Map<String, String> env = pb.environment();
            env.put("HOME", homeDir().getAbsolutePath());
            env.put("PATH", joinPaths());
            env.put("TMPDIR", app.getCacheDir().getAbsolutePath());
            env.put("TMP", app.getCacheDir().getAbsolutePath());
            env.put("PWD", dir.getAbsolutePath());
            env.put("SHELL", SH);
            env.put("TERM", "xterm-256color");
            env.put("LANG", "C.UTF-8");
            if (envJson != null && !envJson.isEmpty()) {
                JSONObject u = new JSONObject(envJson);
                Iterator<String> it = u.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if (k == null || !k.matches("[A-Za-z_][A-Za-z0-9_]{0,63}")) continue;
                    env.put(k, u.optString(k, ""));
                }
            }

            Process p = pb.start();
            /* 没有 tty 也没有交互输入：立刻关掉子进程的 stdin，
               否则 cat / read 这类命令会一直等输入，只能等 30s 超时 */
            try {
                p.getOutputStream().close();
            } catch (Throwable ignore) { }
            final Job job = new Job(id, p, pidFile);
            jobs.put(id, job);
            Thread t1 = pump(job, p.getInputStream(), "o");
            Thread t2 = pump(job, p.getErrorStream(), "e");
            final int to = Math.max(1000, Math.min(timeoutMs <= 0 ? DEFAULT_TIMEOUT_MS : timeoutMs, MAX_TIMEOUT_MS));
            waiter(job, new Thread[]{t1, t2});
            timer(job, to);

            out.put("ok", true);
            out.put("job", id);
            out.put("cwd", dir.getAbsolutePath());
            out.put("pid", job.pid);
        } catch (Throwable t) {
            return err("run", t);
        }
        return out.toString();
    }

    private static final class Job {
        final String id;
        final Process p;
        final File pidFile;
        volatile long pid;
        final long t0 = System.currentTimeMillis();
        final AtomicBoolean exited = new AtomicBoolean(false);
        final AtomicInteger bytes = new AtomicInteger(0);
        volatile boolean killed;

        Job(String id, Process p, File pidFile) {
            this.id = id;
            this.p = p;
            this.pidFile = pidFile;
            long v;
            try {
                v = p.pid();
            } catch (Throwable e) {
                v = -1;
            }
            this.pid = v;
        }
    }

    private Thread pump(final Job job, final InputStream in, final String kind) {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                InputStreamReader rd = null;
                try {
                    rd = new InputStreamReader(in, StandardCharsets.UTF_8);
                    char[] buf = new char[4096];
                    int n;
                    while ((n = rd.read(buf)) > 0) {
                        if (job.bytes.addAndGet(n) > MAX_JOB_OUT) {
                            if (!job.killed) {
                                emit(kind, job, "\n[单条命令输出超过 512 KB，已中断进程组]\n");
                            }
                            killJob(job);
                            break;
                        }
                        emit(kind, job, new String(buf, 0, n));
                    }
                } catch (Throwable ignore) {
                    /* 进程被杀时 read 抛 IOException，属正常退出路径 */
                } finally {
                    try {
                        if (rd != null) rd.close();
                    } catch (Throwable ignore) { }
                }
            }
        }, "term-" + kind + "-" + job.id);
        t.setDaemon(true);
        t.start();
        return t;
    }

    private void waiter(final Job job, final Thread[] pumps) {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                int code = -1;
                try {
                    code = job.p.waitFor();
                } catch (Throwable ignore) { }
                for (Thread pt : pumps) {
                    try {
                        pt.join(1500);
                    } catch (Throwable ignore) { }
                }
                job.exited.set(true);
                try {
                    jobs.remove(job.id);
                } catch (Throwable ignore) { }
                try {
                    job.pidFile.delete();
                } catch (Throwable ignore) { }
                JSONObject ev = new JSONObject();
                try {
                    ev.put("j", job.id);
                    ev.put("t", "x");
                    ev.put("c", code);
                    ev.put("ms", System.currentTimeMillis() - job.t0);
                    if (job.killed) ev.put("k", true);
                } catch (Throwable ignore) {
                    return;
                }
                eval("window.__termEv&&window.__termEv(" + ev.toString() + ")");
            }
        }, "term-wait-" + job.id);
        t.setDaemon(true);
        t.start();
    }

    private void timer(final Job job, final int timeoutMs) {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    long end = System.currentTimeMillis() + timeoutMs;
                    while (System.currentTimeMillis() < end) {
                        if (job.exited.get()) return;
                        Thread.sleep(200);
                    }
                    if (job.exited.get()) return;
                    job.killed = true;
                    emit("e", job, "\n[命令超过 " + (timeoutMs / 1000) + " 秒，已中断]\n");
                    killJob(job);
                } catch (Throwable ignore) { }
            }
        }, "term-timer-" + job.id);
        t.setDaemon(true);
        t.start();
    }

    /** 中断一条命令：先按进程组杀（setsid），再兜底杀进程本身。 */
    public void killJson(String jobId) {
        try {
            Job job = jobId == null ? null : jobs.get(jobId);
            if (job != null) killJob(job);
        } catch (Throwable e) {
            Log.w(TAG, "termKill 异常: " + e);
        }
    }

    public void killAll() {
        for (Job job : jobs.values()) {
            try {
                killJob(job);
            } catch (Throwable ignore) { }
        }
        jobs.clear();
    }

    private void killJob(Job job) {
        if (job == null) return;
        job.killed = true;
        long pid = ensurePid(job);
        if (pid > 1) {
            /* setsid 之后 pid == pgid，负号一次性收掉整组（子进程一起死） */
            try {
                Process k = new ProcessBuilder(KILL, "-9", "--", "-" + pid).start();
                waitQuiet(k, 1500);
            } catch (Throwable ignore) { }
            try {
                Process k2 = new ProcessBuilder(KILL, "-9", String.valueOf(pid)).start();
                waitQuiet(k2, 1000);
            } catch (Throwable ignore) { }
        }
        try {
            job.p.destroyForcibly();
        } catch (Throwable ignore) { }
    }

    /** 拿进程组 id：优先 Process.pid()，否则读 sh 自己写下的 pid 文件。 */
    private long ensurePid(Job job) {
        if (job.pid > 1) return job.pid;
        for (int i = 0; i < 10 && job.pid <= 1; i++) {
            long v = readPidFile(job.pidFile);
            if (v > 1) {
                job.pid = v;
                break;
            }
            try {
                Thread.sleep(20);
            } catch (Throwable ignore) { }
        }
        return job.pid;
    }

    private static long readPidFile(File f) {
        try {
            if (f == null || !f.isFile()) return -1;
            java.io.BufferedReader r = new java.io.BufferedReader(
                    new InputStreamReader(new FileInputStream(f), StandardCharsets.US_ASCII));
            try {
                String line = r.readLine();
                if (line == null) return -1;
                return Long.parseLong(line.trim());
            } finally {
                try {
                    r.close();
                } catch (Throwable ignore) { }
            }
        } catch (Throwable e) {
            return -1;
        }
    }

    private static void waitQuiet(Process p, long ms) {
        try {
            p.waitFor(ms, TimeUnit.MILLISECONDS);
        } catch (Throwable ignore) { }
    }

    /* ================= 文件系统辅助（补全 / cd / 文件面板） ================= */

    /** 路径信息：{"ok",exists,dir,size,abs,name,link,to}。 */
    public String statJson(String path, String cwd) {
        JSONObject out = new JSONObject();
        try {
            File f = resolve(path, cwd);
            out.put("ok", true);
            out.put("exists", f.exists());
            out.put("dir", f.isDirectory());
            out.put("abs", normalizePath(f.getAbsolutePath()));
            out.put("name", f.getName());
            out.put("size", f.isFile() ? f.length() : 0);
            out.put("parent", f.getParent() == null ? null : normalizePath(f.getParent()));
            LinkInfo li = linkOf(f);
            out.put("link", li.link);
            if (li.target != null) out.put("to", li.target);
        } catch (Throwable t) {
            return err("stat", t);
        }
        return out.toString();
    }

    /** 目录清单（文件面板）：{"ok",abs,parent,home,entries:[{n,p,d,f,link,to,size,mtime}]}。 */
    public String listJson(String path, String cwd) {
        JSONObject out = new JSONObject();
        try {
            File d = resolve(path, cwd);
            String abs = normalizePath(d.getAbsolutePath());
            out.put("abs", abs);
            out.put("home", normalizePath(homeDir().getAbsolutePath()));
            if (!d.exists()) {
                out.put("ok", false);
                out.put("err", "路径不存在: " + abs);
                return out.toString();
            }
            if (!d.isDirectory()) {
                out.put("ok", false);
                out.put("err", "不是目录: " + abs);
                return out.toString();
            }
            File[] fs = d.listFiles();
            if (fs == null) {
                out.put("ok", false);
                out.put("err", "没有权限读取该目录（App 沙箱限制）");
                return out.toString();
            }
            JSONArray arr = new JSONArray();
            for (File f : fs) {
                JSONObject o = new JSONObject();
                LinkInfo li = linkOf(f);
                o.put("n", f.getName());
                o.put("p", normalizePath(f.getAbsolutePath()));
                o.put("d", f.isDirectory());
                o.put("f", f.isFile());
                o.put("link", li.link);
                if (li.target != null) o.put("to", li.target);
                o.put("size", f.isFile() ? f.length() : 0);
                o.put("mtime", f.lastModified());
                arr.put(o);
            }
            out.put("ok", true);
            out.put("parent", d.getParent() == null ? "" : normalizePath(d.getParent()));
            out.put("entries", arr);
            out.put("count", arr.length());
        } catch (Throwable t) {
            return err("list", t);
        }
        return out.toString();
    }

    private static final class LinkInfo {
        final boolean link;
        final String target;

        LinkInfo(boolean link, String target) {
            this.link = link;
            this.target = target;
        }
    }

    /** 软链接检测 + 目标（lstat 不跟随链接）。 */
    private static LinkInfo linkOf(File f) {
        try {
            StructStat st = Os.lstat(f.getAbsolutePath());
            if (st != null && (st.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFLNK) {
                String to = null;
                try {
                    to = Os.readlink(f.getAbsolutePath());
                } catch (Throwable ignore) { }
                return new LinkInfo(true, to);
            }
        } catch (Throwable ignore) { }
        return new LinkInfo(false, null);
    }

    /** 重命名（同目录内改名）。 */
    public String renameJson(String path, String newName, String cwd) {
        JSONObject out = new JSONObject();
        try {
            File src = resolve(path, cwd);
            if (!src.exists()) {
                out.put("ok", false);
                out.put("err", "文件不存在: " + name(src));
                return out.toString();
            }
            String nm = newName == null ? "" : newName.trim();
            if (nm.isEmpty() || nm.contains("/") || nm.equals(".") || nm.equals("..")) {
                out.put("ok", false);
                out.put("err", "新名字不合法（不能包含 /，不能是 . 或 ..）");
                return out.toString();
            }
            File parent = src.getParentFile();
            File dst = new File(parent, nm);
            if (dst.exists()) {
                out.put("ok", false);
                out.put("err", "同目录下已有: " + nm);
                return out.toString();
            }
            if (!src.renameTo(dst)) {
                out.put("ok", false);
                out.put("err", "重命名失败（权限不足或目录只读）");
                return out.toString();
            }
            out.put("ok", true);
            out.put("abs", normalizePath(dst.getAbsolutePath()));
        } catch (Throwable t) {
            return err("rename", t);
        }
        return out.toString();
    }

    /** 删除（目录递归）。拒绝删除根 / HOME / filesDir / cacheDir。 */
    public String deleteJson(String path, String cwd) {
        JSONObject out = new JSONObject();
        try {
            File f = resolve(path, cwd);
            String abs = normalizePath(f.getAbsolutePath());
            if (!f.exists()) {
                out.put("ok", false);
                out.put("err", "文件不存在: " + name(f));
                return out.toString();
            }
            String[] guarded = {
                    "/",
                    normalizePath(homeDir().getAbsolutePath()),
                    normalizePath(app.getFilesDir().getAbsolutePath()),
                    normalizePath(app.getCacheDir().getAbsolutePath())
            };
            for (String g : guarded) {
                if (abs.equals(g)) {
                    out.put("ok", false);
                    out.put("err", "不允许删除该目录: " + abs);
                    return out.toString();
                }
            }
            boolean ok = deleteRec(f);
            out.put("ok", ok);
            out.put("abs", abs);
            if (!ok) out.put("err", "删除失败（权限不足或目录非空不可删）");
        } catch (Throwable t) {
            return err("delete", t);
        }
        return out.toString();
    }

    private static boolean deleteRec(File f) {
        if (f.isDirectory()) {
            File[] cs = f.listFiles();
            if (cs != null) {
                for (File c : cs) {
                    if (!deleteRec(c)) return false;
                }
            }
        }
        return f.delete();
    }

    /** 新建目录（支持多级）。 */
    public String mkdirJson(String path, String cwd) {
        JSONObject out = new JSONObject();
        try {
            File f = resolve(path, cwd);
            if (f.exists()) {
                out.put("ok", false);
                out.put("err", "已存在: " + name(f));
                return out.toString();
            }
            if (!f.mkdirs() && !f.isDirectory()) {
                out.put("ok", false);
                out.put("err", "创建失败（权限不足）");
                return out.toString();
            }
            out.put("ok", true);
            out.put("abs", normalizePath(f.getAbsolutePath()));
        } catch (Throwable t) {
            return err("mkdir", t);
        }
        return out.toString();
    }

    private static String name(File f) {
        String n = f.getName();
        return (n == null || n.isEmpty()) ? f.getAbsolutePath() : n;
    }

    /** Tab 补全：命令（PATH 里的可执行文件）或路径。allowCmd=false 时只补路径。 */
    public String completeJson(String prefix, String cwd, boolean allowCmd) {
        JSONObject out = new JSONObject();
        try {
            String p = prefix == null ? "" : prefix;
            boolean cmdMode = allowCmd && p.indexOf('/') < 0 && !p.startsWith("~") && !p.startsWith(".");
            if (cmdMode) {
                JSONArray items = new JSONArray();
                java.util.TreeSet<String> seen = new java.util.TreeSet<String>();
                for (File d : pathDirs()) {
                    File[] fs = d.listFiles();
                    if (fs == null) continue;
                    for (File f : fs) {
                        if (f.isFile() && f.canExecute() && f.getName().startsWith(p)) {
                            seen.add(f.getName());
                        }
                    }
                    if (seen.size() > 400) break;
                }
                for (String n : seen) items.put(n);
                out.put("ok", true);
                out.put("kind", "cmd");
                out.put("items", items);
                return out.toString();
            }
            String dirPart, base;
            int slash = p.lastIndexOf('/');
            if (slash >= 0) {
                dirPart = p.substring(0, slash + 1);
                base = p.substring(slash + 1);
            } else {
                dirPart = "";
                base = p;
            }
            File d = resolve(dirPart.isEmpty() ? "." : dirPart, cwd);
            JSONArray items = new JSONArray();
            if (d.isDirectory()) {
                File[] fs = d.listFiles();
                if (fs != null) {
                    java.util.Arrays.sort(fs, new java.util.Comparator<File>() {
                        @Override
                        public int compare(File a, File b) {
                            return a.getName().compareToIgnoreCase(b.getName());
                        }
                    });
                    for (File f : fs) {
                        String n = f.getName();
                        if (!n.startsWith(base)) continue;
                        if (n.startsWith(".") && !base.startsWith(".")) continue;
                        JSONObject it = new JSONObject();
                        it.put("n", f.isDirectory() ? n + "/" : n);
                        it.put("d", f.isDirectory());
                        items.put(it);
                        if (items.length() >= 400) break;
                    }
                }
            }
            out.put("ok", true);
            out.put("kind", "path");
            out.put("dir", normalizePath(d.getAbsolutePath()));
            out.put("items", items);
        } catch (Throwable t) {
            return err("complete", t);
        }
        return out.toString();
    }

    /** 写文本文件（rou get -o / 文件面板编辑）。 */
    public String writeFileJson(String path, String text, String cwd) {
        JSONObject out = new JSONObject();
        try {
            File f = resolve(path, cwd);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                out.put("ok", false);
                out.put("err", "无法创建目录: " + parent);
                return out.toString();
            }
            writeText(f, text == null ? "" : text);
            out.put("ok", true);
            out.put("path", normalizePath(f.getAbsolutePath()));
            out.put("bytes", f.length());
        } catch (Throwable t) {
            return err("write", t);
        }
        return out.toString();
    }

    /** 读文本文件（js <file> / 文件面板预览）。 */
    public String readFileJson(String path, String cwd, int maxBytes) {
        JSONObject out = new JSONObject();
        try {
            File f = resolve(path, cwd);
            if (!f.isFile()) {
                out.put("ok", false);
                out.put("err", "文件不存在: " + f.getAbsolutePath());
                return out.toString();
            }
            int cap = maxBytes <= 0 ? 512 * 1024 : Math.min(maxBytes, 4 * 1024 * 1024);
            long len = f.length();
            int readLen = (int) Math.min(len, cap);
            byte[] buf = new byte[readLen];
            FileInputStream fis = new FileInputStream(f);
            try {
                int off = 0;
                while (off < readLen) {
                    int n = fis.read(buf, off, readLen - off);
                    if (n <= 0) break;
                    off += n;
                }
                if (off < readLen) {
                    byte[] b2 = new byte[off];
                    System.arraycopy(buf, 0, b2, 0, off);
                    buf = b2;
                }
            } finally {
                try {
                    fis.close();
                } catch (Throwable ignore) { }
            }
            out.put("ok", true);
            out.put("text", new String(buf, StandardCharsets.UTF_8));
            out.put("size", len);
            out.put("truncated", len > readLen);
            out.put("abs", normalizePath(f.getAbsolutePath()));
        } catch (Throwable t) {
            return err("read", t);
        }
        return out.toString();
    }

    /* ================= 内部工具 ================= */

    private File resolve(String path, String cwd) {
        String p = path == null ? "" : path.trim();
        if (p.isEmpty()) return homeDir();
        if (p.equals("~")) return homeDir();
        if (p.startsWith("~/")) p = homeDir().getAbsolutePath() + p.substring(1);
        File f = new File(p);
        if (!f.isAbsolute()) f = new File(resolveDir(cwd), p);
        return new File(normalizePath(f.getAbsolutePath()));
    }

    private File resolveDir(String cwd) {
        try {
            if (cwd != null && !cwd.trim().isEmpty()) {
                File d = new File(normalizePath(cwd.trim()));
                if (d.isDirectory()) return d;
            }
        } catch (Throwable ignore) { }
        return homeDir();
    }

    /** 只做词法归一（去掉 . / .. / 重复斜杠），不解析符号链接，保证 /data/user/0 这类路径原样。 */
    static String normalizePath(String p) {
        if (p == null || p.isEmpty()) return "/";
        String[] parts = p.split("/");
        ArrayList<String> st = new ArrayList<String>();
        for (String s : parts) {
            if (s == null || s.isEmpty() || s.equals(".")) continue;
            if (s.equals("..")) {
                if (!st.isEmpty()) st.remove(st.size() - 1);
            } else {
                st.add(s);
            }
        }
        if (st.isEmpty()) return "/";
        StringBuilder sb = new StringBuilder();
        for (String s : st) sb.append('/').append(s);
        return sb.toString();
    }

    private String joinPaths() {
        StringBuilder sb = new StringBuilder();
        for (File f : pathDirs()) {
            if (sb.length() > 0) sb.append(':');
            sb.append(f.getAbsolutePath());
        }
        return sb.toString();
    }

    private static void writeText(File f, String text) {
        Writer w = null;
        try {
            w = new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8);
            w.write(text == null ? "" : text);
        } catch (Throwable e) {
            Log.w(TAG, "写文件失败 " + f + ": " + e);
        } finally {
            try {
                if (w != null) w.close();
            } catch (Throwable ignore) { }
        }
    }

    private void emit(String kind, Job job, String text) {
        if (text == null || text.isEmpty()) return;
        JSONObject ev = new JSONObject();
        try {
            ev.put("j", job.id);
            ev.put("t", kind);
            ev.put("d", text);
        } catch (Throwable ignore) {
            return;
        }
        eval("window.__termEv&&window.__termEv(" + ev.toString() + ")");
    }

    private void eval(String js) {
        final WebView w = web;
        if (w == null || js == null) return;
        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    w.evaluateJavascript(js, null);
                } catch (Throwable ignore) { }
            }
        });
    }

    private static String err(String where, Throwable t) {
        Log.w(TAG, "term " + where + " 失败: " + t);
        try {
            return new JSONObject().put("ok", false)
                    .put("err", t.getClass().getSimpleName() + ": " + t.getMessage()).toString();
        } catch (Throwable ignore) {
            return "{\"ok\":false,\"err\":\"term-failed\"}";
        }
    }
}
