package com.rou.parser;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.util.Log;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;

/**
 * Lightweight web hotfix channel.
 *
 * Fetches a small JSON document from a fixed HTTPS URL:
 *   {"version":1, "css":"...", "js":"..."}
 * The CSS is injected as a <style> tag; the JS is evaluated after page load.
 * Patches are cached in SharedPreferences and re-applied on every launch, so
 * a CSS/JS interaction bug can be fixed without shipping a new APK.
 *
 * Only web-layer fixes belong here. Native/Python changes still require an APK.
 */
public final class HotFix {
    private static final String TAG = "rou.hotfix";
    private static final String URL = "https://cloud.lenv.top/pub/jiexi/hotfix.json";
    private static final String PREFS = "rouparser_hotfix";
    private static final String KEY_JSON = "json";
    private static final String KEY_PREV = "prev_json";
    private static final String PUB_B64 = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlBV+B3naHspDIwuG0nd7EkT+l6IAbB7I7Ovee/7fbN8TAb0uxUfZh/Px6ks32WtaEScEOGTMIPy3xKysCW5daCshAPlUM2gNQy+B/Cmcjrfubjm3koFK2erX1ZzaJUAK1G+H8uyCCvV9KSp9z40M6HjLf4y0FjIhxains0DzeZtEpAJZMmncmO1XvyoJsUu3YcNaiohTpl3RiPyWg6ftn2nxCWUiNfmkioSSFxvM84SnhuWK9JTijmJmdTzv0Lt/WNh3K4+CiJ0jKQNsnPXgRouMDJUuWIIPzLi4//+pfGHo8Mxz3aFN+MVNb90PrCOevAaz4+Y/7VgCuHkkSYyU+QIDAQAB";

    private final WebView web;
    private final SharedPreferences sp;
    private final Context appCtx;
    private int version = 0;
    private String css = "";
    private String js = "";
    private volatile boolean checked = false;
    /** 回滚重入保护，避免回滚路径再次触发版本校验。 */
    private volatile boolean rollingBack = false;

    public HotFix(Context ctx, WebView web) {
        this.web = web;
        this.appCtx = ctx.getApplicationContext();
        this.sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        loadCached();
    }

    private void loadCached() {
        try {
            String raw = sp.getString(KEY_JSON, "");
            if (raw == null || raw.isEmpty()) return;
            applyJson(new JSONObject(raw), false);
        } catch (Throwable e) {
            Log.w(TAG, "cache parse failed: " + e);
        }
    }


    /** 验签：version + "\n" + css + "\n" + js，SHA256withRSA；无签名或失败拒绝。 */
    private boolean eligible(JSONObject o) {
        int r = o.optInt("rollout", 100);
        if (r >= 100) return true;
        if (r <= 0) return false;
        try {
            String id = android.provider.Settings.Secure.getString(
                appCtx.getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
            int b = (String.valueOf(id) + appCtx.getPackageName()).hashCode() & 0x7fffffff;
            return (b % 100) < r;
        } catch (Throwable e) { return true; }
    }

    private boolean verify(JSONObject o) {
        try {
            String sig = o.optString("sig", "");
            if (sig.isEmpty()) return false;
            int v = o.optInt("version", 0);
            String c = o.optString("css", "");
            String j = o.optString("js", "");
            int r = o.optInt("rollout", 100);
            if (verifyPayload(v + "\n" + c + "\n" + j + "\n" + r, sig)) return true;
            return verifyPayload(v + "\n" + c + "\n" + j, sig);
        } catch (Throwable e) {
            Log.w(TAG, "verify failed: " + e);
            return false;
        }
    }

    private boolean verifyPayload(String payload, String sig) {
        try {
            byte[] key = Base64.decode(PUB_B64, Base64.DEFAULT);
            PublicKey pk = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(key));
            Signature s = Signature.getInstance("SHA256withRSA");
            s.initVerify(pk);
            s.update(payload.getBytes(StandardCharsets.UTF_8));
            return s.verify(Base64.decode(sig, Base64.DEFAULT));
        } catch (Throwable e) { return false; }
    }

    private boolean applyJson(JSONObject o, boolean notify) {
        if (!verify(o)) { Log.w(TAG, "unsigned/invalid hotfix rejected"); return false; }
        int v = o.optInt("version", 0);
        String c = o.optString("css", "");
        String j = o.optString("js", "");
        if (v <= 0 && c.isEmpty() && j.isEmpty()) return false;
        version = v;
        css = c;
        js = j;
        if (notify) {
            try {
                web.post(new Runnable() {
                    @Override public void run() {
                        try {
                            web.evaluateJavascript("try{UI.toast('页面资源已热更新 v" + v + "')}catch(e){}", null);
                        } catch (Throwable ignore) { }
                    }
                });
            } catch (Throwable ignore) { }
        }
        return true;
    }

    /** Called from MainActivity after the page has finished loading. */
    public void onPageFinished() {
        apply();
        if (version > 0) checkApplied(version, sp.getString(KEY_PREV, ""));
        checkAsync();
    }

