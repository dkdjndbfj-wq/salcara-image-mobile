# 多 Agent 聚合：执行链路收敛与审查记录

本轮接续用户“多 agent 聚合完成了吗，如果还没完成可以继续完成”。此前已有聚合目录、归一化事件和扩展注册底座，但“可以注册”不等于实际执行、模型目录、API 切换和恢复链路都正确。本轮修这些内核缺口；不新增 Agent 卡片，不重做手机或桌面布局、样式、动画。接续侧栏修复仅复用原 footer 及简短重试标签，详细范围见下文。不提交、发布或部署。

接续实施又补齐共享凭据预算、项目 provider 围栏、进程生命周期和新任务/图片草稿。下方分阶段验证只证明当时的候选；最新统一手机 1515/1523 项通过及 Bridge/Hub 验证见 [远程内核可靠性记录](../../../salcara-desktop/remote/bridge/docs/REMOTE-KERNEL-RELIABILITY-20261011.md)，不累加旧数字或沿用旧源码摘要。

## 现有产品与扩展边界

- 已有 Codex、Claude Code、Claude Desktop 的不同执行面；共用传输、配对、事件、分页、回执、缓存和换站机制，而不是让它们共用一个 Codex 执行器。
- CLI 扩展必须使用真实 `Agent.ID == Descriptor.ID == Tool`。共享 API 只能声明 `APIFamily`，不能借另一工具的名字执行。
- Hermes 在本轮测试中只是合成扩展，不是可运行的生产适配器。没有它的真实执行文件发现、协议映射、会话分页及生命周期验收，不能称 Hermes 已接入。
- 原生 Codex 桌面使用独立授权面；Claude Desktop 的 Code worker 与 Chat/Cowork 只读历史分开。能力消失不降级到 CLI。扩展 CLI 不能假称原生桌面、或复用 Codex 桌面授权。
- 扩展需要可信的 reasoning/model 元数据协议；未知 effort 明确拒绝，不猜模型名、也不静默丢参数。
- 本轮不是所有 Codex 功能的复刻；头像、来源任务、Steer 等宿主功能仍见 [对话能力核对表](REMOTE-CONVERSATION-FEATURE-AUDIT-20261011.md)。本机网页隧道仍未实现，见 [文件与链接边界](REMOTE-LIGHTWEIGHT-FILES-20261011.md)。

## 修复项

### 电脑聚合层

1. 注册时拒绝重复/保留 ID、错 ID/Tool、非法 family、非 CLI 扩展；未知扩展不会因实现了 mandatory Go 方法获得权限。
2. 实际 list/read/start/send/interrupt/approval/questions/model/image 入口检查 descriptor。明确的 false 必须生效，不只在 UI 显示禁用。
3. 模型、effort、附件采用有界类型解析。缺少 Options 接口不能丢掉参数后继续执行。扩展不继承 Claude 默认模型。
4. 返回目录、历史和事件核验会话 namespace 与 Tool；归一化复制后再发布，不篡改适配器原数据。只读能力不显示可执行；未支持图片/问答不冒充可操作。
5. 实时扩展用 optional `EventSinkBinder` 绑定核心检查后的 sink；只有 Watcher 方法不构成接入权限。没有 binder 的扩展保留 snapshot-only 路径。
6. Close 等待已进入的事件分发，解绑后的旧 sink 不再发布。Bind/Close 不在 event lock 内调用；sink 不得同步重入 Manager.Close。
7. Claude Desktop 的 Code worker list/read 与独立只读 history 分别证明；只读 history 不能授予发送能力。
8. API 选择和跨站切换中的显式模型覆盖，同样需要真实适配器能力；共享 API family 不授予执行器权限，纯换 Key/source-only 不额外要求 modelOverride。
9. 模型目录和目标站点的等待期间可能出现 late busy；API 写入前重查所选 family，整机换站前重查全部 family/原生状态。拒绝时不修改来源、站点或回执，也不停止任务。Bridge 自有 Start/Send 仍受 taskConfigMu 隔离；这不构成对任意外部 OS 进程的原子控制。

### 手机聚合层

