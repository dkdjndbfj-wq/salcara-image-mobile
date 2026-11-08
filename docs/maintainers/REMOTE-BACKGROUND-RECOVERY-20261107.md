# Android 后台任务监听恢复

本轮在已有消息持久化、通知偏好和配对隔离上补齐原生服务恢复；不改变 Hub 命令执行规则，也不会重新发送任务。

## 生命周期

- App 退到后台时，仅将当前配对、当前关注任务交给原生服务；回到前台立即移除恢复检查点，由 App 接管同步。
- 正在运行的服务返回 `START_STICKY`。Android 因资源回收而重新启动服务时，先校验本机检查点和通知权限，再恢复原始游标及租约。
- 开始请求带服务代次。关闭通知、停止服务或切换配对会先失效旧代次，再清除检查点；迟到的旧开始请求不能重新启用监听。
- 401/403、权限收回、系统超时、全部任务完成、检查点过期均停止监听并清除凭据。旧连接的迟到响应不能清理新连接。
- 普通任务租约总长 2 小时，不因恢复而续期。主动开启的待命租约为 7 天，只能由 App 再次明确交接续期；轮询不会续期。运行期间同时使用单调时钟限制租约。
- 不新增开机启动，不绕过 Android 强行停止或厂商省电限制。重启手机或强行停止后仍需重新打开 App。

## 检查点与隐私

`SalcaraWatchVault` 在 `Context.noBackupFilesDir` 中保存原子检查点。文件使用 Android Keystore 中的 256 位 AES 密钥与 GCM 认证加密，12 字节随机 IV、固定格式 AAD；密钥不可导出。检查点包含所需配对凭据、关注的设备/任务、标题、游标与已验证入口清单，不包含业务指令。

恢复前限制大小、版本、URL、配对作用域、任务数和有效期；无法解密、密钥丢失、损坏或过期均清除，不退回明文。写入失败会清除旧文件，保留当前内存监听，并在通知菜单提示本机恢复存储未就绪。无新游标的轮询不会重复写盘。

它不是端到端加密，不改变所选 Hub 能接触转发内容的边界。手机事件/结果的持久化仍由原有 durable 模块负责，后台观察不会 ACK 代替手机正式收取。

## 用户反馈

通知菜单区分用户选择与服务实际状态，展示运行中、系统限制、凭据失效、到期或恢复存储不可用，并提供前台重连入口。重连先核对原生状态，不会在后台偷偷启动服务，也不会复活已关闭的待命偏好。

按 2026-11-08 的界面反馈，原更多弹框只保留上述通知设置。移除重复的首页、切换 Agent、连接电脑、API、下载、诊断和解除配对入口；原首页、电脑管理页、Agent 的 API 入口及连接状态圆点仍提供对应操作。没有新增返回按钮或设置页面。Android 系统返回先关闭弹框，再返回原有上一级页面。

推送状态仅显示“已登记”，不承诺送达；Direct 模式明确提示没有服务端推送。帮助说明解释强行停止、重启与 2 小时/7 天期限。

## 开发验证

- `scripts/test-native-watch.ps1 -OutputDirectory <工作区外目录>` 运行生产 Kotlin 恢复策略与 AES-GCM 合同：游标/期限、过期、篡改、错误密钥、超限和无效配置。
- 2026-11-08 最终恢复合同为 12 项通过，含同设备 ID 的新配对不继承旧配对游标；普通服务刷新不覆盖已推进的恢复游标。这两个边界另由协作代理只读复核。
- `remote-notification-lifecycle.test.ts` 覆盖通知关闭、迟到启动、配对隔离、原生服务结束后的前台恢复及禁止后台重连。
- `remote-mobile-workspace-shell.test.tsx` 验证实际通知菜单的运行/失败/恢复存储文案和重连按钮、Direct 提示。
- 真实浏览器预览检查 390×844、320×844、1100×844 的实际 React Native 页面：更多 → 受系统限制提示 → 重连 → 运行中 → 帮助说明。三尺寸均无页面错误、无横向溢出；修复了长说明重叠。原生通知状态为本地 fixture，不代表 Android 已验收。证据在任务 `product-completion/mobile-notifications-qa.json` 及同目录截图。
- 手机端仍需三端同版本真机验收：锁屏切网、系统回收、强行停止、手机重启、权限收回、凭据撤销及真实 FCM/APNs 到达率。模拟器/浏览器或 JVM 测试不能替代这些项目。

