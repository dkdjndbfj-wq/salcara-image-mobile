# Salcara AI 1.8.0 发布与更新验收记录

本页保留该版本实际构建、修复和发布证据，仅供维护者复核，不是安装教程。用户请从 [产品首页](../../README.md) 或 [使用教程](../USER-GUIDE.zh.md) 开始。

## 范围及保护

- 当时使用隔离发布工作目录，保留既有未提交工作，不将其当作另一款正式产品发布。
- 官方 main 起点 `f6c72acf1a565172f24f2a70137761d97aeae059`，通过 GitHub 源码归档取得。Git HTTPS 连续 reset，发布可使用 GitHub Git Data API，保留真实远端父提交，禁止强制覆盖并发提交。
- 手机 `src`、`assets`、本地 `modules`、App 和应用配置同步当时最新实现，包含新增文件。发布工作目录移除已经退役的 `NewTaskSheet.tsx` / `SessionView.tsx`，避免重新引入旧页面；没有修改原开发工作目录。
- 排除浏览器缓存、预览输出、node_modules、原生生成目录、私钥、keystore、Firebase 私有配置。原手机仓库其它 remote 源路径保留，不从脏目录混入桌面/Hub内容。
- 手机/桌面样式、文案、JSX、布局、动效不在修改范围。`UpdateManager.tsx` 仅改导入及下载回调调用更新内核，原渲染与样式保持。
- 用户另行明确允许修复必要内核和测试，但不改界面。测试适配必须保留用例，不得删除或跳过失败以伪造通过。

## 更新修改

1. Android 1.8.0 / code 21；沿用 `top.salcara.image` 和已有 GitHub Android signing secrets，不替换签名身份。
2. `src/update.ts` 精确选择 `salcara-image-android-vX.Y.Z.apk`，不误取其它 APK；取消检查后不接受迟到成功；镜像 URL 拒绝用户信息。
3. `src/apk-download.ts` 新增每个入口 90 秒无进度超时，正常进度延长该入口期限；全局原 10 分钟限制保留。用户取消与迟到原生完成均拒绝安装，失败入口可以继续下一个。
4. 大小、ZIP header、流式 SHA-256、临时 `.part` 到最终路径校验、Android 原签名校验保持，不缓冲整份 APK。下载失败不会安装不完整包。
5. `update-manifest-core.mjs` 在发布端检查官方产品、精确 URL、稳定正式发布状态、大小、sidecar 与 GitHub asset digest 一致；清单不得降级或变更已宣布版本的字节。
6. `publish-update-manifest.mjs` 仅把 HTTP 404 视为首次创建，其它权限/限流/网络错误不再吞掉；清单在正式 Release 资产公开之后才写 updates 分支。
7. `release.yml` 手动构建按 app 版本命名，不误用 main 作为版本。完整 typecheck/Jest/发布脚本测试保留，正式包用原签名；构建后与上一次 APK 包名、证书、递增 code 对照。添加构建时限、串行发布、私钥临时文件清理。
8. `verify-apk-upgrade.sh` 使用不提前关闭管道的第一行读取，避免 pipefail + head 的 SIGPIPE；证书摘要规范为小写。

手机 manifest 不是独立 Ed25519 签名清单；信任由固定官方 HTTPS/仓库来源、资产 SHA-256、以及 Android 同签名覆盖安装构成。不能把它称为桌面/Docker的签名 feed。

## 已执行验证（后续 CI 结果另补）