1. 扩展目录发送真实 Tool，不再把所有非 Codex 工具路由到 Claude；client 分区仅用于已知 Claude 两种来源。
2. 会话进入和连接页核验精确注册。未知/错族来源不回退 Codex、Claude 或第一个 Agent。保留已知内置工具旧版本兼容，不扩给任意扩展。
3. 执行前守住 list/read/send/interrupt/approval/questions/modelOverride/attachments/imageInput；异步目录、快照和增量页返回后重新检查，能力撤销时不发布迟到结果或继续分页。
4. 读取模型目录不要求覆盖能力；实际指定模型/effort才检查覆盖能力。仅换账号不被误当作发送。
5. 选择账号按 exact Agent profile 取句柄，不拿共享 family 选另一执行器。family 变更清除全部兄弟工具模型缓存及在途请求 revision，目录仍按真实 Tool 独立保存。
6. snapshot、incremental、session.updated 核验 key/Tool；扩展不能通过假 desktop/read-only 元数据进入原生读取。发送也不能指定 desktop 绕过扩展能力。
7. 审批成功的本地回执携实际 Tool，不再硬编码 Codex，避免 Claude/扩展问题卡未即时消除。
8. lastAgent 与持久换站 journal 保留有效扩展 ID。恢复核验 exact Agent；同 API family 的另一 Agent 不能证明原 Agent 已应用。重试保留原 UUID、来源及 sourceOnly 标志。
9. 全目录与名为 `all` 的合法扩展使用无歧义请求键，不再互相取消并留下分页永久 loading。
10. 手机待回答状态按电脑/会话/问题编号的 JSON tuple 存储，不要求所有 Agent 的原始请求编号全局唯一。相同编号或 `__proto__` 不能覆盖其他工具的问题；成功回执、快照与过期清理只影响对应会话。原始编号仍原样交给真实适配器，UI/问题卡片样式不改。

## 同一 API 曾在 Claude 使用、手机现在远程 Codex

这不是必须关闭 Claude 的条件。API 是上游凭据，不是会话或 Agent 身份：

- 不同 family 可显式使用同一 vault 账号；手机仅更换 Codex 的 API 卡片，不修改 Claude 的 RemoteAPI/协议/会话，也不停止 Claude。空闲窗口没退出是正常场景。
- 同一 family 的多个适配器明确共用配置时，任何 sibling 忙碌都挡住切换；换站移动整台电脑的传输，要等待其他受管 Agent/子任务/审批/事件尾部空闲。
- 编辑共享卡片的原始 Key、URL 或删除卡片，不同于“给某工具选另一张卡片”，会影响全部引用。旧 managed worker 的后续请求必须失败关闭，不能继续把旧配置当新来源。不能承诺所有共享工具完全无影响。
- Codex connSig、Claude workerSettingsSig 在空闲续聊时比较上下文设置；改变后只重启 Bridge 自有 worker，并恢复原会话。忙碌/子任务/审批未结束时拒绝，不杀用户自行打开的 Claude。
- 当前 loopback 路由密钥按工具 family/账号指纹/运行租约隔离，远程路由另带站点/绑定身份；同一原始会话/审批编号不跨 namespace 路由。Key 的相同文本不授予另一个 Agent 或 Hub 的权限。
- 本机/远程 gateway 的租约证明是本软件当前许可，不证明 OS 进程身份或原生 app 实际 provider。外部软件绕过 Salcara 直接使用上游 Key 的流量不能由此关闭或计量；只能在上游撤销原始 Key 才能全局失效。原生 provider 的来源证明仍有限制：受限模式禁止未证明的 native send/approval，open 模式放开不是证明手机选 Key 等于原生实际 Key。

## 本轮文件范围

- 手机：`src/remote/projection.ts`、`store.ts`；`RemoteHome.tsx`、`RemoteScreen.tsx` 仅路由和身份守卫，不更换渲染样式；`remote-projection.test.ts`、`remote-home-flow-new.test.tsx`，新增 `remote-agent-aggregation-kernel.test.ts`；审批 map 的既有 API/history/native 测试改为按真实 scope 断言。
- Bridge：`internal/agents/agents.go`、`manager.go`；`internal/hubclient/aggregation.go`、`dispatch.go`、`history_pages.go`、`api_directory.go`、`agent_status.go`、`station_switch.go`；注册、聚合和 API 模型能力回归测试及一个旧 test double 的 namespace 修正。
- Hub：本轮没有修改 Hub 实现，不宣称重跑了 Hub 全量。以前文件/来源策略记录是历史候选证据，不能替代新客户端验证。
- 另一个用户任务负责官方账户、额度池、usage ledger 与本机 apply 租约；已协调文件归属，其修复不作为本轮独立完成项。

## 接续复核：切换守卫与目录重试

