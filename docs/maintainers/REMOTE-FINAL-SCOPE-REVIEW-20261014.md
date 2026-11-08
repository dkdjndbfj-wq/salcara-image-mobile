# 远程聚合作用域专项复核（2026-10-14）

本轮由独立协作代理核对手机换 API、换模型、换中转站、回执恢复和多用户作用域。保留既有修改，不改 UI 布局、动画，不提交、不发布、不连接真实账号或付费模型。

## 本轮确认并修复

### 1. 两个站点都明确未执行，新切站操作却一直处于待确认

时序：全新 A→B 操作先写本地 journal；A 返回 `409 computer_offline`，其 Hub 合约明确表示未派发；手机尝试 B 的备用通道；B 返回明确的授权/策略拒绝。原内层异常分支直接退出，遗漏清理此操作的 journal，后续选择其他目标会被上一次待确认操作挡住，最长持续到 24 小时过期。

修复：仅对**全新 journal、A 明确未派发、B 明确未执行**的组合，按原 operation ID 清理。B 的 401/403、明确的预执行策略业务错误属于此范围；网络异常、含 `command_delivery_uncertain` 的结果不属于此范围。

### 2. B 不支持备用通道的预检查失败，也会留下无效的新 journal

B `/ping` 没有 `station.standby.v1` 或幂等能力时，原实现抛普通错误，调用方不能安全区分“还没发送”和“发送后响应丢失”。

修复：将此**发送前**失败标记为 `station_standby_unsupported`，纳入上述有条件清理。若 A 原始派发不确定，或正在恢复旧 journal，即使 B 不支持备用通道，也仍保留原回执。

### 3. 新政策拒绝会误删旧的、不确定的切站回执

时序：原 A→B 请求网络响应丢失，原 journal 留待核对；稍后重试，A 在查询旧回执之前因新政策返回 403。原外层 catch 不区分新旧操作，直接删除 journal，失去核实原派发所需的 UUID。

修复：外层终止错误清理也要求 `!previous`。后来一次明确拒绝，不能证明原请求未执行。旧 journal 保留原 UUID/载荷；尝试改到 C 会被拒绝，不能用新 UUID 掩盖尚未确认的操作。

涉及生产范围仅：`src/remote/store.ts` 的 `requestStandbyHandover` 预检查错误与 `switchRemoteStationImpl` 两个 journal 清理分支。

## 验证证据

新增 `src/__tests__/remote-final-scope-review.test.ts`，全部采用合成域名、内存配置和合成配对凭证：

- A 明确未派发、B HTTP 403：清理新 journal，不切换手机连接。
- A 明确未派发、B 明确预执行业务拒绝：清理新 journal。
- A 网络派发不确定、B 拒绝：保留原 journal。
- 旧不确定 journal 重试，两站后来都拒绝：保留原 UUID/载荷。
- A 明确未派发、B 不支持备用通道：清理新 journal，B 没有收到切站命令。
- A 明确未派发、B 派发结果不确定：保留原 journal。
- 旧不确定 journal 重试时 A 新政策拒绝：保留原 UUID；实际尝试更换 C 被阻止。

红灯证据：第一组 4 项先出现 2 失败；扩展为 7 项后，预检查遗漏和旧回执被删再次出现 2 失败。修复后，与站点能力、设备配对、API 状态四套回归合计 **85 项通过**（28.69 秒）。最后补充实际改目标 C 断言后，独立文件 **7 项再次全部通过**（8.713 秒）。限定改动的 `git diff --check` 通过，仅既有 LF/CRLF 提示。此文件不代替最终全量报告。

## 独立静态核对结果

| 范围 | 已核对的边界 | 本轮结论 |
| --- | --- | --- |
| 换 API / 换模型 | 手机设备级变更锁、发送读锁；API 变更前后递增目录版本；Hub 身份变化拒绝旧异步响应 | 未在所检查路径找到新的可复现串 API 反例；不等于上游全模型真机认证 |
| 切换中转站 | 同物理电脑且已配对的目标；新站能力的显式选择；v2 只切传输、不向 A 申请 B 来源授权；固定 UUID/载荷 | 新增反例已修；任何未知派发仍保留原待核对操作 |
| 接收消息 | 每设备/会话游标；快照 revision；连接 owner 防止旧站异步数据写入；历史缺口先补快照再恢复增量 | 本轮未改消息算法；已有恢复测试随最终全量验收，不宣称现实弱网长时验证完成 |
| 电脑执行边界 | Bridge `dispatch.go` 的配置锁、身份与来源检查；`source_guard.go` 的本地来源与当前站点约束 | 只读核对；生产变更和 Go 验证归另一协调任务 |
| 多用户隔离 | Hub 回执以账号、设备、配对凭证共同派生 owner；同 UUID 不跨 owner 复用；并发测试含 32 组独立配对、伪回执、事件隔离、撤绑和队列隔离 | 已检查对应测试与实现；根任务报告 race 三轮通过，本代理未重复执行，不将它作为长期容量保证 |