本轮通知、配对、扫码、主页、切站和离线恢复的最终 JavaScript 回归共 11 套 / 203 项通过，未将之前的局部重跑重复计数。`npm run typecheck` 通过。Jest 中一条既有 Expo logger mock 警告不影响测试；浏览器仅有既有 React Native Web 样式/动画兼容警告。

站点 v2 的大小预算随后补齐手机边界：签名 snapshot 的 base64url payload 上限与 Hub/Bridge 的 64 KiB 原文对齐为 87,382 字符；字符格式、86 字符签名以及最终 256 KiB 命令体限制保持校验。来源授权与审批取消回归 2 套 / 45 项通过，另通过 TypeScript。新增覆盖最大 payload、超限一个字符、空值与非法字符、4,096 字节含 `&` 的完整 URL 授权转发，以及包含 32 条完整 URL、普通 API 与反向代理重叠列表的约 1.5 MiB 转义策略在 discovery/ping 中接收。手机通用 JSON 响应上限为 8 MiB，足够容纳 Hub 的 4 MiB 策略信封；入口 manifest/identity 的独立 16 KiB 上限不承载站点策略。

## Android 本地测试包

2026-11-08 的 arm64 Debug 全量编译通过后，另以 `SALCARA_TEST_BUILD=1` 生成包含 Hermes 页面代码的 Release 测试包。构建使用冻结的 879 个源码与资源文件；加入 `external_api_not_allowed` / `reverse_proxy_not_allowed` 中文反馈后，再次通过该快照的 TypeScript 检查，来源能力测试 6 项通过。随后仅将来源授权 payload 上限的常量与 guard 最小改动同步进快照，复用既有原生产物增量构建，不重新 prebuild，也不复制其他并行开发改动。手机仅呈现电脑端的逐来源授权结果，不自行解释或授予 StationPolicy 权限。

- 包名 `top.salcara.image.remotetest`，版本 `1.8.2` / `23`，ABI `arm64-v8a`，可与正式版共存。
- 实际 APK 包含 `assets/index.android.bundle`（21,753,728 字节），无需 Metro 提供页面代码；APK 为 98,210,234 字节。包内 bundle 的 SHA-256 与本次生成文件相同：`6FC4AD3AF22475DB1F0C22D73DC366253A1525C480C79A2A6FF7208C3E74DAD4`。
- 本地 Android Debug 测试证书，APK v2 签名校验通过，不是正式发布签名。
- 最终 APK 不含 `READ_MEDIA_AUDIO`、`READ_MEDIA_VIDEO`、`SYSTEM_ALERT_WINDOW`；旧版读写存储权限均限定 `maxSdkVersion=32`。相机、录音、图片、通知、前台服务和对应类型权限保留。
- 编译后逐个核对 879 个冻结文件的 SHA-256，未发生构建中源文件变化。其他并行开发随后产生的变化不自动进入本次快照。
- 测试包 SHA-256：`C1AD913631BAF50EE418A1D665E110D814BC95264C8CCAC4E9BD0699882A805B`。
- 冻结快照清单 SHA-256：`BAA9D975028094C367716C3DB25F7279C73D1957E89A7772F265A09115999530`；清单记录唯一源文件补丁的时间、旧 hash 与范围。此次增量构建成功，828 项任务中 22 项执行、806 项复用。

本机交付文件位于 `D:\salcara-proxy-pool-qa-20261107\artifacts\Salcara-remote-test-1.8.2-arm64-local.apk`；同目录 `mobile-apk-verification.json`、`mobile-apk-permissions.txt` 和 `mobile-apk-signature.txt` 保存实际包核验结果。此构建未连接 Android 真机，也未配置测试 Firebase 凭据；不代表后台存活、锁屏切网或推送送达已通过设备验收。

Windows 构建使用 ASCII 路径的任务副本与短路径 Gradle 缓存，避免 NDK 路径编码及 Ninja 的 260 字符限制。复制构建依赖时不得按任意目录名全局排除 `output`：Metro 包内同名目录属于运行所需代码。

本轮不发布新版本，也不把本地源码验证描述为 Android/iOS 商店交付完成。