用户询问剩余遗漏后，本任务先完成只读复核，并通过协调任务的原始人类消息核实继续完成的授权。随后只落实以下明确漏项，不扩大到反代/OAuth/账户 UI，不提交、发布或部署。

1. **扩展 family 的隐式合并。** 修复前 `NormalizeAgentFamily` 会删除任意 `-desktop` 后缀，导致没有显式共享声明的 `hermes-desktop` 覆盖 `hermes` 的账号/模型选择。新增 config/registry/routing 三层测试先复现失败，再将归一化限制到 `codex-desktop`、`claude-desktop` 两个内置别名。扩展保留精确 ID；明确声明 `APIFamily` 的共享仍受 sibling busy 保护。没有把原来的隐式共享配置自动复制到新 family，避免误认授权；旧扩展应重新选择或明确声明 family。密钥库不删除、不迁移。泛用 gateway 路由仍只开放已支持的内置工具，不把此修复当成生产 Hermes 接入。
2. **待回答与运行计数分离。** Claude MCP HTTP 表单的有效租约可以在当前回合结束后仍等待，原 `ActiveRemoteTurns` 只看回合/子任务，会放行 API/整机换站。Codex/Claude 的切换检查改为同时检查未过期审批，包括没有 worker/proc 的待回答状态；读取审批时不持 agent/proc mutex，避免反向锁。Codex `ensure` 设置变更分支也拒绝重启已有待回答的旧连接，普通同设置读取不受影响。合成回归覆盖真实 registry、已认证 MCP hook、成功/失败 result 后仍待回答、回答/撤销/过期后解除，以及拒绝切换时配置和回执不变。
3. **侧边栏首批读取失败。** 原先失败会置 `loaded:true`，重开不再读取；没有下一页游标时 footer 也不给重试。接续修复区分 head/more 错误并复用已有 footer 手动重试；首批失败不是“没有对话”，有旧游标的首批刷新失败不能误加载下一页。错误连接不应永久禁用已配对设备的只读重试；配对、授权、执行面和迟到请求归属仍须验证。不更换布局、样式或动效，不增加无限自动重试。
4. **旧 Codex 连接的审批归属。** 复核 `ensure` 竞态发现 command/file/permissions 审批没有绑定 `c.done`，旧 `onExit` 在连接已替换时提前返回，迟到旧请求可能留下待回答状态。这是具体连接代际缺口，不是笼统的 OS 并发窗口。现已将 command/file/permissions/question/MCP 五类审批绑定原连接生命周期：关闭源不能注册、展示、占用 busy 或接收回答；当前连接只能回答自己所属的请求。旧等待者仅清理自己的唯一审批 ID，不能清除同会话、相同原始 RPC ID 的新问题；供应商撤销请求时跳过已关闭源的同名引用。回归包括验证过程中关闭、暂停旧事件发送后新请求先到、旧请求迟到及同 session/ref 复用，均为合成连接，不启动真实进程。

接续文件范围：`internal/config/remote_api.go`；新的 `internal/config/agent_family_alias_test.go`、`internal/agents/aggregation_family_alias_test.go`、`internal/hubclient/aggregation_family_alias_test.go`；`internal/agents/api_switch.go`、`codex.go`、`codex_requests.go`、`questions.go`、`util.go`；新的 `internal/agents/api_switch_pending_test.go`、`codex_approval_connection_test.go`、`internal/hubclient/pending_approval_switch_test.go`。手机仅 `src/remote/RemoteSidebar.tsx`、`store.ts` 的目录类型及三个目录的错误状态局部，以及新增 `remote-sidebar-recovery.test.tsx`、`remote-sidebar-directory-kernel.test.ts`。`errorPage` 是内存状态，不写缓存或持久配置；复用原 footer/按钮/spinner，首批错误短标签为“没有读到对话”“重试”，未重做样式、布局、动画或 ThreadView。

所有接续源码已冻结。专项验收：family alias 的 config/registry/routing 三包普通测试、race 与 vet 通过（race config 1.319 秒、agents 1.564 秒、hubclient 4.380 秒）；pending-only/ensure/旧连接审批最终 race 通过（agents 14.838 秒、hubclient 3.483 秒），两包 vet exit 0，8 个归属文件测试前后 SHA256 不变，格式/冲突检查通过。手机接续 8 套件/231 项通过（52.835 秒）、typecheck exit 0。随后主任务完成冻结手机候选的统一全量，准确结果见验证部分；此前 1364 项通过仍仅是接续修复前候选，不能代替新结果。统一 Bridge 全量由协调任务在这些文件冻结后执行，不把专项 race 当作整个 Bridge 验收。