## 未覆盖与限制

- 未运行真实 Android、跨运营商弱网、真实双站断网恢复或长时间容量压测。
- 32 组独立手机/电脑配对不等于允许多个手机同时控制一台电脑，也不能推导任意人数容量。容量还受 Hub 资源模式、CPU、磁盘和连接代理配置影响。
- 原生桌面能力必须同时满足生产安全门禁与真实宿主能力/租约，不能只凭有效租约授予控制。在生产 `RemoteExecutionArmed` 模式下，native `send`、`approval`、`modelOverride`、`navigate` 保持关闭；托管 CLI 能力不能冒充原生桌面能力。下文 native 组件合成测试仅验证手机不把两套能力混为一谈，不表示这些生产能力已开放。
- 未修改其它代理负责的授权、账号池、站点配置、Hub 管理台代码。
- CodeRabbit 在该 Windows 环境前轮安装报不支持系统；本记录是静态链路追踪与合成 Jest 回归，不是 CodeRabbit 通过报告。

结论：本专项确认的三个切站回执状态问题，以及下文追加的问答增量回执收尾、发送能力动态撤回问题，均已做最小修复。需要与根任务的最终手机全量、Bridge/Hub 测试结果合并验收；不能仅凭此专项宣称整个远程系统不存在其它问题。

## 追加：取消批准复核与问答收尾修复

复核对象：`store.respondApproval` 将 `receipt.signal` 传给 CLI/native 两条 `command`；`ThreadView.decide` 为普通批准也创建 controller 和单次 UUID。初始阶段为只读复核；确认下述既有问答竞态后，经根任务授权单独修复，并在根任务释放 Jest 后顺序测试。

已核对：

- 两种执行面均把 signal 传过最初命令、source challenge、source grant 和授权后的再次提交；不会只取消按钮而继续后台授权派发。
- 普通批准只走单次调用，没有进入 `prepareQuestionReceipt` / `deliverQuestionAnswer` 的自动重试与恢复队列。一次来源授权协商保持同一个 UUID，native `operationId` 与该 UUID 相同。
- 隐藏、换会话、配对 scope 改变会取消 controller 并清除 request owner。晚到结果不能解除新请求的 busy，也不会在原 request owner 已撤销时显示旧错误 toast。
- 普通批准的真实 resolved 先于 HTTP 结果到达时，pending effect 会撤销 request owner，故随后发生的 abort 不会误报为当前批准失败；后端按 session 与 approval ID 一次性消费，不因下一次手动点击换 UUID而重新执行同一审批。
- 网络请求已经到达电脑后，取消 HTTP 等待不能撤回已批准的动作。本修复不做“取消即撤销权限”的保证，也未新增这种产品语义。

另发现并用真实 `ThreadView` 合成组件回归确认一个**既有问答收尾竞态**：

1. t0 建立会话快照；t2 用户提交后来出现的问题，生成并标记已尝试的持久 QuestionReceipt。
2. 电脑的 `approval.resolved` 增量事件早于该 POST 的 HTTP 结果返回，pending effect 取消 controller / request owner。
3. `deliverQuestionAnswer.check` 抛 `QuestionDeliveryCancelled`，`decide` 因而不执行 `finishQuestionReceipt`。
4. 增量事件不会推进 `timeline.snapshotStartedAt`；现有 reconciliation 只清理创建于 t0 之前的记录，所以 t2 的已解决问题回执仍可能残留。
5. `hasPendingDeliveryForDevice` 会把残留回执计为待确认，阻止换 API/中转站，直到额外的权威快照刷新清除它。

此时序不是普通批准被加入问答重试，也不是新引入的跨站派发；是 resolved 先到时持久问答回执收尾与快照截止时间不一致。原有 restored-answer 测试同时推进了 snapshot 时间，未覆盖“仅增量事件、快照时间不变”的情况。

修复生产范围仅为 `src/remote/ThreadView.tsx` 的当前问答 context 与 `decide` 的取消分支，不改布局、动画、普通批准协议或快照回收规则：

