# 热修复与更新

## 热修复通道

```text
https://cloud.lenv.top/pub/jiexi/hotfix.json
```

只更新 Web 层：

- CSS
- JS

不能更新：

- Java/native
- Python
- APK 资源

## 签名

负载：

```text
version + "\n" + css + "\n" + js + "\n" + rollout
```

RSA-SHA256。

- 无 `sig` 拒绝；
- 验签失败拒绝；
- 兼容旧版三行负载。

## 灰度

```json
{ "rollout": 30 }
```

按设备哈希分桶，小于 30 的设备应用；100 为全量。

## 回滚

- 应用后检查 `window.__rouHotfixVersion`；
- 800ms 后仍未达到新版本，恢复上一份已验签 JSON；
- 冷启动也会检查；
- 回滚内容同样必须验签。

## APK 更新

```text
https://cloud.lenv.top/pub/jiexi/version.json
```

```json
{
  "versionName": "1.10.36",
  "versionCode": 92,
  "url": "https://cloud.lenv.top/pub/jiexi/JieXi-1.10.36-arm64.apk",
  "notes": "..."
}
```

App 内：设置 → 关于 → 检查更新 → 下载并安装。

安装需要“安装未知应用”权限。

## 安全边界

- 热修复私钥不在 APK 内；
- 渠道域名仍是个人域名；
- 私钥泄露等于页面级 RCE；
- 只信任自己发布的签名。
