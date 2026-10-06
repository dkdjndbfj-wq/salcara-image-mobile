# Android 1.8.1 发布验收

- 最终 APK 源码：`cafafb7156833afc3869a13779905de0dce9272c`。
- 完整常规 CI：`37475478700`；正式 Android build：`37475485130`；独立 artifact 验证：`37478107609`，均成功。
- Expo Doctor 21/21、typecheck、完整 Jest 71 suites / 946 passed / 8 skipped（954 total）、10 项更新发布工具回归通过。
- 核验 APK SHA-256、ZIP CRC、arm64-v8a / armeabi-v7a 的实际 ELF、包名及旧正式签名覆盖兼容。包名 `top.salcara.image`，versionName 1.8.1，versionCode 21 → 22。
- 正式证书 SHA-256 保持 `9714443d4c0679227ff3bf1dd43ee13bfdd05c1a8253ab46d6c6608f29d8bc33`，这是公开证书指纹，不是签名私钥。
- 最终 APK：97,835,269 bytes；SHA-256 `649c3149e691b5c4d4e809464edde061727cfd3848a67cce4225b92be833fa3b`。
- [v1.8.1](https://github.com/dkdjndbfj-wq/salcara-image-mobile/releases/tag/v1.8.1) 指向实际被测提交，APK 和同名 `.sha256` 与独立验证产物一致，未重建或重签替代文件。

发布门禁发现并修复四个 Expo SDK 57 补丁依赖落后，lockfile 同步其补丁传递依赖；没有禁用 Doctor 检查。首轮构建虽然通过 APK 校验，但未公开，最终只发布上述新源码和字节。Windows 新依赖冷缓存首次测试出现一次审批测试超时；未修改断言/超时或新增跳过，定向及完整重跑通过，Linux CI 也通过。

发布脚本为更新清单显式指定 GitHub noreply author/committer，避免人工运行 Contents API 带出个人邮箱。版本清单只在正式 APK 公开后更新。公开源码与说明通过敏感信息检查，未提交真实 API Key、服务器凭据、设备私有配置或 Android keystore。

手机源码没有重新设计 UI、文案或动效。SDK 补丁和自动化测试不能代替手机真机相机、弱网、后台省电与双公网 Hub 验收。A Hub 在交接前彻底离线时，独立备用控制通道仍未实现；Codex native 需有效授权，Claude Desktop 原生 Chat/Cowork 仍只读。当前没有正式 iOS 安装包。
