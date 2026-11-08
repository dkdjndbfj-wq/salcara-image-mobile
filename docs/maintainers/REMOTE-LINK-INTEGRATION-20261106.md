# 新前端远程链路接线与协作验收（2026-11-06）

后续兜底、真实项目预览、成果版本及最终 Git 预算见 [2026-11-07 协作记录](REMOTE-RECOVERY-PROJECT-PREVIEW-20261107.md)。下文保留本轮当时的验证状态。

本轮根据共享工作区源码和主视觉对话的上下文核对远程接口。主视觉对话继续负责阅读密度、图片画布及预览；输入框对话负责权限、模型和思考程度。本轮只修改传输、解析、超时策略及相关测试，没有替换正在重构的界面。

## 已定位并修复的断点

| 用户操作 | 断点 | 处理 |
| --- | --- | --- |
| Direct 选择子仓库后审查、暂存 | `workspace-git.ts` 发送 `repositoryPath`，但 Direct 命令字段表没有它；请求在发包前被拒绝 | Git 读写协议接纳字符串仓库路径；保持未知字段拒绝、能力与仓库归属校验 |
| Direct 查看电脑操作和截图 | 工具事件字段表缺少 `computer`，导致整条事件连同附件被过滤 | 接通结构化电脑操作元数据，使用同一元数据解析器；验证历史、实时、加载中缓冲及重新打开 |
| Direct 接收批量生成图片 | 消息附件上限为 32，Bridge 与共享展示层为 64；第 33 张起整条消息丢失 | 使用共享 `MAX_OUTPUT_ATTACHMENTS`，验证完整 64 张及越界拒绝 |
| 流式回复、思考过程与纯图片消息 | Go `protocol.Event` 的空 `text` 和 `false final` 使用 `omitempty`；手机按必有字段校验 | Direct 历史/实时和 Hub 事件页/SSE 均补齐省略的空文本、未完成标记；共享 reducer 同时覆盖不带完整实时信封的历史与纯图片回执。错误类型仍拒绝或忽略，不强制转换 |
| 大仓库 Git 查询与操作 | Bridge 允许 90 秒，但手机普通读仅 20 秒单次、30 秒总计，Hub 默认 45 秒；Direct 也仅对部分 Git 操作延长 | 手机 Hub 与 Direct 所有 Git 请求统一 90 秒；Hub 默认 Git 等待 95 秒；显式配置仍优先，普通读保持原预算 |

Git 只读重试共享整个 90 秒预算；不确定的写操作不会自动重发。standalone 未设置超时环境变量时保留“使用默认策略”的语义，避免适配层把 45 秒强制传入 Hub。

## 核对范围

- Direct 的 57 种命令类型（包括交叉类型引入的字段）与协议字段表核对后没有剩余字段遗漏。这是静态字段核对，不能代替接口运行验证。
- 后端 `workspace.artifacts`、文件、预览、终端和 Git 均已在 Direct allowlist、Hub 策略与 Bridge dispatch 接入；没有为已存在路由重复添加接口。
- Bridge 已声明多仓库能力，读写响应包含仓库身份。实际临时仓库测试覆盖 stage、unstage、跨库拒绝、父子仓库隔离及受管理 worktree。
- Direct 集成测试贯通真实 `createDirectWorkspaceRuntime → createWorkspaceGit → requestDirect`。只替换连接 socket 和回执，保留协议编码及定时器，避免只 mock `requestDirect` 掩盖字段遗漏。

## 协作交接与未完成范围

1. 已向主视觉对话指出图片批注只回填文字和 opaque 附件 ID 的遗漏。该对话已接手把原图随批注加入原会话草稿，并处理读取失败、图片数量和模型能力。此项由对应对话验收，不计入本轮远程测试通过数。
2. 任意 React/TSX 项目的编译运行、项目级热更新和设计版本比较/恢复仍以 [UI 设计画布规划](UI-DESIGN-CANVAS-PLAN-20261105.md) 的待办为准，不能由 HTML 预览和远程路由测试推断已经完成。
3. 本轮验证为源码、真实临时 Git 仓库、协议及组件回归。没有安装实体手机应用、替换已安装 Bridge、部署线上 Hub 或调用付费模型，尚不等于已安装版本的完整设备端到端验收。

## 验证记录

- 第一组回归：10 suites / 180 tests 全通过，证据 `output/remote-link-integration-20261106.json`。包括 Direct API、Git runtime/RPC、历史、工作区、Git 服务、电脑操作组件、Hub Git 超时、来源策略、普通读取预算。
- Direct 原始传输事件补充：`src/__tests__/direct-wire-events.test.ts` 13 项通过，覆盖省略字段、纯图片、历史与实时合并及错误类型。
- 最终整合组：13 suites / 215 tests 全通过，证据 `output/remote-link-integration-final-20261106.json`，增加 Hub 事件页/SSE 14 项和原始历史/纯图片回执 8 项。
- 共享历史受影响回归：`hub-history-wire`、`hub-wire-events`、`remote-history-recovery`、`remote` 合计 99 项全部通过。不同组合存在重叠，不相加为唯一用例总数。
- 最终 `npm run typecheck` 退出 0；修改范围的 `git diff --check` 通过。
- 修复前已用失败测试复现：仓库字段拒绝、电脑操作事件丢失、64 图片消息丢失、Git 提前超时、Hub 合法事件拒绝和纯图片历史回执 `undefined.trim` 异常。

复验手机主要链路：

```powershell
npm test -- --runTestsByPath src/__tests__/direct-api.test.ts src/__tests__/direct-git-transport.test.ts src/__tests__/direct-history.test.ts src/__tests__/direct-wire-events.test.ts src/__tests__/direct-workspace.test.ts src/__tests__/workspace-git.test.ts src/__tests__/computer-activity.test.ts src/__tests__/computer-use-page.test.tsx src/__tests__/remote-git-command-timeout.test.ts src/__tests__/remote-source-grant.test.ts src/__tests__/remote-read-budget.test.ts src/__tests__/hub-wire-events.test.ts src/__tests__/hub-history-wire.test.ts --silent
npm run typecheck
```

以下后端定向测试已通过。前三条在 `salcara-desktop/remote/bridge` 执行：

```powershell
go test ./internal/hubclient -run 'TestWorkspaceArtifacts|TestWorkspaceTerminal|TestPreviewURLAndInputAdmission' -count=1
go test ./internal/hubclient -run 'TestWorkspaceGitRepositories' -count=1
go test ./internal/console -run 'TestDirectWorkspaceToolsRemainExplicitlySessionScoped' -count=1
```

以下命令在 `salcara-hub` 执行：

```powershell
go test ./internal/hub -run 'TestWorkspaceFilesPolicy|TestWorkspaceFileResponses' -count=1
go test ./internal/hub ./internal/standalone -run 'TestGitCommand|TestCommandTimeoutEnvironment|TestEnvConfigAndOriginValidation|TestWorkspaceFilesPolicy|TestWorkspaceFileResponses|TestCommandDispatch' -count=1
```