- 干净目录 `npm ci --legacy-peer-deps` 成功。
- `npm run typecheck` 成功。
- 更新专项 Jest：3 套 / 25 项通过；发布清单 Node：5 项通过。
- 首次全量 Jest：59 套通过、10 套失败、8 套跳过；741 项通过、179 项失败、8 项跳过。失败不能被当作全绿。已委派诊断旧 UI mock / 断言的适配，具体变更与最终结果另记。
- CodeRabbit CLI 缺失，安装器在 Windows 返回 `Unsupported operating system: mingw64_nt-10.0-26200`；未运行 CodeRabbit 审查，不声称自动审查通过。
- APK 按要求在 GitHub 构建。尚未取得成功构建、证书对照和线上清单验证前，不可声称已正式发布完成。
- 真实手机安装、后台推送、手机-电脑原生 Agent 交互不等于单元测试验证，仍需设备验收。

## 最终 Android 构建门禁

用户允许修内核和旧测试配置后，测试修复仅适配已有组件 / 宿主实现与 mock，不改 JSX / style / 动画、不删除用例或新增 skip。准确变更见 `MOBILE-TEST-REVIEW-20261004.md`；最后取消安装竞态及发布串行检查见 `MOBILE-UPDATE-INDEPENDENT-REVIEW-20261004.md`。

- 最终应用源码 `c47d0a481d8e372f37098651cedc8a73fac9697d`；GitHub `Android Release` 手动运行 `37141556903` 成功，不因 main 手动构建提前发布 Release / feed。
- CI TypeScript exit 0；全 Jest **71 套 / 927 项通过，8 套 / 8 项原有跳过**；Node 发布清单 + workflow 合约 **7 项通过**；Expo clean prebuild、正式 APK 编译及旧版覆盖安装验证成功。
- CI `aapt` / `apksigner verify --print-certs` 确认当前 `top.salcara.image` / code21 与生产 v1.7.0 / code20；两版公有签名证书 SHA-256 同为 `9714443d4c0679227ff3bf1dd43ee13bfdd05c1a8253ab46d6c6608f29d8bc33`，覆盖安装门禁成功，没有换 Android 私钥。
- Artifact `11280209603`：ZIP 47,485,764 字节，官方 digest `sha256:7663e6ac16819def48e5aa446a7dfd81ae061b60efbcb09487f4325bd426e6f9`。本地 APK 字节、结构、ABI 和发布后的公开资产 / 清单验收待下面正式结果补记；构建成功不等于已经上线。

## 独立 APK 复验发现并修复发布命名

- 全官方 artifact ZIP 下载后的 digest 一致。本地实际 APK 97,780,873 字节，SHA-256 `9f33363cda8abeeda83fa4a7a891fa89f97f308e315b15c0eac4fab933b3fea9`；1,282 个 ZIP entries 全部 CRC 正确；binary Manifest 为 `top.salcara.image` / `1.8.0` / code21。arm64-v8a 28 个库与 armeabi-v7a 24 个库均是真实正确 ELF。公有 v2 证书摘要与 CI apksigner 验真 / 旧版证书一致；本地 parser 不冒称替代 apksigner 密码学验签。
- 新只读 GitHub验收 `37185657414` 拒绝文件名异常，因此没有上传 Release：原手动构建生成 `salcara-image-android-v.apk`。根因版本读取的 `require(\"...\")` 被 Bash 单引号保留，Node SyntaxError；外层 `echo` 吞掉 command substitution 错误，导致 tag=v，原 workflow 错误地成功。
- `release.yml` 改成独立 `release_version=$(node -p 'require("./package.json").version')`，使用 `set -euo pipefail`、稳定版本正则和 printf 输出；读取错误 / 非稳定版本必须失败，不生成空 tag。
- `release-workflow-contract.test.mjs` 新增真实 Bash 执行回归，正常版本输出 `tag=v1.8.0`，坏 JSON 与 prerelease 退出非零且不写 output。本机 Node 发布测试 **8/8 通过，0 skip**，不是仅匹配源码字符串。
- 只读原产物验收 workflow `publish-verified-apk.yml` 固定原 run / SHA、所有 hash / ZIP CRC / 两 ABI ELF / Android 官方证书 / 包名和版本，绝不加载私钥或重建APK。历史命名迁移必须显式开启并同时匹配 run `37141556903`、source `c47d0a...`、版本1.8.0和上述**完整实际 SHA-256**；只重命名已校验 APK、重新生成匹配文件名的 sidecar，不改 APK 字节、不允许 wildcard挑 debug 或重新标注别的版本。

