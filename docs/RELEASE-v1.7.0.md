# Salcara AI v1.7.0

Android `versionCode` 从 19 递增到 20，可覆盖安装 v1.6.2。应用包名和发布签名保持不变；本地会话、文件及服务商设置不会因覆盖安装而清除。

## 本次更新

- 统一对话、图片创作与工具调用的交互，补充文件预览、语音服务与远程会话入口。
- 改进图片和对话请求的错误处理、网络诊断以及应用更新体验。
- 补齐 iOS 原生语音、PDF 渲染、日历模块的源码，准备独立的 Mac/Xcode 源码包；iOS 尚未在本次 Android 发布流水线中编译或签名。
- 维护 Expo SDK 57 依赖版本，修正 Android / iOS 版本信息不一致的问题。

## 验证

- TypeScript 类型检查与 Expo Doctor 通过。
- 自动化测试通过；Android APK 由 GitHub Actions 使用原有发布证书签名，并在发布前检查旧版覆盖安装兼容性。

应用不内置 API 密钥。iOS 源码包只用于在 Mac 上构建，不是可直接安装到 iPhone 的无签名 IPA。
