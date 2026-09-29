# Salcara 远程编程 · 协议 v1

三个部分：

- **Hub**（`remote/hub`，Go，只用标准库）：部署在 sub2api 旁边，挂在同一个域名的 `/salcara-hub/` 路径下（nginx 转发）。只负责鉴权和在手机 ⇄ 电脑之间转发消息，不接触模型请求。
- **Bridge**（`remote/bridge`，Go，只用标准库）：装在用户电脑上的程序，开机自启，本地网页控制台，驱动 Codex（`codex app-server`）和 Claude Code（`claude -p --input-format stream-json`），读取本机会话记录。
- **App**（Salcara 手机端 `src/remote/*`）：设备 → 会话 → 时间线，发任务、继续对话、审批、停止。

为什么不是 sub2api 插件：sub2api 当前插件协议只有 `openai.oauth.outbound_transport.v1`（OpenAI OAuth 账号的出站转发），插件不能新增路由、WebSocket 或处理 Claude 流量（见 sub2api `docs/PLUGIN_DEVELOPMENT.md`）。所以 Hub 作为独立的小服务跟 sub2api 部署在一起，不改 sub2api 代码。

## 1. 鉴权（只有中转站用户能用）

所有 Hub 请求带 `Authorization: Bearer <中转站 API Key>`。

Hub 用同一个 Key 请求 `GET {SUB2API_URL}/v1/usage`：HTTP 200 = 中转站有效用户，否则 401。结果缓存（有效 10 分钟、无效 1 分钟）。

账号 ID = `hex(sha256(key))[:24]`。手机和电脑用**同一个 Key** 登录就能互相看到。Hub 不保存 Key 明文。

## 2. HTTP 接口（前缀 `/salcara-hub/v1`，Hub 也兼容去掉前缀后的 `/v1/...`）

通用：JSON；错误返回 `{ "error": "中文说明" }` + 对应状态码。SSE 用 `text/event-stream`，每 20 秒发一行注释 `: ping` 保活。

| 方法 | 路径 | 谁调用 | 说明 |
|---|---|---|---|
| GET | `/ping` | 任何人 | 无需鉴权，返回 `{ "ok": true, "service": "salcara-hub", "version": "1.1.0" }`，App 用它判断这个中转站是否支持远程编程 |
| GET | `/me` | App / Bridge | 返回 `{ "account": "…" }`，用于验证 Key |
| POST | `/bridge/register` | Bridge | body `Device`（见下），登记/更新设备 |
| GET | `/bridge/stream?deviceId=` | Bridge | SSE，`event: command`，`data: CommandEnvelope`。连接期间设备在线 |
| POST | `/bridge/events` | Bridge | body `{ "deviceId": "…", "events": [Event…] }` |
| POST | `/bridge/reply` | Bridge | body `{ "deviceId", "commandId", "ok": bool, "result"?: any, "error"?: string }` |
| GET | `/app/devices` | App | 返回 `{ "devices": [DeviceStatus…] }` |
| GET | `/app/stream?after=<seq>` | App | SSE。`event: event` data=Event（带 seq）；`event: device` data=DeviceStatus。先补发 seq>after 的缓存事件（最多 2000 条/账号） |
| POST | `/app/commands` | App | body `{ "deviceId", "command": Command }`。Hub 分配 `commandId`，转给 Bridge，**等待**回复（最长 45 秒）后返回 `{ "ok", "result"?, "error"? }`。设备离线立即返回 409 `{ "error": "电脑不在线" }` |
| GET | `/app/events?deviceId=&sessionKey=&after=` | App | 该会话缓存的事件（最近 500 条），用于打开会话时补齐 |

Device（Bridge 注册）：

```json
{ "deviceId": "uuid", "name": "我的电脑", "os": "windows|darwin|linux", "version": "1.0.0",
  "tools": [ { "id": "codex", "name": "Codex", "available": true, "version": "0.9x" },
             { "id": "claude", "name": "Claude Code", "available": true, "version": "2.x" } ],
  "projects": [ { "path": "C:\\code\\app", "name": "app" } ] }
```

DeviceStatus = Device + `{ "online": bool, "lastSeen": 毫秒时间戳 }`。

## 3. Command（App → Bridge）

`Command = { "type": string, ...参数 }`，Bridge 通过 `/bridge/reply` 回复 `result`。

| type | 参数 | result |
|---|---|---|
| `sessions.list` | `{ "tool"?: "codex"｜"claude" }` | `{ "sessions": [SessionInfo…] }`（最新在前，最多 100） |
| `session.open` | `{ "sessionKey" }` | `{ "session": SessionInfo, "events": [Event…] }`（历史转换成事件，最多 400 条） |
| `session.start` | `{ "tool", "cwd", "prompt", "model"?, "approval"?: "ask"｜"auto_edits"｜"auto_all" }` | `{ "sessionKey" }` |
| `session.send` | `{ "sessionKey", "text" }` | `{}`（会话空闲则续上；外部正在运行的会话返回错误“这个会话正在电脑上运行，结束后才能继续”） |
| `session.interrupt` | `{ "sessionKey" }` | `{}` |
| `approval.respond` | `{ "approvalId", "decision": "allow"｜"allow_session"｜"deny", "message"? }` | `{}` |
| `projects.list` | `{}` | `{ "projects": [{ "path", "name" }] }` |
| `models.list` | `{ "tool" }` | `{ "models": [string…] }`（可选，拿不到返回空） |

`sessionKey` = `codex:<threadId>` 或 `claude:<sessionId>`。`cwd` 必须在 Bridge 允许的项目文件夹内（或其子目录），否则报错“这个文件夹没有被允许远程操作”。

SessionInfo：