本次不以原成功 CI 掩盖命名缺陷；严格的产物/更新精确名称检查实际挡住了它。正式发布仍需修正后的验收成功与公开资产 / 清单确认。

- 修正后普通 CI `37186079621` 成功，真实 Bash 回归 + Node发布测试8/8、Jest927、typecheck重新通过。
- GitHub额外验收 `37186107537` 的全部产物/ABI/密码学签名/版本/覆盖安装检查通过；最后创建draft被平台返回 `HTTP403 Resource not accessible by integration`，起始实际token已有Contents:write，根因不是遗漏permissions。不用新增高权限secret或放宽安全检查来绕过，验收helper改成只读准备并保存已验证artifact，由现有发布者凭据完成公开Release。未来原tag release workflow仍保留正常发布路径。

## Android 正式发布与更新清单验收

- 正式稳定 Release `v1.8.0` 已公开并成为 latest，tag 指向原已测试应用源码 `c47d0a481d8e372f37098651cedc8a73fac9697d`。没有重建 APK 或修改签名字节；新名下本地 SHA-256、GitHub asset digest 均保持 `9f33363cda8abeeda83fa4a7a891fa89f97f308e315b15c0eac4fab933b3fea9`，大小97,780,873。
- 正式资产只有 `salcara-image-android-v1.8.0.apk` 与配套 `.apk.sha256`。sidecar 用新名重新生成，99字节，公有asset digest `59b6d342d5eb2ddf74e94af3d18014014e822a4d4ba8ff9299cb80926ee905b2`；公开下载重新校验相同字节。
- 实际 APK HTTPS HEAD 返回200、Content-Length97,780,873、Android package archive类型，未只凭Release metadata声称地址可达。完整 APK 内容检验来自本机官方artifact下载 + GitHub独立原产物验收；上传后服务器完整digest与它一致，不冒称已再次下载97MB公开包进行实机安装。
- 在正式assets公开且与验收hash一致之后运行 `publish-update-manifest.mjs` 成功。匿名 raw `updates/latest.json` 获取到1.8.0 / v1.8.0 / 精确APK名 / 同样size与SHA-256。客户端不会得到尚未发布资产的更新提醒，也没有把iOS未签名文件列为可安装版本。
- 根发布者公开tag触发了旧源码的重复Android构建 `37186834049`；核实run source/event/tag/path后仅取消这一重复发布构建（实际状态cancelled），避免旧命名脚本重建并尝试重复发布。没有取消其它用户任务或CI。未来新版本应从含命名修复的main提交发行，不修改已经正式签发的v1.8.0标签或APK。
- 最新只读helper权限降为contents:read/actions:read；前版选择排除目标tag，使正式发布后仍可复验，不把当前code21当自己的前版。新本机contract测试通过，发布Node测试 **9/9**、0 skip。

手机/桌面UI、文本和动效没有重设计。安卓系统安装仍需用户允许，真实设备覆盖安装/远程Agent/推送仍待用户验收；iOS没有正式发行签名身份，本次不提供IPA。

最终维护源码 `ea4308d8c766dd9a0f7aa7e0d3ef9d94508eca7e` 的 CI `37187155470` 和只读helper `37187177205` **均success**：Node9/9、Jest927项/71套、typecheck、Expo21/21与prebuild通过；helper实际Contents:read/Actions:read，hash/CRC/全nativeELF/生产包名版本/apksigner与code20→21兼容再次通过，仅保存验证artifact `11297064900`，不修改正式Release。公开APK资产ID `609379744`、sidecar `609372698`；正式资产的版本、大小、完整SHA、tag source保持不变。本文后续提交只是文档。
