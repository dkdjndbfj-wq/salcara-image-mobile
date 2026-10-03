# Salcara AI v1.8.0

Android 正式应用，包名保持 `top.salcara.image`，版本号 1.8.0 / versionCode 21。沿用上一版本签名身份，保留已有应用数据。

- 发布 Claude 已完成的手机代码，包括远程编程、浅深主题和通知模块；本次没有重新设计界面或动画。
- 补齐自动更新的下载入口超时切换、取消保护、正式 APK 精确选择和已发布清单校验。
- 更新包先完成大小与 SHA-256 校验，再交给 Android 安装器；安装仍需用户同意系统提示。

Firebase 配置为可选项；本包没有包含 Firebase 服务账号。iOS 尚无正式签名发行身份，本次不提供可安装 iPhone 包。

远程能力受 Agent 原生接口和用户授权限制。Claude Desktop 原生 Chat/Cowork 发送与停止不应被视为已实现；Codex 桌面适配仍需目标电脑验收。