```json
{ "sessionKey": "claude:…", "tool": "claude", "client": "Claude Code｜Claude Desktop｜Codex CLI｜Codex IDE｜Codex App｜Salcara",
  "title": "第一句用户消息(≤80字)", "cwd": "…", "updatedAt": 1727590000000,
  "status": "running｜idle｜waiting_approval｜failed", "controllable": true, "model"?: "…" }
```

`client` 用来区分具体工具：Codex 用 thread 的来源字段（cli / vscode / exec / app-server 等），Claude 用会话记录里的 `entrypoint` 字段（如 `cli`、`claude-desktop`、`sdk-*`），拿不到就是 `Claude Code` / `Codex`。由 Bridge 启动的会话 `client` 仍按工具写，另外 Bridge 本地记住它是远程启动的。

## 4. Event（Bridge → Hub → App）

公共字段：`{ "seq"(Hub 填), "deviceId"(Hub 填), "sessionKey", "tool", "ts"(毫秒), "type", ... }`

| type | 字段 | 说明 |
|---|---|---|
| `session.updated` | `session: SessionInfo` | 新会话、状态变化、标题变化 |
| `message` | `id, role: "user"｜"assistant", text, final: bool` | 流式时同一个 `id` 多次发送，`text` 是**到目前为止的全文**（App 直接替换） |
| `reasoning` | `id, text, final` | 思考摘要（可选显示） |
| `tool` | `id, kind: "command"｜"file_change"｜"read"｜"search"｜"web"｜"mcp"｜"other", title, detail, status: "running"｜"done"｜"failed", output?(≤4000字), diff?(统一 diff，≤20000字), exitCode?` | 同一 `id` 更新状态 |
| `approval.request` | `approvalId, kind: "command"｜"file_change"｜"tool"｜"permission", title, detail, diff?, cwd?` | 需要手机批准 |
| `approval.resolved` | `approvalId, decision, by: "phone"｜"desktop"｜"timeout"` | |
| `turn` | `status: "started"｜"completed"｜"failed"｜"interrupted", error?, usage?: { inputTokens, outputTokens, costUsd? }` | |
| `notice` | `level: "info"｜"warn"｜"error", text` | 例如“Codex 没有安装” |

`title` 是给人看的短句（中文动词开头），例如 `运行 npm test`、`修改 src/app.ts`、`读取 package.json`、`搜索 “useEffect”`。

审批超时：10 分钟没人处理 → Bridge 自动拒绝并发 `approval.resolved`（`by: "timeout"`）。

## 5. 安全

- Hub 只转发，Key 只做哈希；Bridge 本地配置文件权限 0600。
- Bridge 只在“允许的项目文件夹”里启动任务；默认所有命令和改文件都要手机批准（`ask`），可选“自动批准改文件、命令仍询问”（`auto_edits`）或“全部自动”（`auto_all`，界面上标红提示）。
- 任务强制走中转站：Bridge 启动 Codex / Claude 时把地址和 Key 注入子进程环境/参数，所以费用照常记在中转站。

## 6. nginx 转发示例

```nginx
location /salcara-hub/ {
    proxy_pass http://127.0.0.1:8787/salcara-hub/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;            # SSE 必须关闭缓冲
    proxy_read_timeout 3600s;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # 安装脚本里的下载地址要用 https
    proxy_set_header X-Forwarded-Host $host;      # 安装脚本里的域名
}
```

## 7. 下载安装包（无需鉴权，v1.1 新增）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / HEAD | `{前缀}/download/<文件名>`（也兼容 `/download/<文件名>`） | 从 Hub 的下载目录（`SALCARA_HUB_DOWNLOADS`，默认 `数据目录/downloads`）返回文件。不在 `/v1` 下，**不需要 Key** |

- 文件名只能是下载目录里的普通文件：`[A-Za-z0-9][A-Za-z0-9._-]*`，不能有子目录、`..`、隐藏文件或符号链接，否则 404。
- Content-Type：`.sh` → `text/x-shellscript`，`.ps1` / `.txt` → `text/plain`，`.zip` → `application/zip`，`.exe` → `application/vnd.microsoft.portable-executable`，其他 `application/octet-stream`。安装包带 `Content-Disposition: attachment`，支持 `Range`（断点续传）。
- **模板**：`.sh` 和 `.ps1` 里的 `{{SALCARA_BASE_URL}}` 会换成这次请求对外的 Hub 地址（如 `https://relay.example.com/salcara-hub`），`{{SALCARA_RELAY_URL}}` 换成中转站地址（`https://relay.example.com`）。地址按顺序取自：`SALCARA_HUB_PUBLIC_URL`；开启 `TRUST_PROXY` 时的 `X-Forwarded-Proto` / `X-Forwarded-Host` / `X-Forwarded-Prefix`；否则请求本身的 Host。每一部分都做了严格校验（脚本会被 `| bash` 执行），不合法返回 400。
- 约定的文件（由 `bridge/build.sh` 生成在 `dist/downloads/`）：

  | 文件 | 用途 |
  |---|---|
  | `install-mac.sh` | `curl -fsSL https://中转站/salcara-hub/download/install-mac.sh \| bash` |
  | `SalcaraBridge-macos.zip` | `Salcara Bridge.app`（通用版：Apple 芯片 + Intel） |
  | `install-windows.ps1` | `irm https://中转站/salcara-hub/download/install-windows.ps1 \| iex` |
  | `SalcaraBridge-windows-amd64.exe` / `-arm64.exe` | Windows 程序 |
  | `SalcaraBridge-linux-amd64` / `-arm64` | Linux 程序 |
  | `SHA256SUMS.txt` | 校验和 |

App 可以用 `HEAD {前缀}/download/install-mac.sh` 判断这个中转站有没有提供安装包，再把安装命令展示给用户复制。
