# 手机可以打开网站，为什么 App 仍连接失败？

生成过程可能连接三个不同域名：用户配置的 API、API 返回的图片外链、GitHub 更新服务器。`salcara.top` 可以打开，只能说明网站当前可达，不能证明返回图片的 CDN 或 GitHub 可达。手机私人 DNS、IPv6 路由、证书链和代理的应用分流也可能让浏览器与 App 表现不同。

App 的“网络诊断”只访问当前服务商的 `/v1/models`，以及已有图片外链的 HEAD 请求。API 密钥只发往配置的 API，不发往图片 CDN、GitHub 或任何诊断第三方。诊断显示域名和耗时，不显示密钥、图片签名链接。可以关闭节点检测一次，再开启节点对比。

## sub2api 服务商推荐配置

管理后台 → 账号管理 `/admin/accounts` → 编辑实际处理图片的 **OpenAI / API Key** 上游账号 → 打开 **生图结果 URL 转 base64** → 保存。对分组下所有可能被调度的生图账号都应检查此项。

该开关对应账号 `extra.images_url_to_b64_json: true`。如通过管理 API 操作，先 `GET /api/v1/admin/accounts/{id}`，再 `PUT` 同一路径，将新字段合并进原来的 `extra`，不要覆盖其他设置。不要把管理员令牌或上游密钥放到手机 App 或公开仓库。

开启后，sub2api 服务器下载上游图片，将 `b64_json` 一起返回给手机；手机不再需要直接连接图片 CDN。它不改变模型、画质、像素或收费。服务器必须能够连接图片 CDN；下载失败时 sub2api 仍可能原样返回 URL。旧版 sub2api 没有此开关时，需要先升级服务端。

App 优先保存 `b64_json`，也兼容内嵌 data URL 和普通 HTTPS 图片链接。不会为 GPT Image 默认添加官方不支持的 `response_format` 参数。

## 图片下载与取消

图片下载使用明确选择的 Expo 流式网络实现，避免把 4K 原图完整复制到 JavaScript 内存。每次下载最多 90 秒，失败后只重新下载两次，最后一次尝试另一种原生下载实现。失败或用户取消时保留原图片链接，点击“重新下载”只获取已经生成的原图，不重新调用收费的生成接口。原链接过期需要联系服务商，不能保证旧链接永远可用。

HTTP 401/403 意味着服务器已连接但拒绝访问；证书错误、DNS 错误和下载超时会分别解释，并显示实际失败的服务器域名。

## 更新渠道

更新元数据优先从 Salcara 更新站 `https://salcara.top/app/latest.json` 读取，其次是 GitHub 正式 Release API、`updates` 分支的 `latest.json`（通过 jsDelivr 或 GitHub Raw 读取）。清单只在签名 APK、SHA-256 已成功发布后由 CI 写入，不再使用开发分支的 `app.json` 猜测新版本。

应用内下载不再把 APK 交给外部浏览器，而是按以下顺序尝试：

1. `https://salcara.top/downloads/<APK 文件名>`（或清单里的 `mirrorUrl`）；
2. GitHub API 的单个 Release Asset 地址；
3. GitHub Release 的公开下载地址。

每个入口下载到应用缓存中的 `.part` 临时文件，先检查 ZIP/APK 文件头、精确大小和 SHA-256，再原子移动到安装路径，最后才调用 Android 安装器。中断、超时、HTML 错误页和截断文件都会被删除，不会再出现把半个 APK 交给系统导致“解析安装包失败”。安装失败时已校验的文件会保留，可重新打开安装器，不会重复下载或重复扣费。

如果目标地区无法连接 GitHub，运营方需要在 Salcara 域名部署同一份签名 APK 与清单。完整配置见[更新镜像部署说明](./UPDATE-MIRROR.md)。不要把 APK 或 API 密钥交给未知代理站；即使下载入口被替换，应用也会因 SHA-256 不匹配而拒绝安装。

发布 CI 必须拿到上一正式版 APK 才能验证同一签名及递增版本号，网络失败不会跳过覆盖安装检查。

带 API 密钥的请求关闭自动重定向与共享 Cookie，防止地址跳转时意外转发密钥或附件；遇到跳转提示，请直接填写服务商最终的 API 地址。

App 启动时自动检查；进入前台时，成功检测距今超过 6 小时或失败检测距今超过 15 分钟会重查。用户始终可以手动检查。

参考：[Expo FileSystem](https://docs.expo.dev/versions/latest/sdk/filesystem/)、[sub2api 上游项目](https://github.com/Wei-Shaw/sub2api)。
