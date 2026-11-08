# 远程协议参考

本页保留旧链接的入口，协议和部署以独立正式项目及当前客户端为准。

- [手机远程编程教程](../../docs/REMOTE-PROGRAMMING.zh.md)
- [手机 Hub 客户端与能力检查](../../src/remote/client.ts)
- [Salcara Desktop](https://github.com/dkdjndbfj-wq/salcara-desktop)
- [Salcara Hub](https://github.com/dkdjndbfj-wq/salcara-hub-plugin)

新配对先发现兼容 Hub，再通过电脑二维码的一次性票据交换设备凭证；模型 API Key 与设备授权分离。HTTP 请求、能力标识、回执和重试策略使用当前实现，不按旧版“相同 API Key 自动登录”部署。

声明 `pair.connections.v1` 的 Hub 与 Bridge 支持一次扫码同步这台电脑的已保存中转站。
手机成功保存二维码凭据后立即进入 ready，并在后台调用 `remote.connections.sync`；
此命令不接受手机提供的目标网址或设备凭据。Bridge 用各站已有的电脑身份签发独立、
绑定同一电脑和手机代次的凭据。手机核对 `computerId` 后仅将 token 写入 SecureStore，
当前选择不变。同步响应不能进入 Hub 持久回执；旧随机凭据通过 `retained` 保留。
部分站点离线只产生独立同步提示，可在设备/API 页面重试，不能撤销已完成的初次绑定。
恢复连接时自动同步；解绑、切换电脑或凭据更换后，迟到的同步结果不得复活旧记录。

`agents.status` 返回的是聚合后的 Agent 目录。Codex、Claude Code 和 Claude
Desktop 使用各自的适配器；未来 Agent（例如 Hermes）通过相同的标准化会话、
事件、附件和回执链路接入，并额外声明 `capabilities`（列表、读取、发送、
审批、问题、子智能体、附件、图片输入/输出、模型切换等）。没有显式能力的
适配器不会继承 Codex 或 Claude 的权限，也不会被手机自动当成其中一个工具。

`session.start` 可带 `workspaceMode: "code" | "work"`。这是手机目录的组织标签，
不是文件夹授权，也不会改变 `cwd` 的项目白名单。Bridge 会在新会话、会话列表、
历史打开和 `session.updated` 中保留该标签；旧 Bridge 省略字段时，手机按有无
工作目录兼容归类。手机先按该标签筛选，再按电脑和项目目录分组，避免 Code/Work
之间混用相同的会话句柄。

统一的是手机协议，不是 Agent 原生内核。电脑端的 Codex、Claude 及其他适配器
各自调用其运行时；Desktop 原生执行与托管 CLI 必须保留独立 controlSurface，
不能用相同会话名称或相同 API Key 代替执行面和会话所有权验证。

`agents.status` 的可选 `execution` 区分展示卡片和真正的 Code 执行器：
`{tool, controlSurface: "cli", entrypoint?: "claude-desktop"}`。Claude Desktop
的 Code 入口使用 Claude 托管 worker；它的原生 Chat/Cowork 历史保持独立只读。
缺省字段仅内置旧适配器采用兼容映射；显式 null、畸形字段、tool/执行面冲突
均不授予写操作。新建任务须与冻结的执行描述一致，续聊以实际会话执行面为准。

Claude Code 与 Desktop Code 都只使用显式 API，不能在未配置或失效时改用本机
登录账号。API readiness 与安装/历史读取能力分开：不可新发任务不代表不能
浏览历史或停止已接收的工作。Claude unknown/不可控历史不接收新发送或继续；
已尝试操作只核对原 UUID 的回执，不以新的 UUID 重放。
缺少 Claude API 的统一错误码为 `claude_api_required`。手机要求电脑报告
`api.configured: true`、`pending: false`、来源为 `computer/phone` 且具有有效
不透明 `accountId`；真正执行前仍由电脑校验。仅对已经 attempted 的 Claude
操作，允许在当前 API 变化后按原不可变命令和 UUID 查询/恢复原回执；不能换
API 重构旧命令。未 attempted 的操作不享有例外。

## 动态审批请求

`approval.request` 可附带 `approvalOptions: { version: 1, decisions: [...] }`。
动作仅包括 `allow`、`allow_session`、`deny`，须由当前适配器明确提供；电脑响应
注册表再次校验。旧描述缺省仅显示一次允许/拒绝；未来版本或畸形描述不授予权限。
问答与原生 Codex hook 不允许 `allow_session`。可选 `denyEffect: "cancel_turn"`
表示原生只支持取消本轮，不得把这个动作展示成仅拒绝一个工具。
禁止提交回答与禁止全部操作分别判断：仅提供 `deny` 的问题仍能拒绝；离线、
到期、处理中或已有待核对回执不能因此发起另一次授权。

请求队列随到达、撤销、过期、响应动态变化，以作用域和 request ID 锁定活动项，
不是固定 N 步向导。未提交的逐请求草稿仅留在当前会话内存；解绑重绑和换连接
不能带入旧草稿。`approval.resolved` 表示该请求已被处理或撤销，不是工具成功。
工具和 turn 的最终结果仍由原生适配器另外报告。

Claude 旧 prompt helper 只暴露单次允许/拒绝，不按 ToolName 记忆授权。
MCP 单请求取消贯通到电脑请求注册表，worker 存活不代表该请求仍然有效。
无来源关联字段时不猜父子身份；电脑重连快照不能从历史文本复活可执行审批。

API 选择也走同一个聚合目录：`AgentDescriptor.apiFamily` 是稳定的 API 路由族，
允许桌面/CLI 适配器共享一个 API 选择，也允许 Hermes 等扩展使用独立族。手机
只保存电脑生成的 `api_...` 不透明句柄，不接收地址或密钥；换站点时以
`station -> apiFamily -> account handle -> verified model catalog` 的顺序校验，
不会因为 Agent 名称或模型前缀猜测路由。旧 Bridge 没有该字段时按 Agent id 的
兼容规则运行。

旧 Hub/Bridge 实现已退出手机仓库，不再提供第二套服务器或桌面内核。历史协议可从 Git 历史查看，不能当作当前部署说明。

对话错误使用可选的稳定字段：命令失败回执 `code: "model_capacity"`，时间线
`turn` / `notice` 使用 `errorCode: "model_capacity"`。Bridge 识别 Codex 真实的
`codexErrorInfo: "serverOverloaded"`，并为旧运行时保留明确容量错误文本的兼容判断；
普通 HTTP 429 不等于模型满载。`notice.retrying` 只表示运行时明确报告正在重试。
手机保留原消息、提供模型选择和手动重试；失败或中断会暂停后续排队消息。

事件读取 `/app/events` 的 HTTP 429（新版可带 `code: "app_read_capacity"`）
表示 Hub 读取名额暂满，不代表电脑离线。手机保留原连接状态、历史和游标，
将限流交给后台同步的指数退避；不能将它吞成成功后立即循环，也不能清除先前
真实网络或鉴权错误来伪造在线。恢复后从原游标补收。此规则仅用于事件读取，
不改变命令发送、执行结果或上游模型的 429 语义。

Claude 原生 `system/api_retry` 同样使用 `notice.retrying`，按当前 turn 更新提示，
不产生停止/完成事件。未知错误类别不从原文猜测 Key、账号或额度；最终失败
不继承先前重试原因。`desktop.navigate` 返回只表示请求已交给本机处理器，
不能证明原生窗口实际打开了指定聊天；不确定时不自动重复导入。

Codex CLI 续聊将标准 UUID 的 `operationId` 传为原生 `clientUserMessageId`，
收到的 `userMessage.clientId` 用于匹配该条手机消息的回显。其他客户端的相同文本
不会替换这条回显。`clientId` 是相关标识，不能证明来源任务或 ChatGPT 身份；
缺少该字段的旧版本仍使用兼容逻辑。桌面原生发送接口目前没有这项回显参数。

原生 `agentMessage.phase` 透传为 `messagePhase: "commentary" | "final_answer"`。
`final` 表示消息条目结束，`final_answer` 才是明确报告的最终回复；不能把已结束的
中间进度当作最终答复。工具的 `outputFinal: true` 表示权威终态输出，允许明确的
空结果清除先前草稿，缺少字段的重复事件不清除既有附件和输出。

## 轻量项目文件与正文链接

电脑广播 `workspace.files.v1` 时，配对手机可按需调用
`workspace.files.list/read`。必填 `sessionKey`、`controlSurface: "cli" | "desktop"`
和冻结的 `expectedCwd`；`path` 只能是项目内相对路径。`expectedCwd` 是当前会话目录
断言，不能指定读取根目录。电脑须独立核对真实会话、显式配置的项目和物理文件句柄。

目录单页最多 50 项，后续由用户用返回的 `nextCursor` 手动读取；不递归扫描。
只读允许类型的 UTF-8 文本，单文件 128 KiB 上限。响应是目录页
`{path, entries, nextCursor?, truncated?}` 或文本 `{path, text, size, modifiedAt}`。
文件命令不携带 `requestId`，Hub 拒绝为它建立持久化回执；文件文本也不进入事件历史。
失去配对、切站、切会话、目录变化或手机后台均撤销读取；原生会话还要求精确的宿主授权。

手机正文链接只路由到系统 HTTP(S) 处理器、当前会话的只读文件页或同电脑任务侧边栏。
`codex://threads/<id>` 不构成读取权限；本地服务地址、安装/设置链接和任意执行 scheme
不自动打开。原生对话采用授权快照，现有 CLI Hub 事件不是原生事件流，不能混入同 UUID
的原生时间线。详见 [边界与验证](../../docs/maintainers/REMOTE-LIGHTWEIGHT-FILES-20261011.md)。

### 手机内嵌电脑前端预览

当电脑广播的链接是手机当前局域网或 VPN 可达的 HTTP(S) 服务地址时，手机工具栏可在
内嵌 WebView 中直接打开该前端。页面的点击、输入和表单请求由该页面直接发送回电脑服务，
因此这是前端的直接远程使用，不会把页面操作伪装成 Salcara 命令或写入对话事件。页面不会
经过 Salcara Hub，WebView 使用独立的无痕上下文、关闭共享 Cookie 和缓存；地址栏中不能
携带配对凭证、API Key 或其他授权秘密。

内嵌导航只允许保持原始 `origin` 的 HTTP(S) 页面；跨站跳转交给手机系统浏览器。电脑的
`localhost`、`127.0.0.1`、容器内部地址、数据库端口和其他仅绑定本机的服务不会在手机内嵌，
手机只显示直接浏览器入口或不可达提示。当前协议不提供任意端口转发、CONNECT、DNS 代理、
Docker/Node/Python 在手机执行，也不把“P2P”解释成公网 NAT 穿透。以后如需让手机查看电脑
本机端口，必须单独增加绑定电脑/手机/会话的短期预览租约，并限制端口、流量、并发和断线撤销。

## 站点能力、切换与执行授权

`station.guard.v1` 的 API 元数据包括 `sourceType`、`remoteEligibility` 与可选
`stations`。它们仅用于展示/禁选，不能代替 Hub 和 Bridge 的来源授权。普通 API
与官方账号远程分开判断；官方账号不从域名或名称推断归属站点。手机只提供
自己已配对、同一 `computerId` 且 URL/device 精确匹配的候选，候选能力最多使用
五分钟。新协议下不借旧 `station` 单字段自动切换到另一个站点。

`station.handover.v2` 配合 `station.guard.v1` 时，`remote.station.switch` 只迁移
已配对的连接，不经 A 为 B 的 API 获取执行 grant。正常通道与 B 的备用通道
各使用自己实际发现的能力；失败不降级为执行授权请求。切换仍携带同一个
`operationId`、目标已存连接/设备/电脑身份、可选来源句柄；API 与连接在电脑端
作为一次事务处理。`sourceOnly` 只保留当前选择，不赋予目标站的上游执行权限。
下一次模型查询和任务派发分别接受目标站的新策略验证。

新切换在持久日志写入前后复查候选能力，不能使用异步期间失效的能力发出命令。
已尝试操作只恢复原 UUID 与原 payload，不根据更新的卡片改写重试。旧 Hub 保留
协议兼容路径，但新 Bridge 仍需站点授权；不支持时明确拒绝而非放开来源限制。

`models.list` 虽不启动 AI 任务，也可能访问上游，因此必须接受来源验证。
模型目录、challenge 与 grant 共用 30 秒读取预算；慢授权不能把读取时间无界
延长。`source_*`、`station_*` 和 `remote_execution_disabled` 的策略 403 是当前
操作被拒绝，不应将仍正常的配对连接标记成电脑离线。

## 运行中引导与原生桌面能力

`session.steer` 只向已经由 Bridge 管理、仍运行的 Codex CLI 当前 turn 增加文字。
必须同时有 Agent `steer: true` 和 Hub `session.steer.v1`、`commands.idempotency.v1`。
参数包括 `sessionKey`、`text`、`expectedTurnId`、`operationId`、`accountId` 与
`controlSurface: "cli"`；不允许模型、思考强度、权限或图片覆盖。电脑调用真实
`turn/steer`，不启动、恢复或替换 worker，不把排队或另起一轮冒充即时引导。

成功回执的 `accepted`、`sessionKey`、`turnId`、`operationId` 必须精确匹配。
不确定送达只恢复原请求，不以新 UUID 重发。迟到回执不把结束轮次重新标记为
running。此路径没有已验证的 `clientUserMessageId` 回显契约，不能套用普通
`turn/start` 的相关性假设；实际内容以宿主记录为准。Claude 与原生桌面未声明
该能力时保持关闭。

原生桌面 `desktopLive.capabilities.navigate` 必须为 true 且当前未过期的租约
覆盖精确会话，才开放“在电脑打开”。旧版本缺字段或历史 client 名称不授予
启动权限。原生批准同时要求最新 lease、`approval: true`、`codex-hook-v1`
transport 与当前有效 pending 请求；保留旧请求展示不意味着它仍可执行。
离线/禁用只阻止按钮，不能被呈现成一直提交中。

问答与普通允许/拒绝都绑定当前页面的取消信号。信号贯通首次命令、来源
challenge/grant 与授权后的再次派发，离开会话或请求被撤销后不再继续这次
尚未完成的派发链。普通允许/拒绝保持单次尝试，不因此新增自动重试；问答
仍使用原持久回执。取消不能证明已被电脑接受的批准没有执行，也不会杀掉
已启动的任务；此类状态仍以原请求回执和电脑快照为准。

问答的 `approval.resolved` 增量可能先于提交回答的 HTTP 回执到达，并取消当前
等待。此时无需等待下一次全量快照：仅当当前配对作用域、会话、问题 ID
完全匹配，终态明确来自 phone/desktop 且事件顺序未倒退时，按原 UUID
结束这条持久回执。关闭页面、本地超时、旧事件或列表缺失都不能作为完成
证明；旧请求的收尾也不能删除替代 UUID 或新配对的回执。

问答持久回执保存完整的 `approval.respond` 命令，包括当时的 `accountId`
（也保留其明确缺省状态）。重启、电脑切 API 或状态刷新不能改写同一 UUID
的 payload。支持 `commands.receipt-only.v1` 的 Hub 使用原命令核对已接受回执，
此查询不得获取新来源 grant 或再次派发。卡片 handle 不随 Key/URL 修改而改变，
因此旧 Hub 即使支持幂等也不能证明原来源未变，保留原记录并停止重发。
`command_receipt_missing` 和 `command_receipt_pending` 都不是明确拒绝，必须
保留并阻止新 UUID；旧版本已经 attempted 但没有命令快照的回答也停止重发。

任务通知的 `notificationScope` 是 `ns1_` 加 64 位十六进制 SHA-256：输入为
`JSON.stringify(["salcara-notification-scope-v1", hubUrl, deviceId, pairToken])`。
它只用于导航关联，不是授权凭证；上报和通知 payload 都不包含原始配对 token。
`/app/push/register` 保存该字段，FCM 原样回传；本机后台 watch 使用同一导航
范围。后台提醒仅覆盖任务完成、失败和助手最终回复；审批与提问留在会话内，
不会通过系统通知打断用户。Hub 可使用 `kind: "done" | "failed" | "reply"`
发送不包含正文的 FCM 数据通知。通知 ID 同样按该范围隔离。
点击时必须与当前站点、设备和配对世代一致；旧无字段、重新配对或切站后的通知
只打开远程首页，不用当前连接猜测原任务。冷启动等待配对恢复后再核对；切换连接
同时清除原来源的临时运行任务、后台观察目标和尚未被页面消费的跳转目标。

连接恢复的旧读取不能覆盖后来选择的站点；扫码成功的 ready 状态与凭证、能力
一起发布。相同站点/电脑的重叠扫码只允许最新交换保存凭证，迟到的其它电脑
凭证可留存，但不会替换当前选择。Hub 的 `pair_persistence_failed` /
`pair_state_changed` 保留具体错误，不自动重放一次性二维码或配对码。

Android 后台服务慢启动时，在启动回执到达后再次检查前后台和连接归属，
补交接当前连接。后台待命偏好按操作顺序保存，旧启动读取不得覆盖新选择；
当前站点推送登记失败不能沿用上一站点的成功状态。

## 持久恢复 v2（2026-11-07）

能力名为 `commands.durable.v2`、`events.durable.v1`、`storage.blobs.v1`、
`events.binding-scope.v1`。手机只为新创建的发送记录冻结 v2 标志；旧 v1
已尝试的请求不得在升级后换成新的执行 UUID。已映射 v2 的请求也不能降级。

`POST /app/commands/prepare {deviceId,requestId,command}` 中 requestId 是
本地意图 UUID；返回 `{operationId,ticket,dispatchNotAfter,storageEpoch,state}`。
prepare 不执行、不需要来源 grant；同意图只返回原票据，不延长截止时间。
手机持久保存映射后，使用服务器 operationId 作为命令 operationId 和 envelope
requestId，并在 `/app/commands` 传 `executionTicket`。来源 grant 必须针对
最终命令获取。服务端拒绝将已有 v1 回执的意图重新 prepare。

`GET /app/operations?deviceId&operationId&ticket` 只读原回执，state 为
prepared/queued/pending/completed/uncertain/expired。completed 顶层 ok
是业务执行结果，错误可有 error/code/httpStatus；其它状态不能按成功执行处理。
202 queued 仅表示服务器已保存，手机须继续保留原待确认记录。结果本地保存后
调用 `POST /app/operations/ack {deviceId,operationId,ticket}`；ACK 失败可重试，
不得因此重新派发。所有 dispatchNotAfter/retainedUntil/expiresAt 均为 Unix 毫秒。

`/app/events` 增加 storageEpoch。手机先持久保存原始页和游标，再调用
`POST /app/events/ack {deviceId,sessionKey,through,storageEpoch}`，之后推进
内存游标。服务器世代变化返回 409 storage_epoch_mismatch；客户端保留本地
内容、清除旧序号戳并从 0 补读。电脑离线不妨碍读取仍保留的 Hub 页，TTL
缺口和正文截断必须可见。冷启动的保存事件不重新激活审批。

图片仍用 `att_<32hex>`，现有 attachment.put 分片可由 Hub 持久接收。
`attachment.read` 可带 `variant:'thumbnail'`，保留原 ID，但 size/sha256/
mime/width/height/data 属于派生 JPEG，客户端分别存缩略图 URI 与原图 URI。
无可用缩略图时明确失败，不偷偷传原图。原图最大 8 MiB，真实头部最大 16 MP，
thumbnail 长边 512，分页最多 90000 字节；会话授权仍适用。

Bridge 注册及 SSE hello/heartbeat 含 eventScope/eventScopeRequired，命令
envelope 同时冻结 eventScope。事件批次持久保存该字段；图片请求用
`X-Salcara-Event-Scope`。Bot 缺少或不匹配时拒绝为 409 event_scope_changed；
QR 原 bindingId/phoneHash 校验保留，提供 scope 时也必须一致。重启不改变
代次；换绑改变代次，旧批次不能重标为新绑定上传。

默认离线执行关闭；启用后只允许开放来源策略下 start/send，期限固定为
prepare 起 10 分钟。存储保留期不能延长执行期限。claimed 后退出保持
uncertain，不能自动重放。容量、清理与验证边界见维护文档
`docs/maintainers/REMOTE-DURABLE-RECOVERY-20261107.md`。

## 预览日志与额度恢复时间（2026-11-07）

电脑本地网页预览的 frame 响应可包含 `logsSupported:true` 和 `logs`。
日志为 `{id,level,message,source?,line?,column?,truncated?}`，level 仅为
debug/log/info/warn/error；行列为从 1 开始的真实来源位置。CDP Runtime
采集可用后才声明能力，主页面导航清空日志，序号不复用。最多保留 64 条、
32000 字节，每条正文最多 2000 个 UTF-16 单元，且不截断代理对。旧 Bridge 没有能力字段时手机明确
显示不可用。交互产物在受限 iframe/WebView 内采集实际 console/error/rejection，
以当前文档 token 校验转发；普通外部网页没有捕获能力时不声称支持。
日志只有用户选择加入时才追加当前对话草稿，事件到达不会聚焦或发送。

`turn` 和 `notice` 可包含 `retryAt`（Unix 毫秒）。只在 `errorCode` 为
usage_limit/upstream_rate_limit 且上游明确提供 resets_at（Unix 秒或带时区
的 ISO 时间）、retry_after（秒）、Retry-After（秒或 HTTP 日期）时投影。
相对时间以真实报错时间转换；历史缺少 completedAt 时不猜测相对时间。
SDK 退避、HTTP 429 本身、自然语言“稍后重试”均不生成 retryAt。
后续同一条状态事件未提供恢复时间时清除旧时间，不从此前错误继承重试计划。
此字段仅描述上游报告的时间，不构成自动发送或重新执行许可。

## 同一 Hub 的透明多入口（2026-11-07）

手机仍只保存用户填写的 canonical Hub URL。HTTP、SSE 与 Android 后台待命可以自动选择管理员发布的 HTTPS 入口；切换不修改连接 ID、配对凭据、通知命名空间、事件游标或命令回执归属。入口必须转发到同一个 Hub；多个独立 Hub 不能通过这一功能合并。

客户端只向原始 HTTPS `{canonical}/ingress/manifest` 获取公开清单，最多接受 8 个入口、24 小时有效期。清单包含 `version:1`、`hub_instance_id`、标准 Base64 编码的 32 字节 Ed25519 公钥、`canonical_url`、`revision`、`issued_at`、`expires_at` 与 `{id,url,priority}` 入口列表。时间戳为 Unix 毫秒，canonical 入口 ID 固定为 `canonical`。不接受 HTTP 降级、重定向、重复入口或私有 IP 地址。清单按 canonical URL 缓存在 SecureStore，过期缓存不能授权备用入口，备用入口也不能延长清单有效期。

原 canonical HTTPS 地址直接连接，不增加身份探测往返。向备用入口发送任何配对凭据之前，客户端使用 32 字节随机 nonce 请求公开 `/ingress/identity?nonce=<64位小写十六进制>`，验证 30 秒内的签名证明。签名覆盖以下 UTF-8 文本，最后没有换行：

```text
salcara-ingress-proof-v1
<hub_instance_id>
<nonce>
<issued_at>
<expires_at>
```

前台使用 Noble Ed25519 严格验签，Android 后台使用固定版本 Tink，算法不可用或验签失败时不能跳过校验。短期验证结果最多复用 10 秒；失败入口冷却 30 秒。每次选择最多检查 3 个入口，前台并发请求共享同一入口的身份验证，避免重复探测。原 canonical URL 始终是用户最初信任的地址，因此没有可用备用入口时回到它。

网络异常或 502/503/504 时，传输层仅允许 GET 再尝试一次；POST 发出后不自动重放。业务层已有的只读命令重试和稳定 requestId 回执机制保持原样。SSE 重连保留事件游标，权限错误不会触发跨入口重试。Android 后台继续在原通知范围内轮询，前后台交接携带已验证的公开清单；后台只向原 canonical URL 刷新清单。

订阅中的机场节点是代理出口，不会自动成为手机可访问的 HTTPS 入口。入口域名、有效 TLS 和同一 Hub 转发仍需管理员部署。真实 Android/iOS 设备以及公网运营商链路的延迟改善需要在实际部署后验证。
