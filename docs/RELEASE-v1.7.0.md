# Salcara AI v1.7.0

Android `versionCode` 从 19 递增到 20，可覆盖安装 v1.6.2。应用包名和发布签名保持不变；本地会话、文件及服务商设置不会因覆盖安装而清除。

## 本次更新

- 统一对话、图片创作与工具调用的交互，补充文件预览、语音服务与远程会话入口。
- 改进图片和对话请求的错误处理、网络诊断以及应用更新体验。
- 补齐 iOS 原生语音、PDF 渲染、日历模块的源码，准备独立的 Mac/Xcode 源码包。
- 维护 Expo SDK 57 依赖版本，修正 Android / iOS 版本信息不一致的问题。

## 验证

- TypeScript 类型检查与 Expo Doctor 通过。
- 自动化测试通过；Android APK 由 GitHub Actions 使用原有发布证书签名，并在发布前检查旧版覆盖安装兼容性。
- iOS 使用独立的 GitHub macOS 26 / Xcode 26 流水线编译出未签名真机 IPA，校验 ZIP 完整性与 SHA-256；尚未做签名后的 iPhone 真机安装测试。

## iOS 未签名 IPA

`salcara-ai-ios-unsigned-v1.7.0.ipa` 是真机安装包，**未签名，不能直接安装**。用户需在本地使用有效的签名证书及匹配的描述文件自行签名，再安装到符合描述文件要求的 iPhone。P12 文件单独使用不够；描述文件还需匹配应用标识 `top.salcara.image`，Ad Hoc 安装时需包含设备 UDID。不要把 P12 私钥和密码交给不可信的在线签名网站。旁边的 `.sha256` 文件可用于核对下载完整性。

`salcara-ai-ios-source-v1.7.0.zip` 仍是源码包，不是可直接安装的 IPA。应用不内置 API 密钥。
