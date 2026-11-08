# 远程对话草稿与前台发送生命周期核验（2026-10-11）

本记录用于审查新增内核，不代表已发布、完成手机真机验收或支持所有 Codex 原生能力。所有测试均使用合成存储、图片和 transport，不读取真实聊天、API Key 或账号数据，不调用模型。

## 修改范围

- `src/remote/composer-drafts.ts`：新增统一文字/图片草稿存储、恢复、图片懒加载校验、版本 CAS、已接受提交消费与精确配对清理。
- `src/remote/queued-image-files.ts`：复用已有有界私有图片缓存，新增精确 scope 的元数据 ownership 检查及发送时验证；未新增目录扫描或批量删除。
- `src/remote/drafts.ts`：严格存储读取、线性化文字/队列读取、冻结保存输入、原始旧记录保留、精确解绑清理接线。
- `src/remote/ThreadView.tsx`：仅草稿/图片及发送生命周期接线，修复新 Claude Code/Desktop 草稿混用、读取错误误标已查及后台 FIFO 推进。未重做 JSX 布局、样式、动效或添加新页面/控件；失败使用既有提示渠道。
- 回归：`remote-composer-drafts.test.ts`、`remote-draft-storage-reliability.test.ts`、已有 `remote-thread-dialogue-new.test.tsx` 的合成宿主与新增用例。

本记录不包含前一组 Sidebar 重试的修改；该组文件与验证由主任务统一记录。

## 确定缺口与实现

### 普通未发送图片草稿

之前只保存文字；页面退出/进程重启会丢掉输入框中的图片。现在文字与图片引用一起保存，私有 key 包含准确配对 credential scope、电脑和会话；新任务使用 `new:agent.id`，不再让 `claude` 与 `claude-desktop` 共用新任务草稿/队列。没有把旧 Claude Code 草稿猜测迁移到 Desktop。

新统一草稿的 SQLite 设置里只写图片元数据；图片字节进入已存在的 `remote-images-v2` 配对私有目录。恢复只读取元数据/存在状态，发送时才读取并校验全部图片。丢失、目录替换、其他配对的引用或内容哈希改变均阻止上传任务，不能悄悄改成纯文字。

仅统一记录真正不存在时，才读取原有相同私有 key 的文字草稿。损坏、未知、越界、暂不可读不等于不存在。首次恢复完成前不做空白自动保存；迟到恢复不能覆盖已输入的文字、已选的新图或新 Agent/配对。读取期间换 API 也不能静默丢掉原图后发送文字。

### 持久化边界

此前 `getSetting` / `JSON.parse` 失败都变成 `{}`，随后保存会覆盖其他用户草稿/队列。现在只有明确 `null` 是空表；其他错误拒绝恢复/写入并保留原数据。旧可识别队列记录仍为 blocked，不自动重放。更新其他记录或向同一队列追加新项时，未修改的 blocked 旧记录保留原始信息，不把一次读取当成主动迁移。

读取与写入按同一队列线性化；写入前冻结输入，失败不发布新状态。未知未来 FIFO 语义/冻结选项保持 blocked，不能按当前 FIFO 猜测执行。已有超界表不截断。正常有界策略保持：文字 50 会话/单段 100,000 字符；队列 20 会话、每会话 10 项、每项 4 图；队列表 JSON 编码上限 10,000,000 字符。新统一草稿最多 50 会话/JSON 编码 2,000,000 字符，新候选超过读端的相同编码限制时先拒绝，不能保存一个后续无法读取的表。

图片使用原有预算：每配对/类型 128 MiB，总计 512 MiB、最多 2,048 个已证明所有权的文件。没有每条消息清理：已提交回执、队列或历史仍可能持有这些 URI；只有精确配对退役才移除已证明拥有的非目录文件。先持久化退役 fence，再清理；旧/迟到 writer 不能重新激活已解除配对。

### 接受、隐藏与竞态