上面的四项窄修冻结时，同一上游 Key 的不同卡片仍按卡片 ID 计算预算。接续实施已将池和固定来源汇入同一凭据指纹并发/冷却预算，防止不同卡片/工具绕过；不同域名、URL 挂载或受保护引用不凭猜测合并。外部软件同时刷新同一 OAuth token 仍没有跨进程仲裁。真实项目 provider 校验、进程级临时认证、新任务持久回执与图片草稿也已继续实现，准确修复及最终候选验证见 [远程内核可靠性记录](../../../salcara-desktop/remote/bridge/docs/REMOTE-KERNEL-RELIABILITY-20261011.md)。原生实际 provider 来源证明、真实手机/电脑/双 Hub 弱网验收、本地网站隧道以及完整 Codex 宿主操作仍保留前文边界。

## 审查与验证

两项只读审查分别覆盖 Bridge 注册/执行和手机路由/聚合。手机复核发现并促成修复审批 Tool、假原生面、模型覆盖门、异步撤销、换站同族误认及 `all` 读取槽竞态，不把已有测试通过当作没有漏洞。

- 新聚合手机回归覆盖真实 namespace/account、未知/缺失能力、参数门、foreign snapshot/增量、缓存迟到填充、审批确认、能力中途撤销、目录槽冲突和换站 journal；不调用模型服务。
- 审批 map scoped 补修前的五套相关手机测试：160 项通过，28.145 秒；独立复核的聚合/projection/native 隔离三套测试 44 项通过。随后全量 88 套件/1362 项通过、8 套件/8 项跳过，127.541 秒；317 源文件摘要一致 `fbc366aae35986744b44cab10a0ce48821d482ab0af2b747da442e08f1b51179`。这些是 scoped 补修前候选，最终必须重跑，不把旧结果冒充新结果。
- 审批 scope 补修后的最终手机候选：`npm run typecheck` exit 0；`npm test -- --silent` exit 0，88 套件/1364 项通过、8 套件/8 项跳过，共 1372 项，126.1 秒。验证前后 `src`、`modules` 两个目录共 317 个源文件的集合摘要一致：`6e180bf052b4971939616a836c6b92c1f6a363bf48ce5426867a4d8216175859`；测试期间没有源码更改。四套审批/历史/聚合相关回归 86 项通过（7.231 秒），独立只读审批复核的两套测试 34 项通过（4.082 秒），未发现新的必修项。
- Bridge 最后模型覆盖和 late-busy 窄修已冻结，定向 race exit 0：agents 1.777 秒、hubclient 14.342 秒，包含聚合、注册、options、文件、状态、只读桌面、API 和换站回归；两包 vet、scoped whitespace 检查通过。额外 shared-account 四项测试/race exit 0（hubclient 1.651 秒）。统一 Bridge 全量由协调任务在双方冻结后执行，尚未作为本轮最终结果收到。
- 接续四项修复后的最终手机候选：`npm run typecheck` exit 0；`npm test -- --silent` exit 0，90 套件/1403 项通过，8 套件/8 项跳过，共 1411 项，134.028 秒。验证前后 `src`、`modules` 共 319 个文件的集合 SHA256 相同：`82a58fb8dd836dce4d5ad2fda2f21de4183f4b9c3275a167f697658c2f3e8652`。跳过项仍未验证，不计为通过；摘要只覆盖这两个目录，不冒充依赖、原生构建或完整仓库摘要。
- 接续独立审查：两名代理分别复核手机目录与 Bridge 连接/审批边界；主任务另只读复核最终侧栏 owner/capability/分页失败处理及审批生命周期、当前连接消费、原请求撤销逻辑，没有发现新的必修项。本轮已识别并修复的遗漏、仍未完成的功能与真机边界分开记录，不据此声称不存在任何竞态或全部商业验收通过。
- 手机改动范围的 tracked whitespace 检查通过；新建手机/Bridge 聚合源码、测试与交接文档逐行检查无尾随空白或冲突标记。未改布局、样式、文案、动效；未提交、发布或部署。
- 全部使用合成配对、会话、文件、HTTP/RPC 和账号句柄，不读取真实密钥、实际聊天或调用付费模型；没有 Android/Windows 真机端到端、真实 Hermes 或宿主接口权限验收。

完成标准是当前适配器在统一链路中保持正确身份与真实能力，不是宣称所有模型、所有 Agent、所有宿主功能或所有平台已经全量可用。
