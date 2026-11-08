# 远程兜底、项目运行预览与成果版本（2026-11-07）

本轮与主视觉对话协作，承接真实远程接线、断线恢复、React/TSX 项目运行和成果版本管理。阅读位置、搜索、多图画布与网页批注由主视觉对话处理。本文只记录本轮实际实现及验证边界。

## 消息与回执的故障处理

| 故障 | 处理与验证 |
| --- | --- |
| 手机发出请求，电脑尚未收到 | 保留原待发送记录及附件来源；明确未下发时可沿用原操作编号重试。现有持久发送、离线、存储失败、撤销隔离测试纳入本轮回归 |
| 电脑已经执行，手机没有收到回执 | 不生成新操作编号自动重复执行。Direct 新任务增加持久启动标记，跨重连/重启保持；按同电脑、项目、Agent 的 `clientId === operationId` 核对原任务，不能凭标题或正文猜测 |
| Direct 创建任务的回执丢失 | 最近 20 个同范围会话、每个最近 10 条消息做有界核对；未找到保持待确认。找到时只按原草稿 identity/revision 消费旧草稿，后来输入和图片仍保留 |
| Bridge 命令连接短暂中断 | Hub 对已接收的回执命令保留原 pending 和截止时间，允许同一设备对象、绑定和授权重新连接后交回结果；更换绑定、撤销或替换设备时拒绝旧回执 |
| 电脑已执行，回包前进入重连授权空窗 | Bridge 不能把已进入 Dispatch 的操作改判为明确未执行；返回 `command_delivery_uncertain` 并清空私有结果，手机保留原待确认记录。执行前拒绝及授权稳定时的正常成功/明确失败保持原分类；授权撤销或换绑定同样不泄露原结果 |
| Direct 回复尾部或结束事件丢失 | 可见运行会话定期只读补历史，回前台和重连重读；保留当前会话、可见历史、草稿，并合并补读期间到达的实时事件。空闲/失败会话的相同残缺内容至少稳定 60 秒且经过三次成功快照仍未补齐时，才标记“回复未完整”，保持 `final:false`；新内容、回前台或重新打开仍可恢复。运行中的长任务不累计这三次，网络失败退避且不消耗成功快照次数；失败、后台或内容变化重新给稳定观察窗口 |
| Hub 临时缓存淘汰 | 无需依赖特殊 gap 文本，仅 `resetRequired` 也能恢复。读取电脑快照后逐页消费已保留的事件，避免从第 40 条跳到快照头第 100 条 |
| 中转数据丢失导致序号回退 | 仅在服务端明确 reset 且电脑快照成功后重建游标及审批水位；保留内容，清除旧序号版本戳，从新序列补读。读取失败不提前推进游标 |
| 长任务结束，回复仍只有开头 | `terminal-unconfirmed` 保持有界补齐调度，避免前台观察窗口过期后取消修复；相同内容至少稳定 60 秒、三次成功快照，并在宽限结束后再次成功读取仍残缺，才显示回复未完整。失败快照不计成功，并以 15→30→60 秒退避；后台、重新打开或迟到的新内容重置窗口 |

Hub 重启后的 hash-only 不确定回执、超出安全确认窗口的发送，仍可能需要用户核对。网络分区下无法承诺所有消息永远成功；本实现优先保留内容和不确定状态，避免无声丢失与重复执行。

Git 预算最终为：Bridge 执行 90 秒、Hub 默认等候 95 秒、手机 Hub/Direct 等候 100 秒。手机留出回执传输时间；只读重试共用 100 秒总预算，不确定的写操作不自动重放。显式 Hub 超时配置仍优先。

## 提示时机、后台与冷启动恢复补充

用户追加要求后，重新检查了短暂抖动、后台计时和强制终止的差异。Hub 普通网络异常持续 30 秒才展开提示，8 秒后可显示轻量同步状态；包含真实客户端文案“连不上中转站，请检查网络”和“响应未接收完整，保留原请求等待重试”。后台隐藏并停止这些计时，返回前台重新给完整窗口。明确的权限/业务拒绝、本地保存失败、已可能执行而无法确认的操作仍需及时告知，不能用统一延迟把真实结果遮住。Direct 自动补读的短暂失败使用恢复状态，并受同一前台门禁约束。

Hub/Direct 输入框正常编辑保留防抖保存；收到 `inactive` / `background` 时立即提交当前草稿，包括原图片来源和输入选项，不等 400/300 毫秒计时器。提交中的已发送草稿仍按原身份和版本处理，不能因后台保存写回已消费的旧内容。存储失败保留编辑并允许前台恢复时重试。