普通提交先保存统一快照，再懒加载原图，末端再次核对配对、会话、Agent、API、模型/强度、项目/授权选项、前台及当前桌面发送能力。恢复的 CLI 图片不能越过不支持 attachments 的原生桌面 lease；不降级到其他 executor。

当前 composer 有同步 busy 门，重复的旧发送 callback 不能在快照准备期间双发。已确认提交/移交现有回执后，只消费原 scope/key/revision。页面隐藏后的成功结果仍可清理原提交；新编辑的新 revision 不会被迟到结果清掉。先保留明确的空墓碑以防旧文字 fallback 复活，完成旧文本清理后再精确移除空记录。

跨重新挂载：已恢复旧 revision 的新 controller 遇到旧提交的 `consumedFrom` 空墓碑，仅真正的新文字/图片编辑可 reconcile 后继续保存；相同旧快照（仅两端空格也算相同）不能复活。旧 prune 看见同 key 的新 mounted owner 时不删除它需要的墓碑。新保存已先落盘、旧 consume 先落盘、二者异步 commit/stage 交错及 reconcile 写失败重试均有回归。

成功创建任务不等待本地清理成功才进入已创建会话；清理出错不能把一个已接受的新任务留在可重复提交的输入框里。该项最初不是新任务 operation outbox 的替代品；后续已接入主任务新增的 operation outbox（见下节），两者分别保护任务重放和草稿消费。

### 新任务待确认接线（主任务内核补齐后）

本组只负责 `ThreadView` 接线；`delivery.ts`、`new-task.ts`、`store.ts`、client/Bridge dispatch 属于主任务，不把组件模拟当作这些边界的端到端验证。

新 composer 现在同样必须成功读取对应 Agent/入口的待确认记录后才能提交。暂不可读不被当成“没有任务”，旧配对的迟到读取不能开启新配对的发送。Claude Code 与 Claude Desktop 使用不同的虚拟回执归属，不把虚拟 key 当成可打开的真实会话。

`startSession` 接收已准备草稿的准确 `composerDraft: {key, revision}`；未知送达时保留原草稿，用既有待确认 banner/AppDialog 显示原记录，阻止再创建 fresh UUID。只在用户选择既有“重试原消息”时调用 `retryNewSession`，不新增自动新任务重试、页面、控件、样式或动效。复制/停止重发仍复用原菜单；停止重发只清理原配对的虚拟回执，不取消电脑任务。

确认成功后只消费原草稿 revision。当前 controller 记录其 durable revision/snapshot：unknown 等待期间的新编辑，在手动重试前保存；同一页面收到迟到 accepted 后如已有新编辑，先保存新快照再 CAS 消费旧版本，不因相同文字或当前版本而清掉新草稿。同步 busy 门、实际 AppState 末端检查、配对/隐藏 owner 守卫同样适用于手动重试。

已有 durable `acceptedSessionKey` 的回执是本地恢复而非第二次发任务：即使普通 retry deadline 过期/uncertain 或电脑离线，也可通过原菜单手动恢复已接受会话。不会自动恢复，不越过配对/页面/后台 fence；store 仍负责确认准确会话归属和保证 cleanup-only 路径不调用上游。

已接受的新任务回执在原草稿 CAS 消费、旧文字镜像及空记录清理都成功前保留；组件通过 `acknowledgeNewSession` 做纯本地确认。进入已接受的会话可能已经改变视觉 owner，因此确认按原电脑、配对 scope、Agent/入口及接受结果校验，不按已失效的视觉 epoch 判断。CAS 失败（较新草稿）、本地清理失败、新编辑保存失败或配对变化均不确认；任务仍可导航，但保留原虚拟回执供核对，不能借此生成 fresh UUID。新编辑未成功持久化时不消费旧草稿，避免把可恢复记录清掉后只剩内存编辑。

### 存储错误与后台

`queueChecked` / `pendingChecked` 只有成功读到记录或明确成功不存在时才置 true。读取失败不误允许新消息，不启动循环重试；重新进入会话进行新的只读恢复。

