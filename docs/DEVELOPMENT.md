# 开发与贡献

[产品首页](../README.md) · [文档目录](README.md)

## 正式项目

- 产品名称：Salcara AI。
- 正式仓库：dkdjndbfj-wq/salcara-image-mobile，源码在 main。
- Android 包名／iOS bundle ID：top.salcara.image。保持这些身份可避免把更新变成另一款应用。
- 当前正式 Android 版本：1.8.1 / versionCode 22，沿用正式签名和包名；发布记录见对应版本说明。
- updates 分支只保存正式版本清单，不是另一份应用源码，也不是另一个发布渠道。

package.json 的 private 防止误发到 npm，不表示 GitHub 项目闭源。历史测试构建使用独立包名，不用于正式更新；不要把调试包或本地工作目录发布成第二款正式产品。

## 目录

| 目录 | 内容 |
| --- | --- |
| src、App.tsx、index.ts | 手机应用、状态与 API 请求逻辑 |
| assets | 正式品牌和资源 |
| modules | 语音、PDF、手机操作和通知原生模块 |
| scripts | 版本、签名配置、产物校验与更新发布工具 |
| .github/workflows | CI、正式 Android 构建和只读产物验收 |
| docs | 用户教程和开发说明 |
| docs/maintainers | 历史验收、设计资料与维护审查记录 |
| remote | 指向独立正式配套项目的兼容文档，不含旧 Hub/Bridge 内核 |

桌面使用 [salcara-desktop](https://github.com/dkdjndbfj-wq/salcara-desktop)，服务端使用 [salcara-hub-plugin](https://github.com/dkdjndbfj-wq/salcara-hub-plugin)。后者保留既有仓库名以兼容链接，但当前产品是独立 Docker 服务，不要求修改 Sub2API。

## 本地启动

使用 Node.js 22、npm；Android 原生构建还需要 JDK 21 和 Android SDK。以锁文件和当前 GitHub workflow 为准。

~~~bash
npm ci --legacy-peer-deps
node scripts/verify-release-version.mjs
npm run typecheck
npm test
node --test scripts/update-manifest-core.test.mjs scripts/release-workflow-contract.test.mjs
npx expo prebuild --platform android --no-install
npx expo run:android
~~~

本地开发使用开发签名，不能覆盖正式签名 APK。原生模块需要 development build／原生构建，不要用 Expo Go 成功启动当作所有原生功能已验证。prebuild 会生成原生工程，先保存已有原生改动，勿在含未保存修改的工程直接使用 clean。

iOS 见 [iOS 开发指南](IOS-MAC-BUILD.md)；用户分发与开发者源码构建是两件事。

## 构建与发布

普通 main 提交运行 CI，不自动发布 APK。正式 Android Release workflow 的手动运行用于构建和验收产物；正式版本通过匹配应用版本的 vX.Y.Z 标签发布。

发布前保持 package.json、app.json 和对应系统版本号一致。正式包使用原签名身份，严格校验上一版本的精确 APK、包名、证书和递增 versionCode；不要为了通过门禁而替换签名、跳过测试或删除已有用例。

签名材料只通过 GitHub Actions Secrets 注入临时文件，不提交 keystore、私钥、密码或 Firebase 私有配置。外部贡献者没有生产签名身份，不能生成可覆盖官方应用的正式包。

发布顺序是：测试 → 构建并签名 → 产物和升级兼容校验 → 公开 Release 资产 → 更新 updates 清单。校验清单不是独立 Ed25519 签名 feed；Android 最终覆盖安装还由系统验证签名。镜像运营见 [更新镜像部署](UPDATE-MIRROR.md)。

不要编辑旧标签、替换已公开 APK 或变更已宣布版本的字节。只修改文档不需要增加应用版本或重新签发安装包；历史发布证据见 [1.8.0 验收记录](maintainers/RELEASE-1.8.0-VERIFICATION.md)。

## 提交前检查

执行上面的类型检查、Jest 和发布脚本测试；设备验收见 [测试说明](TESTING.md)。UI、内核、发布流程和文档应分别说明改动范围。

问题反馈和测试 fixture 不要包含真实 API Key、配对二维码、设备令牌、用户聊天或服务器凭据。不要把本地缓存、生成目录、预览、APK 或依赖目录提交到源码。
