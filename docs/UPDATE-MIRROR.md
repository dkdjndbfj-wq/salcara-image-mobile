# Salcara 更新镜像部署

部分手机网络可以访问 `salcara.top`，但无法访问 GitHub 的网页或发布资源。应用因此预留了同域名更新入口，避免把用户强制跳到打不开的浏览器页面。

## 必须提供的两个 HTTPS 地址

```text
https://salcara.top/app/latest.json
https://salcara.top/downloads/salcara-image-android-v1.2.1.apk
```

文件名会随版本变化。`latest.json` 必须是本项目 CI 发布到 `updates` 分支的完整清单，至少包含：

```json
{
  "version": "1.2.1",
  "tagName": "v1.2.1",
  "publishedAt": "2026-09-22T00:00:00Z",
  "apk": {
    "name": "salcara-image-android-v1.2.1.apk",
    "size": 99890144,
    "digest": "sha256:<64 位小写十六进制摘要>",
    "url": "https://github.com/dkdjndbfj-wq/salcara-image-mobile/releases/download/v1.2.1/salcara-image-android-v1.2.1.apk",
    "apiUrl": "https://api.github.com/repos/dkdjndbfj-wq/salcara-image-mobile/releases/assets/<asset-id>"
  }
}
```

不要手工修改 `size` 或 `digest`。直接复制 GitHub Release 中的 APK 和 `.sha256`，并用服务器上的文件重新计算一次 SHA-256：

```bash
sha256sum salcara-image-android-v1.2.1.apk
stat -c '%s' salcara-image-android-v1.2.1.apk
```

文件必须原样提供，不能经过图片压缩、文本模式转换或 HTML 下载页包装。建议返回 `Content-Type: application/vnd.android.package-archive`、正确的 `Content-Length`，并且不做登录跳转。

## Nginx 示例

把 APK 放到 `/srv/salcara-updates/downloads/`，把清单放到 `/srv/salcara-updates/app/latest.json`：

```nginx
location = /app/latest.json {
    alias /srv/salcara-updates/app/latest.json;
    default_type application/json;
    add_header Cache-Control "no-cache" always;
}

location /downloads/ {
    alias /srv/salcara-updates/downloads/;
    types { application/vnd.android.package-archive apk; }
    add_header Content-Disposition "attachment" always;
    add_header Cache-Control "public, max-age=300" always;
}
```

清单和 APK 必须都通过有效的 TLS 证书访问。不要把 `/downloads/` 反向代理到一个会返回 HTML 错误页的登录系统。

## 每次发布后的顺序

1. 等 GitHub Actions 完成签名 APK、覆盖安装校验和 Release 发布。
2. 下载新的 APK、`.sha256` 和 `updates/latest.json`。
3. 上传 APK 与清单到上述两个 Salcara 路径。
4. 在手机浏览器或 `curl -I` 检查两个地址均返回 `200`，APK 的 `Content-Length` 与清单 `size` 相同。
5. 打开 App 的「关于与更新」检查。应用会先尝试同域名镜像，校验通过后才弹出 Android 安装器。

镜像不是必须的：如果用户网络能访问 GitHub API，应用也会尝试 GitHub API Asset 和官方发布地址。镜像只解决 GitHub 在特定网络不可达的问题。应用始终比较 SHA-256，未知域名或错误文件不会被安装。

