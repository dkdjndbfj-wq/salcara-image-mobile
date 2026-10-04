# Salcara AI v1.8.0

Android 正式版，支持 ARM64 / ARMv7。提供手机助手、图片创作、语音与聊天伙伴，并可配合 Salcara Desktop 和 Hub 查看电脑项目与会话、继续支持的编程任务。

[下载 APK](https://github.com/dkdjndbfj-wq/salcara-image-mobile/releases/download/v1.8.0/salcara-image-android-v1.8.0.apk) · [使用教程](https://github.com/dkdjndbfj-wq/salcara-image-mobile/blob/main/docs/USER-GUIDE.zh.md) · [远程编程](https://github.com/dkdjndbfj-wq/salcara-image-mobile/blob/main/docs/REMOTE-PROGRAMMING.zh.md)

## 本版本

- 包含项目与会话的远程入口、电脑 API 选择、浅深主题和通知模块。
- 完善应用内更新的下载入口超时切换、取消保护、正式 APK 精确选择及发布清单校验。
- 更新包先完成大小与 SHA-256 校验，再交给 Android 系统确认安装。

包名保持 top.salcara.image，版本 1.8.0 / versionCode 21，沿用已有正式签名身份。已安装正式版请直接覆盖更新，不要先卸载。

Firebase 配置为可选部署能力，本包没有附带 Firebase 配置，不能保证关掉应用后收到推送。没有正式 iPhone / TestFlight 安装包。

远程不是屏幕投影。Claude Desktop 普通 Chat / Cowork 不支持原生远程发送或停止；原桌面窗口不保证即时刷新，Codex 原生适配仍需目标电脑验收。完整支持范围见远程编程教程。
