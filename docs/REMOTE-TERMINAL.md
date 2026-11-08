# 远程交互终端

终端标签连接当前电脑的真实 PTY。Windows 使用 ConPTY + PowerShell，Linux/macOS 使用系统 PTY + Bash（不可用时使用 sh）。终端保留当前目录、环境变量和前台程序，可使用 Ctrl+C、Tab、Esc、方向键以及调整窗口尺寸。

## 页面生命周期

- 用户显式打开终端标签才启动 shell；`RemoteTerminalPage` 在后台标签中持续挂载，仅切换 `active`。
- 切换标签保留 shell，关闭标签会结束 shell。退出后可以“重新打开”。
- 切换电脑、配对代次、会话、授权项目或连接失效会禁用旧输入。旧连接不会向新电脑补发命令。
- Bridge 每 5 秒重新检查授权；终端 90 秒未收到读取、输入或调整尺寸请求后自动关闭。Windows Job Object 会同时结束子进程。
- Web 和 Android/iOS 都使用本地打包的 xterm.js，无远程脚本/CDN；原生平台通过 WebView 渲染。依赖更新后运行 `node scripts/build-terminal-assets.mjs` 重建原生内嵌文档。

## 协议

电脑能力：`workspace.terminal.v1`。所有命令携带 `sessionKey`、`controlSurface`（`cli`/`desktop`）、`expectedCwd`。Bridge 从真实会话读取 cwd，要求其对应电脑明确保存的项目。`expectedCwd` 只用于防止陈旧请求。

| 命令 | 专用字段 | 作用 |
| --- | --- | --- |
| `workspace.terminal.open` | `operationId`, `cols`, `rows` | 幂等创建，每电脑最多 4 个终端 |
| `workspace.terminal.read` | `terminalId`, `cursor` | 增量读取，可安全重读同一 cursor |
| `workspace.terminal.input` | `terminalId`, `sequence`, `data` | 串行输入，序号防止重复执行 |
| `workspace.terminal.resize` | `terminalId`, `cols`, `rows` | 更新 PTY 字符尺寸 |
| `workspace.terminal.close` | `terminalId` | 结束 shell 和子进程 |

读取返回 `terminalId`、`startCursor`、`cursor`、`dataBase64`、`truncated`、`exited`、`exitCode`、`nextSequence`。输出采用 512 KiB 有界缓冲，每次最多返回 48 KiB；丢失较早输出时明确显示提示。只有最后一段输出返回 `exited=true`。命令输入最多 16 KiB，UI 会分批发送粘贴内容。

终端是用户主动打开的本地系统 shell，权限与电脑上的 Bridge 相同；项目根是启动目录，并非 OS 沙箱。Bridge 的配对令牌、API 密钥及其它服务环境变量不会继承给 shell。终端不会借用 Agent worker，也不会修改 Agent 的 API 配置。

## 验证

`go test ./internal/hubclient -run TestWorkspaceTerminal` 检查真实 Windows PTY 的持久状态、Ctrl+C、子进程结束，以及输入去重、项目/会话/配对隔离、缓冲回放和环境变量过滤。

手机端：`npm test -- --runTestsByPath src/__tests__/remote-workspace-terminal.test.ts src/__tests__/remote-terminal-page.test.tsx` 检查传输顺序、失败不重放、切换电脑失效、后台标签不重启、输入合并和关闭后停止轮询。
