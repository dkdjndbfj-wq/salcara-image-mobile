# iOS 开发构建

[开发指南](DEVELOPMENT.md) · [产品首页](../README.md)

当前正式发行的是 Android APK，没有面向普通用户的 iPhone / TestFlight 安装包。源码、未签名 IPA 和模拟器 App 都不能直接作为正式 iPhone 安装包使用；此页仅说明开发者如何从完整仓库生成 iOS 工程。

## 准备

使用 macOS、兼容当前 Expo / React Native 的 Xcode、Node.js 22 和 CocoaPods。克隆正式仓库，进入根目录；iOS 与 Android 使用同一套手机源码。当前应用身份为 top.salcara.image，1.8.0 / buildNumber 21，实际值以检出的 app.json 为准。

## 生成与运行

~~~bash
npm ci --legacy-peer-deps
node scripts/verify-release-version.mjs
npm run typecheck
npx expo prebuild --platform ios
~~~

生成后用 Xcode 打开 ios 目录中的 .xcworkspace，选择实际 scheme 和 iPhone 模拟器，再运行。也可以使用：

~~~bash
npx expo run:ios
~~~

本地原生模块在 modules 中，与手机主代码统一维护。使用 CocoaPods 时不要用 .xcodeproj 替代 .xcworkspace。prebuild 会生成或更新原生项目，先保存已有原生改动；不要在有未提交修改的工程随意使用 clean。

## 真机与用户分发

真机运行需要适当的 Apple 开发签名与描述文件；在 Xcode 选择自己的开发团队和设备。公开长期分发还需要正确的 Apple 分发配置，不能把关闭代码签名的构建当作可安装正式包。

现有 Unsigned iOS IPA workflow 仅供检查源码构建，手动运行时选择想核验的确切标签；它不会创建正式签名身份或提供普通用户安装渠道。其默认历史标签不代表当前最新版本。

没有在本轮执行 Xcode / iPhone 实机验收。语音、通知、系统操作与后台行为存在平台差异，Android 测试通过不能替代 iOS 验收。未经签名与设备验证，不在 README 宣布 iPhone 正式可用。
