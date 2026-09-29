# Salcara Bridge（电脑端远程编程助手）

Salcara Bridge 装在你的电脑上，开机后在后台运行。它让手机上的 **Salcara → 远程编程** 看到并操作这台电脑上的 **Codex** 和 **Claude Code**（包括 Claude 桌面版 Code 标签页里的会话），同时提供一个本地网页控制台，一键把这些工具接入你的中转站（类似 Cockpit Tools，但只服务于你自己的 sub2api 中转站）。

- 单个可执行文件，无需安装运行库，只用 Go 标准库编译。
- 控制台地址：<http://127.0.0.1:47831>（只监听本机）。
- 协议说明见 `../docs/PROTOCOL.md`。

## 安装与首次使用

### macOS（推荐一行命令安装）

打开“终端”（启动台 → 其他 → 终端），粘贴下面一行回车（把域名换成你的中转站）：

```bash
curl -fsSL https://你的中转站/salcara-hub/download/install-mac.sh | bash
```

脚本会下载 **通用版 `Salcara Bridge.app`**（Apple 芯片 M1/M2/M3/M4 和 Intel 都能用），装到 `~/Applications`（“访达 → 应用程序”里的个人应用程序文件夹，不需要管理员密码），然后打开它。浏览器会出现控制台，中转站地址已经填好，只需填 API Key 登录。

为什么推荐这种方式：没有经过苹果公证的 App 从浏览器下载后，macOS 会提示 **“已损坏，无法打开”** 或 **“无法验证开发者”**。用 `curl` 下载的文件不带“隔离”标记，脚本还会再用 `xattr` 清一次，所以不会被拦截。

**手动安装**（从浏览器下载 `SalcaraBridge-macos.zip`）：

1. 双击 zip 解压，把 `Salcara Bridge.app` 拖到“应用程序”文件夹。
2. 第一次打开：**右键（或按住 Control 点按）→ 打开 → 打开**。
   - 如果提示“已损坏”：打开终端运行
     `xattr -dr com.apple.quarantine "/Applications/Salcara Bridge.app"`，再双击打开。
   - 如果提示“无法验证开发者”且没有“打开”按钮：打开 **系统设置 → 隐私与安全性**，在页面底部找到“已阻止使用 Salcara Bridge”，点 **仍要打开**，输入密码确认。
3. 如果你直接在“下载”文件夹里、或在磁盘映像里打开了它，程序会**自动把自己复制到 `~/Applications/Salcara Bridge.app`** 并从那里继续运行（开机自启也指向那里），原来下载的文件可以删掉。

**在 Mac 上的表现：**