| 生命周期 | 实际恢复能力与限制 |
| --- | --- |
| 短暂切网、锁屏、切后台 | 暂停前台补读和提示计时，保留已显示内容；回前台重新核对电脑。后台时间不能单独成为“回复未完整”的证据 |
| 手机进程被杀后重新打开 | 已落盘的绑定、草稿/私有图片副本、待确认操作编号和队列可按来源恢复，再从电脑补历史；不依赖退出回调才保存发送事务 |
| Hub 冷启动 | 从已保存连接恢复选中绑定，核对原待确认操作；网络未恢复时保留原记录，不推断未执行 |
| Direct 冷启动 | 恢复已保存的电脑身份为关闭状态，需要点击重新连接并打开原会话；恢复该来源草稿和待确认记录，不在冷启动时自动打开 socket 或重新发送任务 |
| Android 普通后台 | 在通知已启用且权限允许时，已有原生前台 watcher 可继续跟随 Hub 任务；它是 `START_NOT_STICKY` 且配置在内存，不能把它当成系统终止进程后必然自行恢复的服务 |
| Android/iOS 进程不在运行时通知 | Hub 需正确配置 FCM（iOS 还需 APNs）、通知权限和系统允许投递。Direct 当前没有后台推送通路；强制停止和厂商省电限制下不承诺实时通知，重新打开仍可核对历史 |
| OS 立即终止、未给后台回调或落盘时间 | 已成功持久化的记录可恢复；最后一次尚未完成写入的编辑不能作绝对保证。发送命令必须先完成草稿/待确认记录保存，持久化失败不能先派发任务 |

电脑已经接收的任务生命周期由电脑端决定，不依赖手机 JS 持续运行；电脑自身退出、任务进程终止或断电仍可能使任务中断，手机恢复后按电脑实际历史展示，不能凭手机断线推断任务失败或自动重建任务。

## 实际项目预览

从文件页的 `.tsx` / `.jsx` / JS、TS、HTML、Vue、Svelte 或 `package.json` 打开“运行项目预览”，生成当前会话的动态标签，不增加常驻画布入口。开页仅检查项目；用户点击启动后才执行脚本。

- 新协议 `workspace.project.preview`，动作 `inspect / start / status / stop`；Bridge、Hub 策略和 Direct 字段编码均接通，能力名为 `workspace.project.preview.v1`。
- `inspect(sourcePath)` 在授权项目范围内向上查找最近 `package.json`，返回具体脚本、清单 revision、依赖与运行条件。
- 当前支持已安装的 Vite、Next 开发脚本。电脑直接调用本地框架 CLI，固定 loopback 地址与分配端口。不安装依赖、不下载 `npx` 包、不执行复合 shell、pre/post hook。其他脚本明确显示原因。
- `start` 使用 `manifestRevision + operationId`；手机在发包前落盘，失回执后自动 `status(operationId)`，不会新建编号重发。源文件移动也先核对原操作，再做项目发现。
- 前台按状态读取增量日志，后台和隐藏标签停止请求；连接恢复重新取得句柄。手机保留上次预览；启动或查询失败显示原因，旧画面不被空白替换。
- `stop` 对指定进程幂等。Windows 隐藏启动并使用 JobObject 管理进程树；Unix 使用进程组。
- 每范围最多一个活动运行，全局最多四个；日志最多 64 KB，闲置 10 分钟终止，操作结果保留 30 分钟。冻结 Agent 实例/世代、API、模型、执行器路径及授权来源；来源失效时清理进程，同绑定的普通传输重连保留运行。
- 浏览器画面与输入复用现有电脑远程预览；手机不会把电脑 localhost 当作自己的 localhost 打开。
- 持久标签只保存来源路径和选择范围，不保存 URL 或进程租约；重开只查询原运行，不自动重启。

实际验证使用独立临时 Vite 6.1.0、React 19.2.3 项目：通过真实 `Dispatch` 检查、启动、按原 operation 查询、读取 HTML/编译后的 TSX、修改文案后读取新模块、停止并确认 HTTP 端口消失。测试修改后恢复源码，不修改产品依赖或用户项目。

## 成果版本与源码副本

`ConversationArtifactPreview` 增加版本页与源码副本编辑；`artifact-versions.ts` 保存有界、不可变源码快照。版本按原会话 scope、messageId、块 index 归属，不按同名标题合并。保存使用当前版本 CAS，恢复旧版本创建新的版本，不删除中间历史。可切换和比较版本，将选中副本加入原对话草稿；不会自动发送或暗中覆盖电脑文件。

同一源码恢复成新版本也使用新的交互身份，避免把历史版本批注重新混入当前版本。版本和未保存编辑均按来源隔离。存储损坏、空间不足或版本冲突保留原记录和编辑，显示错误。

## 主要代码

