# 临时工具侧聊

## 使用

侧边聊天默认只读。支持此协议的托管 Codex 可在权限菜单选择“请求批准”，运行独立的临时项目任务。当前执行模式仅支持文字输入，可选当前网关已报告的模型和推理强度。普通只读侧聊仍按能力支持图片与正文引用。

输入 `/` 打开命令列表，可搜索和选择计划模式、技能、模型、推理强度和权限；`$` 直接筛选技能。只读侧聊先通过权限菜单选择“请求批准”，然后读取私有运行环境实际可用的模式和技能。计划状态会保留，技能作为下一条消息的结构化输入；选择命令本身不会发送消息。支持点击、方向键、Enter/Tab 和 Escape，关闭菜单保留原文。

执行记录和审批仅出现在本临时聊天内。可允许或拒绝单次操作、停止当前临时回合，或“结束”整个私有运行环境。同一项目有主任务或其他工具侧聊执行时，新的写入需等待。

## 协议

电脑在 `session.side-question.catalog.inputOptions.tools` 返回：

```json
{"version":1,"permissions":["workspace-write"],"features":true}
```

Hub 额外声明 `session.side-question.tools.v1`。缺少任一能力时不显示执行选项。命令 `session.side-question.tools` 的动作包括 `open/read/features/send/stop/approve/close`，都绑定父会话、当前执行源、独立 chainId 和快照 revision。除 read 外均必须有 operationId；停止和审批必须指定私有回合，审批仅有 allow/deny。

`features` 在 open 后读取私有 worker 的原生目录，不启动模型回合；响应含可选的 `features: AgentFeatures`。`send` 接收可选 `skills: SkillReference[]` 和 `collaborationMode: default | plan`，发起回合前重新核对私有目录，并传递原生 skill input / collaborationMode。目录最多 160 KiB，超出时明确失败，不截断后冒充完整目录。旧电脑未声明 `features: true` 时不提供此执行菜单。私有 CODEX_HOME 中没有安装的宿主插件和技能不会出现在目录中。

返回为独立状态、lastOperationId、单调 sequence、文字回答、工具事件与待审批列表。最多 128 条事件、16 项审批、64 KiB 回答、240 KiB 总响应；省略记录明确提示。输出不进入父任务全局事件流，不导入父任务图片缓存，不持久化 Hub/Direct 回执或手机聊天数据库。

## 生命周期与边界

Bridge 使用私有 CODEX_HOME、新建 ephemeral 线程和当前网关凭据；确认项目写入沙盒、审批归属及无自动目标后才发起模型请求。主任务的继续、停止和审批均不复用。项目层添加了未支持的 MCP/插件配置时拒绝执行。

有效前台订阅续接 45 秒租约。关闭页面或切到后台停止轮询；租约到期、解除绑定、API/项目/运行源改变时回收私有 worker。普通 Direct 重连保留同一绑定身份。送达不明时仅读取状态，不自动重发；关闭后可明确开始新的侧聊。

当前只对已核验的托管 Codex app-server 版本开放，原生 Work 没有独立临时执行合同，不通过 CLI 回退。此功能尚未进行真实付费模型或实体 Android/iOS 验收。
