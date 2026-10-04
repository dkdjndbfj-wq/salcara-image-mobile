# 手机项目产品化整理与审查记录

## 范围与基线

正式项目保持 dkdjndbfj-wq/salcara-image-mobile，基线 main 为 63e99143d1aa3a76a57f847a4bdad16e67a5900e。本次基于该正式源码建立干净工作目录；没有覆盖原开发目录、隔离发布目录或测试项目中的既有未提交内容。

本次整理产品、文档与仓库边界，不重新设计手机或桌面 UI，不改变动效，不编辑有效手机内核，不修改独立桌面和 Hub 项目，也不接触服务器。

正式 APK 继续为 v1.8.0，标签指向 c47d0a481d8e372f37098651cedc8a73fac9697d。安装包 97780873 字节，公开 SHA-256 为 9f33363cda8abeeda83fa4a7a891fa89f97f308e315b15c0eac4fab933b3fea9。此次不替换 APK、不换签名、不改包名或版本；没有读取私钥或既有真实配置。

## 改动

- README：改为 Salcara AI 产品介绍、Android 下载、首次使用、可选远程配套、能力边界、隐私和贡献入口；移除长篇实现细节和无依据的功能保证。
- docs/USER-GUIDE.zh.md：添加手机 API／模型、对话、图片／文件、语音、聊天伙伴、备份、更新及常见问题。
- docs/REMOTE-PROGRAMMING.zh.md：编程首页、站点检查、扫码、电脑 API、项目与会话历史、发送／问答、切换、断网和真实支持范围。
- docs/DEVELOPMENT.md、docs/README.md：将开发、发布与用户操作分开；说明 main 是完整源码，updates 仅为更新清单，不是另一款 App。
- PRIVACY.md：按当前设备配对修正“同 Key 登录”，区分模型 API 和配对凭证；说明电脑 API 不返回明文、Hub 转发／缓存、非端到端加密、备份范围、可选通知及现有官方服务推荐。
- docs/IOS-MAC-BUILD.md：修正旧版源码 ZIP 和版本说明；仅给开发者构建方法，不把 iOS 源码或未签名包当用户发行渠道。
- docs/TESTING.md：更新当前检查与设备验收范围，取消早期固定真实提示词／试用任务；不修改任何应用测试或删除测试用例。
- docs/RELEASE-v1.8.0.md：按产品语言整理现有版本说明，不改变该版本安装包或标签。
- 五份过程／设计／历史验证文件归档到 docs/maintainers，保留实际证据；旧发布／测试文档中的“副本、交接”表述改为准确的历史工作目录说明。
- 清除手机仓库 remote/bridge、remote/hub、remote/scripts 的 86 个旧文件（含旧内核、测试、安装／部署脚本及其未被手机使用的历史控制台资源）。这些文件在普通 CI、Android Release、iOS 构建及有效手机代码中没有运行引用；只有旧说明、源码注释和 iOS 打包的排除规则提及。没有删除 src/remote，删除内容可从 Git 历史恢复。
- remote/README.md 和 remote/docs/PROTOCOL.md 只保留正式配套与兼容链接，不再维护另一套 Hub/Bridge。协议以当前客户端和独立 Hub 为准。

## 不变项与已知边界

src、modules、assets、App.tsx、index.ts、app.json、app.config.js、package.json／锁文件、发布脚本与 workflow 均不改；手机 UI／内核及生产构建身份保持一致。旧代码清理不是对正在使用的桌面或 Hub 内核进行删改。

1.8.0 内“下载电脑端”仍打开 GitHub 首页，这是已存在的占位 URL。为了本轮不变更运行代码／不重新签发 APK，用户教程提供已核实的桌面正式下载链接；没有声称已经修复该按钮。未来可单独进行内核 URL 修复及新版本发布。

保持现有更新仓库、updates 清单和 APK 资产；不将 README 整理当成安装更新。真实手机安装、通知、原生 Agent 接口及 iPhone 构建不在本次新实测范围，不宣称全部隐藏问题已消除。

## 本轮验证

- 全部 37 份当前／历史 Markdown 文档的 61 个本地链接目标存在；产品用户文档没有“副本、交接、仅限中转站用户、当前附带 iPhone 源码包”等过时表述。潜在真实密钥格式检查通过。
- 与正式基线比较，所有有效手机运行／UI／资源／模块／构建配置／workflow／发布脚本 diff 为空。86 个旧组件文件确实移除，有效 src/remote 与协议兼容文档存在。
- node scripts/verify-release-version.mjs 通过，身份仍为 top.salcara.image 1.8.0 (21)。Node 发布／更新测试 9/9 通过，0 fail、0 skip，包含真实 Git Bash 正常／异常版本输出回归。
- 匿名访问 Latest API，精确核对 v1.8.0、两资产、目标源码、APK 大小与 SHA-256；下载 99 字节 sidecar，校验其完整 SHA-256 和 APK 文件名／摘要；公开 APK HEAD 返回 200 和 Content-Length 97780873。本轮没有重新下载整份 APK／执行真机安装，完整包验收仍引用历史证据。
- 匿名读取 GitHub Contents API 的 updates/latest.json，版本、精确 APK URL、文件名、大小及 digest 与正式 Release 一致。当前本机 raw.githubusercontent.com 曾发生 DNS 解析失败，所以不声称重新验证了 Raw 下载可达性；没有改 DNS 或代理。
- CodeRabbit 审查技能：CLI 不存在，按官方安装脚本尝试安装，返回 Unsupported operating system: mingw64_nt-10.0-26200。未启动审查、没有结果；需在支持的 Linux/macOS 环境安装并登录后补做。本节自动化检查和 CI 不冒称 CodeRabbit 审查通过。

公开文档／元数据和本次 main 的 CI 结果在实际完成后追加。历史完整构建证据见 [1.8.0 发布验收](RELEASE-1.8.0-VERIFICATION.md)，不冒充本轮重新执行的测试。