- Hub 接收恢复：`src/remote/store.ts`、`src/remote/ThreadView.tsx`。
- Direct 补历史与待确认：`DirectExperience.tsx`、`useDirectHistoryRecovery.ts`、`direct-history-recovery.ts`、`direct-pending-operation.ts`、`DirectComposer.tsx`。
- 项目预览：`workspace-project-preview.ts`、`project-preview-state.ts`、`RemoteProjectPreview.tsx`；入口与通路在 `RemoteFiles`、`RemoteSidebar`、`WorkspaceTabs`、`workspace-layout`、`WorkspaceRuntimeContext`、`direct-workspace`、`client`、`direct-api`。
- 版本：`artifact-versions.ts`、`artifact-drafts.ts`、`ConversationArtifactPreview.tsx`。
- Bridge：`internal/hubclient/workspace_project_preview*.go`、`client.go`、`dispatch.go`、`execution_receipt.go`，以及 Direct session-scoped allowlist。
- Hub：`internal/hub/admin.go`、`command_receipts.go`、项目预览策略与测试。

## 验证证据

- 手机远程整合：18 suites / 310 tests 全部通过。包含发送持久化、长时间离线、历史补齐、Direct 新任务/重连、项目预览服务/组件/真实 Direct 编码、文件入口和布局恢复、Git 超时与来源策略。
- 成果版本新增 3 suites / 11 tests 通过，连同侧栏共 17 项；包含真实 Inline、AnnotatedArtifact 和 Provider 的恢复版本批注/附图回填。长任务恢复调度组件故障单测通过。
- Direct 最终有界恢复：相关 5 suites / 70 tests 通过，其中新增故障回归 12 项；包含空闲残缺收敛、运行中安静任务、失败退避、晚到更长片段及最终消息、前台恢复、切会话重置。与成果版本相关 17 项合计 87 项通过，不与前述整合测试简单相加。
- 手机最终发送回包复验：3 suites / 44 tests 通过，新增真实 `command()` → `deliverMessage()` 的 HTTP 200 不确定回包回归，确认首次发送也保留原待确认记录、跨重启保持且不再次派发；JSON 为同证据目录下 `final-delivery-fault-tests.json`。
- 用户追加生命周期场景后的 Hub 补读复验：`remote-terminal-lifecycle` 新增 4 项故障先红后绿，连同历史/缓存恢复共 3 suites / 49 tests 通过，覆盖快速三读不提前提示、连续读取失败不消耗成功预算、后台十分钟后重新给宽限、迟到片段重置窗口并最终补全。
- 同轮 Direct 最终 5 suites / 77 tests 通过，新增 7 项恢复与草稿后台保存回归；后台重连不绕过前台门禁，接收最终回复/新草稿的版本保护保持。最新全局 `npm run typecheck` 退出 0。
- 同轮 Hub 主对话新增 9 项生命周期回归全部通过，涵盖小于 400ms 就后台、迟到草稿恢复、保存失败/前台重试、提交中保护、30s/8s 提示重置和明确拒绝即时反馈。完整主对话/真实草稿存储/通知生命周期 3 套首次为 404/405 通过；唯一旧测试 `live coding activity labels identify the current file edit and command in the conversation` 属于执行行展示断言，已由原展示负责人修正并单独复验 1/1 通过（355 skipped）。记录为“整组 404 项通过 + 剩余单例修正后通过”，未重复运行整个集合。证据分别为 `hub-background-lifecycle-tests.json` 与 `salcara-mobile/output/live-edit-label-recheck.log`。本轮新增生命周期/恢复故障合计 20 项，全部通过。
- 最后对照实际客户端补齐 2 项中文网络文案回归，先红后绿；最终通知窄组 9/9 通过，包含 8 秒轻量进度、30 秒警告门槛、恢复清除及明确拒绝即时反馈。JSON 为 `hub-transport-notice-tests.json`。因此本轮追加场景累计新增 22 项测试，全部通过；该计数不与前述整组测试重复相加。
- `npm run typecheck` 退出 0；本轮改动范围 `git diff --check` 通过。
- 结果 JSON：`C:/Users/24230/.codex/visualizations/2026/11/06/01a1b13a-6dc4-7c80-98a1-85f1b6d1eef9/remote-reliability-project-tests.json`。
- 长任务前台窗口故障已用组件测试先红后绿；缓存淘汰和序号回退 4 项故障也已先红后绿。
- Windows Bridge 最终 `-race` 30.569s 通过（含真实 Vite、进程树和执行来源变更）；Hub 最终 `-race` 3.183s 通过；Linux amd64 交叉编译通过。Next 的参数/进程生命周期用真实 Node 子进程验证；真实框架编译测试使用 Vite。
- 执行后重连授权空窗追加回归：`TestExecutedCommandRetainsUncertaintyAcrossAuthorizationGap` 覆盖新建/发送各 7 个场景，故障先红后绿；最终与 `TestStationSwitchCommittedThenUnboundStillKicksSourceStream`、`TestRemoteExecutionPreservesCommandBudget`、`TestNewTaskReceiptCorrelatesFirstUserEcho` 一起 `-race` 通过（2.614s）。确认成功后掉线、部分失败后掉线、撤销、换绑定保留不确定状态，原有稳定成功/明确拒绝分类不变。
- Hub 原绑定恢复/换绑定/撤销/替换设备和原截止时间测试通过。普通请求仍保留原预算。
- Playwright 390×844、1024×900 检查真实 React Native Web 组件；手动启动、日志、停止及模拟失回执后自动恢复已验证。截图为独立本地传输 fixture，不冒充实体设备验收。
- 成果版本另在实际 ThreadView 与 Provider 中完成平板/手机操作：保存 v1 批注、编辑 v2、比较、恢复为 v3，新批注进入原输入框且没有带回 v1 批注；手机再次编辑/恢复到 v5，无水平溢出，未发送消息。

