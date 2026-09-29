# 在 Mac 上构建 Salcara AI（iOS 源码包）

这个 ZIP 是 Expo / React Native 源码，**没有证书、描述文件、最终签名或现成 IPA**。它需要在 Mac 上用 Xcode 编译。

## 准备

- 安装 Xcode、iOS Simulator、Node.js 22 和 CocoaPods。
- 解压 `salcara-ai-ios-source-v1.7.0.zip`，在终端进入其中的 `salcara-image-mobile` 文件夹。

## 生成 Xcode 工程

```sh
npm ci --legacy-peer-deps
npx expo prebuild --platform ios
open ios/*.xcworkspace
```

在 Xcode 顶部选择 Salcara AI 的 scheme 和一个 iPhone **模拟器**，点 Run。第一次生成原生工程和安装 CocoaPods 可能需要一些时间。不要用 `.xcodeproj` 替代 `.xcworkspace`，否则 CocoaPods 依赖可能缺失。

## 编译不带签名的模拟器 `.app`

先在 Xcode 中确认 scheme 名称，或运行 `xcodebuild -list -workspace ios/*.xcworkspace` 查看。把以下命令的 `<scheme>` 换成实际名称：

```sh
xcodebuild \
  -workspace ios/*.xcworkspace \
  -scheme '<scheme>' \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/ios-unsigned \
  CODE_SIGNING_ALLOWED=NO \
  build
```

产物位于 `build/ios-unsigned/Build/Products/Release-iphonesimulator/` 中，是**只能给模拟器使用**的未签名 `.app`。本项目的 iOS 原生模块源码已包含在 `modules/`，但打包 ZIP 时没有 Mac 环境，无法代替你验证 Xcode 编译结果。

## 如果要在真机上安装

iPhone 不能安装未签名的模拟器 `.app`。你可以在 Xcode 的 **Signing & Capabilities** 里选择自己的 Apple Account / Personal Team，连接自己的 iPhone，再用 Xcode Run 安装。这是开发测试签名，不是本 ZIP 附带的最终分发签名；免费 Personal Team 的配置文件有效期为 7 天，到期后需要重新编译安装。要向其他用户长期分发，则需要合适的 Apple 开发者分发方式和签名。

本项目的 iOS 包名是 `top.salcara.image`，版本为 `1.7.0 (20)`。如果你的 Personal Team 提示该包名不可注册，可以在 `app.json` 修改 `ios.bundleIdentifier` 为你自己的唯一值，再重新运行 `npx expo prebuild --platform ios --clean`；这样它将是另一款应用，不能覆盖原包名安装。