- context 保留当前会话作用域与时间线，取消后的异步收尾不读取提交时的陈旧闭包。
- 仅当当前绑定作用域和会话作用域都匹配，且存在同 ID 的 `question` 终态、来源是 `phone` 或 `desktop`，才认为已由真实事件完成。
- 两端都有事件序号时，终态序号必须大于提交时待处理项；终态的电脑时间戳也不能早于原待处理项。电脑时间不与手机 `createdAt` 跨时钟比较。
- 使用既有 `finishQuestionReceipt` 按 scope、device、session 和原 request UUID 精确删除；同问题的新 UUID、重新配对后的记录不会被旧回执删除。
- 仅隐藏、过期、时间线缺项、timeout、缺少明确来源、其它问题/类型、旧序号/时间都保留原回执，不能冒充已送达。写盘失败同样不伪造清理成功。

新增回归位于 `src/__tests__/remote-thread-dialogue-new.test.tsx`：

- phone/desktop 两种真实 resolved 增量先于 HTTP 回执，快照时间保持旧值；验证实际持久队列已空，并通过实际 API 选择交互验证设备级待确认检查不再阻挡。
- 隐藏、过期、缺项、timeout、旧终态、旧序号、相同序号、旧时间、缺来源、不同问题、不同类型，共 11 个保留 UUID 的场景。
- 同问题被新 UUID 替换、绑定凭证改变，共 2 个旧异步完成不能清理新 owner 的场景。

红灯：原 9 项中 2 个完成场景失败、7 个保护场景通过（18.109 秒），失败的内容正是持久回执残留。修复后原 9 项全部通过（15.443 秒）；追加独立序号/时间/来源/身份边界后 **15 项全部通过**（13.585 秒）。`npm run typecheck` 与限定路径 `git diff --check` 通过，只有既有 LF/CRLF 提示。

最后顺序运行完整 `remote-thread-dialogue-new`、`remote-question-delivery-new`、`remote-question-outbox-new`、`remote-question-retirement`、`remote-delivery-storage`、`remote-delivery-retirement`、`remote-question-dock-new`、`remote-question-semantics-new`、`remote-final-scope-review`：**9 套 / 324 项全部通过，0 跳过，93.491 秒**。随后冻结本专项生产和测试文件，并把 Jest 使用权交回根任务执行最终全量。此处不把同一批回归的重复运行次数叠加成测试数量。

此前全量快照（不包含下一节新加的发送门禁补丁）：根任务 `npm test -- --silent` **116 套 / 1,935 项通过、8 项原有跳过，219.226 秒**；`npm run typecheck` 与限定范围 diff-check 通过。该快照包含本专项切站与问答补丁，但不能作为最新源码的最终全量结论；最新冻结全量见末节，也不以其替代 Android 真机或实际跨站弱网验收。

## 追加：发送能力撤回与权威 Agent 目录门禁

根任务只读契约核对发现：`store.requireTurnCapabilities` 会验证 `available`、`remoteSendSupported` 与显式 `capabilities.send`，但 `ThreadView` 的 CLI 发送判断原来只检查 execution 和 Claude API 资格。电脑与 Hub 仍在线、Agent 已不可用或撤回发送能力时，手机按钮或排队任务仍会尝试派发，再被内核拒绝。此外，已加载目录删除一个 Agent 后，`list.find(...) ?? agent` 会重新使用旧 prop 中的能力；旧的排队/Continue 按钮回调也可能沿用过期闭包。

生产仅修改 `src/remote/ThreadView.tsx` 五处：

1. 引入现有统一 `agentSupports` 契约，不另造 Agent 能力表。
2. 目录尚未权威加载时允许所选 prop 补充初始状态；目录 `loaded` 后缺项返回 `null`，不再用旧 prop 复活已撤回的 Agent。
3. CLI 发送同时要求实际 `currentAgent`、正确执行面、`agentSupports(currentAgent, currentAgent.id, 'send')` 与既有 Claude API 资格。Claude Desktop Code 使用自己的 `claude-desktop` ID，不借用同族 Claude Code 的可用状态/API；不修改 projection 全局 legacy 兼容规则。
4. `send` 入口使用既有 `composerSendCurrent()` 实时 owner 门禁，使晚到的普通/排队/steer 点击不能沿用旧发送许可；异步草稿保存、图片恢复与自动 FIFO 继续使用相同实时状态检查。
5. `continueTask` 入口也使用相同实时 owner 门禁，避免旧 Continue 点击在能力撤回后调用继续命令。

没有改 JSX 布局、样式、动画、Go、Hub 或桌面能力生产门禁。React 技能的派生状态与实时 ref 规则用于复用现有状态边界，没有新增轮询或为了能力变化清空编辑器。