复验后端，在 `salcara-desktop/remote/bridge` 执行：

```powershell
go test ./internal/hubclient -run 'TestProjectPreview|TestRemoteExecutionPreservesCommandBudget|TestExecutedCommandRetainsUncertaintyAcrossAuthorizationGap' -count=1
go test -race ./internal/hubclient -run 'TestProjectPreview' -count=1
# 配置已安装 Vite/React 的独立测试项目；测试会临时替换文案并恢复。
$env:SALCARA_TEST_VITE_PROJECT = 'C:/Users/24230/AppData/Local/Temp/salcara-vite-preview-20261107'
go test ./internal/hubclient -run TestProjectPreviewInstalledViteReactTSX -count=1
```

在 `salcara-hub` 执行：

```powershell
go test ./internal/hub -run 'TestReceipt|TestDisconnectedReceipt|TestCommandDispatch|TestAcceptedReceipt|TestGitCommand|TestWorkspaceProjectPreview' -count=1
```

## 三端版本与真机验收

尚未安装实体手机/平板应用、替换用户电脑 Bridge 或部署线上 Hub。最终发布需要三端版本包含本协议；实体设备上的锁屏、系统杀进程、移动网络切换和真实配对端到端仍属发布验收，不能由本地 fixture 或协议测试替代。

在专用测试会话中分别验证 Hub 与 Direct 通路；先保存操作编号、电脑执行次数和手机显示状态，以操作编号核对结果，不能只按相同正文判断是否重复。以下是待执行的真机验收，不代表已通过：

| 场景 | 操作与预期 |
| --- | --- |
| 手机在发出前离线 | 输入文字和图片后断开手机网络再发送；恢复后原内容仍在，明确未下发的原记录才可重试，电脑最多执行一次 |
| 图片上传中途断开 | 在图片准备或分块上传期间断网；不得提前派发缺图任务；恢复使用原图片事务，错误保留草稿和附件来源 |
| 电脑已执行、手机未收回执 | 电脑收到后立即断开手机网络并重开应用；同一操作保持待确认，核对原任务，不能用新编号自动再发一次 |
| 回复生成中切网 | 输出半途切换 Wi-Fi/移动网络，随后锁屏再回前台；已有文字保留，重新读取电脑历史，不因补历史覆盖实时到达的新内容 |
| 电脑或 Bridge 临时断线 | 执行期间断开电脑网络再恢复原绑定；Hub 保留原等待截止时间并接收原结果，不重置超时或重复执行 |
| 手机系统终止应用 | 在发送待确认及新建任务待确认时分别终止应用再打开；原操作标记仍在，后续新输入不被旧结果清空 |
| 服务重启或恢复窗口已过 | 用测试 Hub 重启或超出保留窗口，核对记录仍不确定时提示人工核对，不以“未找到”推断未执行，也不自动重放写操作 |
| 更换来源或撤销授权 | 待确认时切换电脑、项目或 Agent，或撤销配对；旧回执、草稿、审批和预览不得注入新来源，失效预览进程应清理 |
| 电脑历史本身残缺 | 空闲会话持续返回同一段未完成回复；有界补读后提示未完整，停止尾部轮询；运行中的长任务不能因安静而被判为残缺 |
| 本机存储失败 | 在受控测试中模拟存储失败；不能先发送再假装持久化成功，也不能静默删除原待确认记录或已编辑草稿 |

验收需记录三端版本、通路、操作编号、故障时机、恢复结果和电脑实际执行次数。仅协议测试或浏览器 fixture 通过时，不将此表标记为真机通过。
