# 远程统一审查

`RemoteReviewPage` 是 Hub、Direct 与显式演示状态共用的审查组件。它位于当前会话的右侧工具页，不创建额外的全局 Git 管理入口。所有真实操作只针对 `GitSelection` 中当前电脑、Agent、会话、执行通道与授权仓库根目录，不支持跨项目的 “All repositories”。

## 范围与交互

- 未暂存：工作区相对暂存区的改动，包含普通文本未跟踪文件。
- 已暂存：暂存区相对 HEAD 的改动，与未暂存内容分别查看。
- 分支：比较所选引用与 HEAD 的共同祖先到 HEAD；不混入未提交改动。
- 提交：查看所选提交相对第一父提交的改动，包含合并提交和初始提交。页面提供最近 30 个提交和显式引用输入。
- 最近一轮：来自父会话传入的原始 `FileEdit[]`。同文件的连续编辑保留为独立快照，不直接拼接不同版本补丁。选择一个快照时，由电脑重新核对该快照与当前仓库的操作条件。

当前工作区范围支持整个文件和单个完整 unified hunk 的暂存、取消暂存和撤销。撤销先显示确认，执行使用用户看到的仓库 revision 和补丁标识。历史分支/提交只读。已暂存撤销使用 `git apply --reverse --index`：当工作区还有其他未暂存改动时可能拒绝，不会直接 `restore --worktree` 覆盖它们。

Git 比较的行批注通过 `onCompose(text)` 加入主输入，包含文件、范围、仓库 revision、差异摘要、旧/新行号、原样代码快照与用户评论；不会冒充来自会话 timeline 的引用。最近一轮继续使用 `ContextReference(kind: 'diff')` 的 `onReference` 接口。二者均由用户在主输入发送，不会在点击添加批注时调用模型。

## 能力与协议

基础旧 Git 操作仍使用 `workspace.git.v1`。统一审查必须另外声明 `workspace.git.review.v1`。Bridge 仅在支持的平台且找到 Git 可执行文件时一起发布这两个能力。Hub 与 Direct 手机端在审查请求发送前后检查新增能力。

所有请求均带 `sessionKey`、`controlSurface`、`expectedCwd`。新增字段如下：

```ts
// 只读；last-turn 还需 path 和 sourceDiff。
{ type: 'workspace.git.read', action: 'review',
  reviewScope: 'unstaged' | 'staged' | 'branch' | 'commit' | 'last-turn',
  reviewRef?: string, path?: string, sourceDiff?: string }

// 修改；branch/commit 范围不允许修改。
{ type: 'workspace.git.mutate', action: 'review-apply',
  expectedRevision: string, reviewScope: 'unstaged' | 'staged' | 'last-turn',
  path: string, patchRevision: string, hunk?: string,
  operation: 'stage' | 'unstage' | 'discard', sourceDiff?: string }
```

审查响应包含当前 `GitState`、明确的 scope/base/ref、文件列表、逐文件完整差异与 `patchRevision`、增删行数、可操作的 hunk ID 和旧/新行范围，以及最近提交列表。

未暂存和已暂存操作在电脑上重新生成 canonical Git 差异，不接受手机提供的任意替代补丁。最近一轮仅接受指定单一路径的完整文本补丁；拒绝多个文件头、错配路径、越界或不完整 hunk、特殊文件模式与不支持的扩展差异。

修改前执行 `git apply --check`（整个文件暂存/取消暂存除外），再次读取仓库快照并比较 `expectedRevision`，重新验证会话 cwd、授权项目、根目录句柄、配对身份与 command guard，然后执行一次修改。修改后重新读取状态。未知结果不自动重试，要求刷新核对。

## 降级与边界

`readOnlyLastTurn` 在旧电脑端、只读来源或缺少 Git 项目授权时保留已有最近一轮差异及批注；不创建 Git transport，不调用 status/review，也不展示可执行的仓库按钮。

- 当前审查总差异上限 192 KiB；新文本文件读取上限 128 KiB。
- 二进制、符号链接、权限/复杂重命名等差异可以说明原因，分块操作不伪造成功；二进制当前仅支持整个文件暂存或取消暂存。
- 最近一轮旧快照与当前工作区/暂存区不一致时拒绝修改。手机未保存的编辑器草稿不随 Git 撤销被清空。
- 文件路径/仓库 revision 改变会使旧操作失效；不同电脑及会话不能复用先前授权。
- 演示通过 `createDemoGitFactory` 使用同一页面和客户端响应解析，状态明确标注为示例，不调用 Git、模型或远程仓库。

## 验证

`workspace_git_review_test.go` 在临时真实 Git 仓库检查分块暂存/取消暂存/撤销、部分暂存保护、过期 revision、错误 hunk、分支/提交隔离、初始提交、Unicode 无尾换行新文件、最近一轮路径约束及修改前授权撤回。

`remote-review-page.test.tsx` 验证共享页面的范围切换、实际状态变化、批注来源、撤销确认、不重试未知写结果、跨电脑迟到结果隔离，以及无 Git transport 的旧主机降级。Direct 契约测试验证新增能力和精确 hunk 字段不会丢失。

## 子智能体工具页

`SubagentManager` 默认仅展示子会话名称、角色、真实状态、打开入口与每行更多按钮，按运行中、已结束、状态未确认分组。刷新、停止与继续放在更多菜单；刷新全部与全部停止放在页头管理菜单。刷新失败会撤下原先的运行快照并归入未确认，停止结果未知不重发。

控制仍由原 `subagent-controls` 校验当前电脑/API、父子关系、执行通道、精确运行轮次和宿主能力。批量停止冻结当时每个可控子会话的快照，逐个请求；没有把主任务的 spawn 完成当作子任务完成。这里的分组与扩展管理操作是本项目的明确设计，不作为未经验证的 Codex 原生 UI 证据。