### 数据与执行边界

- 撤回能力只阻止新的派发，不自动发停止、不取消已经交给电脑执行的命令；已派发命令的正常回执仍可完成原草稿所有权移交。
- 草稿文本、图片和 FIFO 次序保留。开始派发前已撤回时保持队列等待，恢复能力后只发送原队首；在 attempting 写盘期间撤回时，原队首置为 blocked，保留后续项目，恢复能力本身不自动重放该尝试。
- 不删除未知送达回执，不修改原 UUID，也不把原回执当成新的消息发送。明确恢复原消息时仍只提交 `retryRequestId`，不以当前模型/API覆盖原冻结载荷。
- native 分支仍读取独立 `desktopLive` 契约，不能因 CLI 不可用而改成 CLI，也不能因 CLI 可用而开放 native。合成测试中人为提供的 native 发送许可不代表生产 `RemoteExecutionArmed` 模式开放了该能力。

### 16 项聚焦组件证据

新增于 `src/__tests__/remote-thread-dialogue-new.test.tsx`，过滤命令为 `npm test -- --silent --runTestsByPath src/__tests__/remote-thread-dialogue-new.test.tsx -t 'send admission'`。

- Codex 的 unavailable、remote-send、send capability、已加载缺项，以及 Claude Code 不可用、Claude Desktop Code 撤回发送、扩展 Agent 删除，共 7 项动态撤回/恢复；保留草稿并验证旧发送回调无派发，恢复后确实可发。
- 旧运行中排队点击、旧 Continue 点击、普通消息图片恢复期间撤回，共 3 项异步边界。
- FIFO 撤回后按序恢复、attempting 写盘期间撤回后阻止自动重放，共 2 项队列边界。
- native 与 CLI 能力隔离、已经派发任务不中断、未知回执 UUID 保留并精确恢复，共 3 项保护场景。
- 目录尚未加载可用 prop 补充、权威加载缺项后必须收回许可，共 1 项兼容边界。

先红：最初 15 项为 **12 失败、3 通过，17.633 秒**，失败覆盖撤回后仍可发、旧 prop 复活、过期按钮回调及异步/FIFO派发。最小生产修复后为 **14 通过、1 失败，16.126 秒**；剩余失败是新测试误查并不存在的“第二条独立队列标签”（既有 UI 只显示首条与总数），只修正测试为首条/总数断言，没有修改 UI。再补上述目录加载兼容用例后，最终为 **16 通过，15.331 秒**；同文件另 217 项因 `-t` 过滤未运行，不计为本轮验证通过。

生产和测试随后冻结并交回根任务；最新合并验证见下节，不能用此前 1,935 项快照替代。

## 根任务最终合并验证与读取限流（2026-10-14）

根任务修正新发送门禁测试中的 TypeScript fixture：Promise resolver 包装为 `() => resolve(undefined)`，不改变生产行为或弱化断言。

Hub 对空长轮询与 SSE 共享实际活跃名额后，新增限流联动反例发现：`syncSessionEvents` 原来把读取 HTTP 429 一律记成连接错误。现在只对事件读取的 429 保留进入前的连接状态、错误、历史和游标，仍向 `useLiveSync` 抛错以触发既有指数退避；不清除之前的真实错误，不伪造成功，不推进游标，不更改收发协议、UI 或动画。

- 新增 history recovery 六例：typed/untyped 429 保留健康连接；网络/401/403/503 后的 429 保留原错误；恢复按原游标补收。
- 新增 live sync 一例：2 秒、4 秒退避，成功后恢复常规 250ms 调度；卸载后不再发起读取。
- 先红：七例中六失败、一通过（18.206s）；修复后连同 history/liveSync/ThreadView/aggregation/queue-handoff 五套 **303/303 通过（138.231s）**。
- 最终 `npm run typecheck` 通过；完整 `npm test -- --silent`：**116 suites / 1,958 tests 通过，8 项原有 skip，219.031s**。
- 选定的 338 个 TS/TSX/Kotlin/JSON 与 package 输入文件在全量前后 SHA-256 聚合相同：`271ac4a42ea108797a2aad727369971eaeaeed40b9f7d2aa49bdf7992b89305d`。之后仅修改发布 workflow/发布脚本和文档，未修改此内核快照。限定范围 diff-check 通过（仅 LF/CRLF 提示）。

这些结果验证合成组件、状态机与 TypeScript。它们不代替 Android 原生编译、真机 FCM、覆盖升级保留配对/草稿、双站真实弱网、原生宿主能力证明或长期多用户容量验收；不能据此直接签署全功能商业发布。