    private void apply() {
        if ((css == null || css.isEmpty()) && (js == null || js.isEmpty())) {
            try { web.evaluateJavascript("window.__rouHotfixVersion=" + version, null); } catch (Throwable ignore) { }
            return;
        }
        try {
            JSONObject o = new JSONObject();
            o.put("css", css == null ? "" : css);
            o.put("js", js == null ? "" : js);
            String code =
                "(function(){try{" +
                "var d=document.getElementById('rou-hotfix-css');" +
                "if(!d){d=document.createElement('style');d.id='rou-hotfix-css';document.head.appendChild(d);}" +
                "d.textContent=" + JSONObject.quote(css == null ? "" : css) + ";" +
                "var s=document.createElement('script');s.id='rou-hotfix-js';" +
                "s.textContent=" + JSONObject.quote(js == null ? "" : js) + ";" +
                "document.body.appendChild(s);" +
                "window.__rouHotfixVersion=" + version + ";" +
                "}catch(e){console.log('hotfix apply error '+e)}})();";
            web.evaluateJavascript(code, null);
            Log.i(TAG, "applied v" + version + " css=" + (css == null ? 0 : css.length()) + " js=" + (js == null ? 0 : js.length()));
        } catch (Throwable e) {
            Log.w(TAG, "apply failed: " + e);
        }
    }

    /** 解析 evaluateJavascript 返回值：数字直接解析，引号字符串去引号；缺失/非法返回 -1。 */
    private static int parseVersion(String s) {
        if (s == null) return -1;
        s = s.trim();
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) s = s.substring(1, s.length() - 1);
        try {
            return Integer.parseInt(s);
        } catch (Throwable e) {
            return -1;
        }
    }

    /**
     * 新版本应用后校验 window.__rouHotfixVersion 是否真的生效；
     * 缺失或低于新版本且存在上一份已验签缓存时回滚。必须在主线程调用。
     */
    private void checkApplied(final int v, final String prevRaw) {
        if (rollingBack || prevRaw == null || prevRaw.isEmpty()) return;
        try {
            web.postDelayed(new Runnable() {
                @Override public void run() {
                    try {
                        web.evaluateJavascript("window.__rouHotfixVersion", new ValueCallback<String>() {
                            @Override public void onReceiveValue(String value) {
                                if (rollingBack) return;
                                if (parseVersion(value) >= v) return;
                                rollback(prevRaw, v);
                            }
                        });
                    } catch (Throwable e) {
                        Log.w(TAG, "version check failed: " + e);
                    }
                }
            }, 800);
        } catch (Throwable e) {
            Log.w(TAG, "version check failed: " + e);
        }
    }

    /** 回滚到上一份缓存 JSON；同样必须通过验签，失败则保持现状。主线程调用。 */
    private void rollback(final String prevRaw, int badVersion) {
        if (rollingBack) return;
        rollingBack = true;
        try {
            if (!applyJson(new JSONObject(prevRaw), false)) {
                Log.w(TAG, "rollback rejected: previous unsigned/invalid");
                return;
            }
            sp.edit().putString(KEY_JSON, prevRaw).apply();
            apply();
            Log.i(TAG, "rolled back from v" + badVersion + " to v" + version);
        } catch (Throwable e) {
            Log.w(TAG, "rollback failed: " + e);
        } finally {
            rollingBack = false;
        }
    }

    /** Background check; safe to call repeatedly. */
    public void checkAsync() {
        if (checked) return;
        checked = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    NetClient.Fetched f = NetClient.get().fetchSync(URL, "{}", 15000, 1024 * 1024);
                    if (f == null || f.bytes == null) return;
                    String raw = new String(f.bytes, "UTF-8").trim();
                    JSONObject o = new JSONObject(raw);
                    int v = o.optInt("version", 0);
                    if (v <= version) return;
                    // 先验签，未通过绝不落盘/应用。
                    if (!verify(o)) { Log.w(TAG, "unsigned/invalid hotfix rejected"); return; }
                    // 保留上一份已成功应用的原始 JSON，再写入新版本。
                    final String prevRaw = sp.getString(KEY_JSON, "");
                    SharedPreferences.Editor ed = sp.edit();
                    if (prevRaw != null && !prevRaw.isEmpty()) ed.putString(KEY_PREV, prevRaw);
                    ed.putString(KEY_JSON, raw);
                    ed.apply();
                    if (!applyJson(o, true)) return;
                    web.post(new Runnable() {
                        @Override
                        public void run() {
                            apply();
                            checkApplied(v, prevRaw);
                        }
                    });
                    Log.i(TAG, "downloaded v" + v);
                } catch (Throwable e) {
                    Log.w(TAG, "check failed: " + e);
                }
            }
        }, "hotfix").start();
    }

    public String statusJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("version", version);
            o.put("css", css == null ? 0 : css.length());
            o.put("js", js == null ? 0 : js.length());
            return o.toString();
        } catch (Throwable e) {
            return "{\"version\":0}";
        }
    }
}