- 它是一个“后台应用”：**不会出现在程序坞里**，也没有菜单栏图标，界面就是浏览器里的控制台 <http://127.0.0.1:47831>。已经在运行时，再次在“应用程序”里双击它，会重新打开控制台。
- 第一次登录成功后自动开启开机自启：写入 `~/Library/LaunchAgents/top.salcara.bridge.plist`。macOS 13 及以上会弹出通知“已添加后台项目”，可以在 **系统设置 → 通用 → 登录项** 里看到 Salcara Bridge。
- **文件访问权限**：项目放在“文稿”“桌面”“下载”、iCloud 云盘或移动硬盘里时，Codex / Claude Code 第一次读写那里，macOS 会弹窗询问 **“Salcara Bridge”想访问…** —— 请点 **允许**（这些 AI 工具是由 Salcara Bridge 启动的，所以权限记在它名下；开机自启时如果没人点，任务会报“Operation not permitted”）。点错了可以到 **系统设置 → 隐私与安全性 → 文件和文件夹**（或“完全磁盘访问权限”）里给 Salcara Bridge 打开。把项目放在 `~/code` 这类普通文件夹里则不会弹窗。
- **找得到 Codex / Claude Code**：开机自启或从访达打开的程序拿到的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，找不到 Homebrew、npm、nvm 装的命令。Bridge 会读取你的登录 shell（`$SHELL -ilc`，最多 3 秒）里的 PATH，并额外查找 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.npm-global/bin`、`~/.local/bin`、`~/.claude/local`、`~/.nvm/versions/node/*/bin`（优先 `nvm alias default`）、`~/.volta/bin`、`~/.bun/bin`、`~/.asdf/shims`、fnm、mise、pnpm 等位置；启动 Codex / Claude Code 时也把这些目录放进它们的 PATH，保证 `#!/usr/bin/env node` 能找到 node。如果 shell 配置文件很慢或有问题，可以设置环境变量 `SALCARA_NO_SHELL_PATH=1` 跳过登录 shell。

### Windows

PowerShell 里运行（不需要管理员）：

```powershell
irm https://你的中转站/salcara-hub/download/install-windows.ps1 | iex
```

会装到 `%LOCALAPPDATA%\Programs\SalcaraBridge\SalcaraBridge.exe`，并在开始菜单建快捷方式。也可以直接下载 exe 放到固定位置（例如 `D:\Tools\`）双击运行。

### 所有文件

| 系统 | 文件 |
|---|---|
| macOS（Apple 芯片 + Intel） | `SalcaraBridge-macos.zip`（内含 `Salcara Bridge.app`，推荐），或裸程序 `SalcaraBridge-macos-universal` |
| macOS（只要一种芯片的裸程序） | `SalcaraBridge-macos-arm64` / `SalcaraBridge-macos-amd64` |
| Windows（Intel/AMD） | `SalcaraBridge-windows-amd64.exe` |
| Windows（ARM） | `SalcaraBridge-windows-arm64.exe` |
| Linux | `SalcaraBridge-linux-amd64` / `SalcaraBridge-linux-arm64` |

### 首次使用

1. 程序启动后浏览器会自动打开控制台。在「登录 / 中转站」填写中转站地址和 API Key，点 **保存并登录**。
   - 第一次登录成功后会自动开启 **开机自启**（可在「设置」里关闭）。
2. 在「项目文件夹」添加你写代码的文件夹。
3. 在手机 Salcara → 远程编程 里用**同一个 Key** 登录，就能看到这台电脑。

程序只能运行一份：已经在运行时再次打开，只会打开控制台页面。

## 控制台页面

| 页面 | 作用 |
|---|---|
| 概览 | 与远程编程服务的连接状态（已连接 / 连接中 / 未登录 / Key 无效）、设备名称（可修改）、中转站余额与今日/累计用量、Codex / Claude Code / Claude Desktop 是否安装及版本、会话数量、待审批的操作 |
| 登录 / 中转站 | 中转站地址 + API Key（测试按钮会请求 `/v1/usage`）。高级选项里可以给 Codex、Claude Code 分别指定 Key：sub2api 的分组按平台划分，**Codex 需要 OpenAI 分组的 Key，Claude Code 需要 Anthropic 分组的 Key** |
| 工具配置 | 一键接入中转站 / 恢复原配置（见下文） |
| 项目文件夹 | 允许手机发起任务的文件夹列表，可手动输入或用内置的文件夹浏览器选择 |
| 会话 | 本机所有 Codex / Claude Code / Claude Desktop 会话；点开可看实时时间线、在电脑上直接批准/拒绝操作、继续对话或停止 |
| 设置 | 开机自启、开机时是否打开控制台、审批策略（每次询问 / 自动批准改文件 / 全部自动）、默认模型、最近 300 行日志、程序和配置文件的位置（可在访达 / 资源管理器中打开）、退出程序 |

## 如何保证流量走中转站

- **手机发起的任务**：Bridge 启动 Codex / Claude Code 时把中转站地址和对应 Key 注入子进程的环境变量 / 参数，费用照常记在中转站。
- **你自己在终端 / IDE 里用的工具**：在「工具配置」一键写入：
  - **Claude Code** → `~/.claude/settings.json` 的 `env`：`ANTHROPIC_BASE_URL` = 中转站地址（不带 `/v1`）、`ANTHROPIC_AUTH_TOKEN` = Claude Key、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` = `1`。其他设置和键顺序保持不变。
  - **Codex** → `~/.codex/config.toml`：顶层 `model_provider = "salcara"`，并写入
    ```toml
    [model_providers.salcara]
    name = "Salcara"
    base_url = "https://你的中转站/v1"
    wire_api = "responses"
    requires_openai_auth = false
    supports_websockets = false
    experimental_bearer_token = "sk-…"   # 或 env_key = "SUB2API_API_KEY"
    ```
    注释、其他表和其他键原样保留，重复执行结果不变。可选“环境变量”模式：配置里只写 `env_key = "SUB2API_API_KEY"`，Windows 上自动用 `setx` 设置用户环境变量（重新打开终端后生效）；macOS / Linux 需要自己在 `~/.zshrc`（Mac 默认 shell）或 `~/.bashrc` 里 `export`。注意在 Mac 上，从程序坞 / 访达打开的 App（VS Code、Codex App 等）读不到 `~/.zshrc`，所以 **Mac 上推荐“写入配置文件”方式**。
  - 路径在各系统上相同：Claude Code 是 `~/.claude/settings.json`（设置了 `CLAUDE_CONFIG_DIR` 时用它），Codex 是 `~/.codex/config.toml`（设置了 `CODEX_HOME` 时用它）。
  - **Claude Desktop** → 在应用内设置（Mac 上在屏幕顶部菜单栏）：Help → Troubleshooting → Enable Developer Mode，然后 Developer → Configure Third-Party Inference：Connection type 选 Gateway、Credential 选 Static API key、Gateway base URL 填中转站地址、Auth scheme 选 Bearer。控制台里有复制按钮。它自己的设置保存在 macOS `~/Library/Application Support/Claude/`、Windows `%APPDATA%\Claude\`、Linux `~/.config/Claude/`。
- 第一次修改前会把原文件备份为 `settings.json.salcara-bak` / `config.toml.salcara-bak`，「恢复原配置」会把备份放回去。

## 安全说明

- **只有中转站用户能用**：远程编程服务用你的中转站 Key 验证身份（服务端只保存 Key 的哈希），手机和电脑用同一个 Key 才能互相看到。
- **文件夹白名单**：手机只能在「项目文件夹」列表里的文件夹（及子文件夹）发起任务；会解析符号链接、清理 `..`，Windows 上不区分大小写，防止绕过。
- **审批**：默认每条命令、每次改文件都要在手机或电脑上批准；10 分钟没人处理自动拒绝。“全部自动”会在界面上标红提示。
- **本地控制台只对本机开放**：只监听 `127.0.0.1:47831`；每次启动生成随机令牌，放在 HttpOnly + SameSite=Strict 的 Cookie 里；所有接口检查 Host（防 DNS 重绑定）和 Origin（防其他网站跨站调用）。
- **Key 的存储**：配置文件是明文 JSON，权限 0600（仅当前用户可读写），位于：
  - Windows：`%AppData%\SalcaraBridge\config.json`（在你的用户目录下，其他 Windows 用户无权读取）
  - macOS：`~/Library/Application Support/SalcaraBridge/config.json`
  - Linux：`~/.config/SalcaraBridge/config.json`

  我们没有做“混淆加密”——对同一用户下运行的程序那不是真正的保护，只会带来虚假的安全感。一键配置写入 Codex / Claude Code 配置文件的 Key 同样是明文，这和这些工具官方的做法一致。
- 日志文件 `bridge.log` 与配置在同一目录，超过 5 MB 自动轮换；Bridge 不会把 Key 写进日志。

## 卸载

1. 控制台「设置」里关闭 **开机自动启动**，然后点 **退出 Salcara Bridge**。
   （手动清理：Windows 删除注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `SalcaraBridge`；macOS 删除 `~/Library/LaunchAgents/top.salcara.bridge.plist`（旧版本是 `com.salcara.bridge.plist`），正在运行的可以用 `pkill -x SalcaraBridge` 退出；Linux 删除 `~/.config/autostart/salcara-bridge.desktop`。）
2. 如需还原工具配置，先在「工具配置」里点 **恢复原配置**。
3. 删除配置目录（见上面的路径）和程序文件本身（Mac：把 `~/Applications/Salcara Bridge.app` 拖到废纸篓）。

## 开发

```bash
go test ./...          # 单元测试 + 端到端测试（e2e/，会编译 ../hub；go test -short ./... 跳过它）
go vet ./...
./build.sh             # 编译所有平台到 ../dist/bridge/，并准备 ../dist/downloads/（VERSION=1.1.0 可覆盖）
../scripts/e2e.sh      # 只跑端到端测试，输出详细过程
```

`build.sh` 的产物：

| 文件 | 说明 |
|---|---|
| `SalcaraBridge-windows-{amd64,arm64}.exe` | Windows（GUI 子系统，不弹黑框） |
| `SalcaraBridge-macos-{arm64,amd64}` | macOS 单架构程序；Go 链接器会给 arm64 版加 ad-hoc 签名（Apple 芯片必须有签名才能运行） |
| `SalcaraBridge-macos-universal` | 通用程序，由 `tools/lipo`（纯 Go 实现的 `lipo -create`）合并，两个架构原样拷贝，签名保持有效 |
| `SalcaraBridge-macos.zip` | `tools/macbundle` 生成的 `Salcara Bridge.app`：`Info.plist`（`top.salcara.bridge`、`LSUIElement`、最低 macOS 11、访问文稿/桌面/下载时的说明文字）、通用程序、由 logo 绘制的 `AppIcon.icns`；zip 里保存了 Unix 权限，解压后可执行位还在 |
| `SalcaraBridge-linux-{amd64,arm64}` | Linux |
| `../dist/downloads/` | 上传到 Hub 下载目录的全部文件：上面的 zip / exe / Linux 程序 + `install-mac.sh`、`install-windows.ps1`（`install/` 目录里的模板）+ `SHA256SUMS.txt` |

命令行：

```
SalcaraBridge                    # 运行（已在运行则只打开控制台）
SalcaraBridge --background       # 后台运行，不打开浏览器（开机自启使用）
SalcaraBridge --relay URL        # 预先填好中转站地址（安装脚本使用；已经填过则忽略）
SalcaraBridge mcp-approval --port N --token T --session S   # Claude Code 权限询问助手（内部使用）
SalcaraBridge version
```

环境变量（测试或便携使用）：`SALCARA_BRIDGE_PORT`（控制台端口，默认 47831）、`SALCARA_BRIDGE_CONFIG_DIR`（配置、日志目录）、`SALCARA_NO_SHELL_PATH=1`（不读取登录 shell 的 PATH）。

端到端测试（`e2e/e2e_test.go`）会真的启动 Hub 和 Bridge：假的中转站（`/v1/usage` + 像 nginx 一样转发 `/salcara-hub/`）→ Hub ⇄ Bridge（按 macOS 开机自启的方式启动：PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`）→ 假的 `codex` / `claude`（`internal/testfake`，按 npm 的方式安装成 `#!/usr/bin/env node` 脚本，node 在另一个目录）。测试以“手机”的身份：查看设备和工具、通过控制台登录并添加项目、发起 Claude Code 和 Codex 任务、流式消息、批准 / 拒绝 / 本会话都允许、会话列表、继续对话、停止任务；最后通过 Hub 下载 `install-mac.sh`，用假的 macOS 命令跑一遍安装，检查 `.app` 解压后可执行。

目录结构：

| 路径 | 说明 |
|---|---|
| `main.go`、`main_darwin.go` | 入口、单实例、日志、组装各模块；macOS 上从访达启动时脱离 LaunchServices、从“下载”等位置自动安装到 `~/Applications` |
| `internal/config` | 配置文件读写 |
| `internal/hubclient` | 注册、SSE 长连接、命令分发、事件批量上传、项目文件夹校验 |
| `internal/console` | 本地控制台（`web/` 为内嵌的网页） |
| `internal/toolcfg` | Claude Code / Codex 配置文件编辑、Claude Desktop 检测 |
| `internal/autostart` | 开机自启（Windows 注册表 / macOS LaunchAgent / Linux XDG）、打开浏览器、在访达 / 资源管理器中显示 |
| `internal/macapp` | `Salcara Bridge.app` 自动安装到 `~/Applications` |
| `internal/relay` | 请求中转站 `/v1/usage` |
| `internal/applog` | 自动轮换的日志文件 |
| `internal/agents`、`internal/mcpapproval` | 驱动 Codex / Claude Code、读取会话记录、权限询问助手；`agents/pathenv.go` 负责 macOS / Linux 上的 PATH |
| `internal/testfake` | 测试用的假 Codex / Claude Code（`fakeagent` 可编译成独立程序） |
| `tools/lipo`、`tools/macbundle` | 打包工具：通用 Mach-O、`.app` + 图标 + zip |
| `install/` | `install-mac.sh`、`install-windows.ps1`（由 Hub 填好地址后提供下载） |
| `e2e/` | 端到端测试 |