手机 FIFO 只在前台推进，快照保存和图片读取后再检查实际 AppState。尚未跨传输、因进入后台暂停的 attempting 恢复 waiting，前台恢复后再发送；已经发给电脑的任务不取消。普通发送准备同样末端检查实际前台状态。

## 未借此宣称完成的能力

- 本组首次冻结时 `store.startSession` 尚无持久化 operation outbox；主任务随后独立补齐该内核，本组完成其恢复/手动重试/精确草稿消费接线。端到端断网重启、Hub/Bridge 记录及完整候选验证仍由主任务统一记录，不能只凭组件 mock 宣称全链路 exactly-once。
- 手机 FIFO 不等于 Codex 原生永久 Queue；本组未把它假称为 Steer 或 SideChat，也未改正在执行的 turn。
- 原生 Codex / Claude Desktop 能力依旧按真实 lease/capabilities 判断；公开 App Server RPC 或 CLI 能力不意味着已获得桌面授权。
- 未做真实账号/真实模型、Android 真机、跨公网断网演练或发布验收。没有改变官方账号反代、Named API 或 Bridge/Hub 来源授权文件。

## 验证记录

- 原存储覆盖问题 RED：6/6 回归失败（读错、损坏 JSON、未知顶层结构被当空表）；修复后通过。
- pending read / 后台 FIFO RED：3/3 独立回归失败；修复后 3/3 通过，未跳过被测项。
- 2026-10-11 分阶段 gated `typecheck` + 4 storage/image suites：64 tests 通过，含重新挂载 CAS 交错。
- 最终候选 gated `npm run typecheck` → 上述 5 个相关 suites：**5 suites / 202 tests 全部通过**（Jest 54.164 秒），包括 ThreadView 的恢复/图片/后台/回执/接受后清理与重复 callback 回归。
- 新任务组件接线第一组 RED：8 个指定恢复/手动重试测试均失败，1 个已存在隔离用例通过；接线后专项通过。随后新增迟到 accepted、新草稿、迟到恢复、前台末端、重复重试及 cleanup-only 边界回归。
- 接入 operation outbox 后最终 gated `npm run typecheck` → 同一 5 个 focused suites：**5 suites / 217 tests 全部通过**（Jest 56.873 秒；含 ThreadView 153 tests），未跳过被测项。该数字是专项组件/本地存储结果，不替代主任务的 store/Bridge/Hub 候选测试。
- 后续 ACK 接线专项先 RED：4 项中的 2 项失败（导航后未 ACK、新编辑保存失败仍消费旧草稿）；修复后 5 项 targeted 通过（含已有 newer-edit CAS 用例），随后 `typecheck` 和完整 ThreadView **157 tests 通过**。
- 独立内核审查新增 `remote-new-task-safety-review.test.ts`：最初 13 项中 12 项 RED；随后 old-owner/精确解绑两项均 RED，扩展 ID/虚拟哨兵两项也分别 RED。主任务修复后 gated `typecheck` → 该 **19 项**及 root 的 outbox / delivery / storage / retirement suites 合计 **5 suites / 78 tests 全部通过**（Jest 9.966 秒）。包括冻结输入、准确图片元数据/内容、未知字段/重复 JSON、原 UUID、接受结果持久化、精确本地 ACK、身份切换/退役及共享 Agent namespace；均为合成测试。该结果不代替主任务的全量手机/Bridge/Hub、真机或发布验收。
- 最终独立审查补充 generic delivery 错 Agent 的 accepted outcome 回归：原候选 RED（本来会保存无法重读的全局回执表）；主任务加入提交前 exact canonical namespace fence。最终 gated `typecheck` → 同一组 **5 suites / 79 tests 全部通过**（Jest 6.973 秒；独立 safety suite **20 项**），没有跳过被测项。后续全量验证仍由主任务执行。
- 已有 4 个生产/测试文件 scoped `git diff --check` 通过；新增文件和本记录 whitespace/conflict 检查 0 命中。
- 源码冻结交接。全量手机 Jest、完整项目检查、独立审查与发布由主任务统一执行，不能用阶段/专项数字代替全量或真机结果。
