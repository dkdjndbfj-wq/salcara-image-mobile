# Salcara Hub

Salcara 远程编程的消息中转服务。部署在 sub2api 中转站旁边，挂在同一个域名的 `/salcara-hub/` 路径下。协议见 [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md)。

## 它做什么

- **鉴权**：手机 App 和电脑上的 Bridge 都用中转站 API Key 登录。Hub 拿这个 Key 请求 sub2api 的 `GET /v1/usage`，返回 200 就算有效用户。结果会缓存，有效的缓存 10 分钟，无效的缓存 1 分钟。
- **账号**：账号 ID = `hex(sha256(key))[:24]`。手机和电脑用同一个 Key 登录就是同一个账号，能看到彼此。Hub 不在内存、磁盘或日志里保存 Key 明文，缓存也只按 sha256 索引。
- **转发**：
  - 手机发来的命令（`/app/commands`）通过 SSE 推给对应电脑的 Bridge（`/bridge/stream`），然后等 Bridge 用 `/bridge/reply` 回复，最多等 45 秒。
  - Bridge 上报的事件（`/bridge/events`）由 Hub 编好 `seq` 并填上 `deviceId`，推给这个账号下所有打开的 App 连接（`/app/stream`）。事件同时放进缓存：每个账号保留最近 2000 条，每个会话保留最近 500 条。
- **设备**：Bridge 登记的设备信息保存在 `数据目录/devices.json`，写入时先写临时文件再重命名，保证不会写坏，文件权限是 0600。Bridge 的 SSE 连着就算在线。设备上线、下线或重新登记时，Hub 会给这个账号的 App 推一条 `device` 事件。
- **不碰模型流量**：Codex 和 Claude Code 的请求由电脑直接发给中转站，照常计费。Hub 只转发控制消息。
- **提供安装包下载**（v1.1）：`/salcara-hub/download/<文件>` 不需要 Key，直接返回下载目录里的文件。Mac 用户一行命令安装：`curl -fsSL https://你的域名/salcara-hub/download/install-mac.sh | bash`（见下文“安装包下载”）。

## 为什么不做成 sub2api 插件

sub2api 现在的插件协议只有一种能力：`openai.oauth.outbound_transport.v1`，也就是 OpenAI OAuth 账号的出站转发。宿主只处理这一种能力，插件声明别的能力也不会产生新路由（见 sub2api `docs/PLUGIN_DEVELOPMENT.md`）。插件不能新增 HTTP 路由，不能做 SSE 或 WebSocket 长连接，也不能处理 Claude 流量，所以装不下远程编程需要的这些接口。

因此 Hub 做成一个独立的小服务，跟 sub2api 部署在一起，只调用 sub2api 公开的 `/v1/usage` 接口来验证 Key，不需要改 sub2api 的代码。

## 编译

只用 Go 标准库，没有第三方依赖。需要 Go 1.22 或更高版本。

```bash
cd remote/hub
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o salcara-hub-linux-amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o salcara-hub-linux-arm64 .
```

编译好的二进制在 `remote/dist/hub/` 下。

## 配置

每一项都可以用命令行参数或环境变量设置，两个都给时以命令行参数为准。

| 环境变量 | 参数 | 默认值 | 说明 |
|---|---|---|---|
| `SALCARA_HUB_ADDR` | `-addr` | `127.0.0.1:8787` | 监听地址。放在 nginx 后面时保持只监听本机 |
| `SUB2API_URL` | `-sub2api` | `http://127.0.0.1:8080` | sub2api 地址，Hub 会请求它的 `/v1/usage` |
| `SALCARA_HUB_DATA` | `-data` | `./data` | 数据目录，里面放 `devices.json`。设成空字符串就不保存 |
| `SALCARA_HUB_PREFIX` | `-prefix` | `/salcara-hub` | 对外路径前缀。不带前缀的 `/v1/...` 也能访问 |
| `TRUST_PROXY` | `-trust-proxy` | `false` | 设成 `true` 时，用 `X-Forwarded-For` 最右边的 IP 作为客户端 IP（限流和日志），并用 `X-Forwarded-Proto` / `X-Forwarded-Host` / `X-Forwarded-Prefix` 生成安装脚本里的地址。只有放在 nginx 后面时才打开 |
| `SALCARA_HUB_DOWNLOADS` | `-downloads` | `数据目录/downloads` | 安装包目录，`/download/<文件>` 从这里取文件。数据目录为空且没设置这一项时，下载接口关闭（返回 404） |
| `SALCARA_HUB_PUBLIC_URL` | `-public-url` | 空 | 对外的 Hub 地址，如 `https://relay.example.com/salcara-hub`。设置后安装脚本一律用它，不再从请求头推断（nginx 配置不方便改时最省事） |
| `SALCARA_HUB_COMMAND_TIMEOUT` | `-command-timeout` | `45s` | `/app/commands` 等电脑回复的最长时间 |
| `SALCARA_HUB_LOG_FORMAT` | `-log-format` | `json` | 日志格式，`json` 或 `text`。日志会记录路径、状态码、IP 和账号 ID，不会记录 Key |

其他限制：

- 同一个 IP 1 分钟内验证失败 20 次后，这个 IP 会收到 429，直到这 1 分钟结束。已经缓存为有效的 Key 不受影响。
- 请求体上限：`/bridge/events` 和 `/bridge/reply` 是 2 MB，其他接口是 256 KB。
- 每个账号最多登记 50 台电脑，最多同时开 32 个 App 连接，最多缓存 300 个会话。
- SSE 每 20 秒发一次 `: ping` 保活，并带上 `X-Accel-Buffering: no` 响应头。

`salcara-hub -version` 会打印版本号。

## 用 systemd 运行

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin salcara-hub
sudo install -m 0755 salcara-hub-linux-amd64 /usr/local/bin/salcara-hub
sudo cp deploy/salcara-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now salcara-hub
journalctl -u salcara-hub -f

# 上传安装包（在仓库里先运行 bridge/build.sh，生成 remote/dist/downloads/）
sudo install -d -m 0755 -o salcara-hub -g salcara-hub /var/lib/salcara-hub/downloads
sudo cp remote/dist/downloads/* /var/lib/salcara-hub/downloads/
sudo chmod 0644 /var/lib/salcara-hub/downloads/*
curl -I https://你的域名/salcara-hub/download/SalcaraBridge-macos.zip   # 200 就对了
```

更新安装包时直接覆盖这些文件即可，不用重启 Hub。

`deploy/salcara-hub.service`：

```ini
[Unit]
Description=Salcara Hub (远程编程消息转发)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=salcara-hub
Group=salcara-hub
Environment=SALCARA_HUB_ADDR=127.0.0.1:8787
Environment=SUB2API_URL=http://127.0.0.1:8080
Environment=SALCARA_HUB_DATA=/var/lib/salcara-hub
Environment=TRUST_PROXY=true
Environment=SALCARA_HUB_DOWNLOADS=/var/lib/salcara-hub/downloads
# Environment=SALCARA_HUB_PUBLIC_URL=https://relay.example.com/salcara-hub
ExecStart=/usr/local/bin/salcara-hub
Restart=always
RestartSec=3
StateDirectory=salcara-hub
StateDirectoryMode=0700
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/salcara-hub
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

收到 SIGTERM 时 Hub 会先结束所有 SSE 连接和还在等待的命令，把 `devices.json` 写入磁盘，然后再退出。

## Docker

镜像基于 `distroless/static`，里面只放静态二进制：

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o salcara-hub .
docker build -t salcara-hub .
docker run -d --name salcara-hub --restart=always \
  -e SUB2API_URL=http://sub2api:8080 -e TRUST_PROXY=true \
  -v salcara-hub-data:/data -p 127.0.0.1:8787:8787 \
  --network <sub2api 所在的网络> salcara-hub
```

容器里默认监听 `0.0.0.0:8787`，数据放在 `/data`，安装包放在 `/data/downloads`（例如 `docker cp remote/dist/downloads/. salcara-hub:/data/downloads/`，或者再挂一个卷到 `/data/downloads`）。

## nginx 转发

加在 sub2api 所在的 `server {}` 里：

```nginx
location /salcara-hub/ {
    proxy_pass http://127.0.0.1:8787/salcara-hub/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;            # SSE 必须关闭缓冲
    proxy_read_timeout 3600s;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}
```

放在 nginx 后面时要设置 `TRUST_PROXY=true`，否则所有请求都会被当成来自 127.0.0.1，限流会把所有用户算在一起。

`X-Forwarded-Proto` / `X-Forwarded-Host` 用来生成安装脚本里的下载地址：少了它们，脚本里会是 `http://127.0.0.1:8787/...`，用户电脑上就下载不了。如果 nginx 把 `/salcara-hub` 前缀去掉了再转发（`proxy_pass http://127.0.0.1:8787/;`），再加一行 `proxy_set_header X-Forwarded-Prefix /salcara-hub;`。也可以不管这些头，直接设置 `SALCARA_HUB_PUBLIC_URL`。

安装包比较大，nginx 默认的 `proxy_buffering off` 对下载没有影响；如果想让 nginx 直接发文件、不经过 Hub，也可以：

```nginx
location /salcara-hub/download/ {
    alias /var/lib/salcara-hub/downloads/;   # 注意：这样 install-mac.sh 里的地址不会被替换，
    # 需要自己把 {{SALCARA_BASE_URL}} / {{SALCARA_RELAY_URL}} 改成真实地址后再放进去
}
```

## 安装包下载

`bridge/build.sh` 会生成 `remote/dist/downloads/`，把整个目录复制到 Hub 的下载目录（见上面 systemd 一节）。之后：

| 用户 | 命令 / 链接 |
|---|---|
| macOS（推荐） | `curl -fsSL https://你的域名/salcara-hub/download/install-mac.sh \| bash` |
| Windows | PowerShell：`irm https://你的域名/salcara-hub/download/install-windows.ps1 \| iex`，或直接下载 `https://你的域名/salcara-hub/download/SalcaraBridge-windows-amd64.exe` |
| Linux | `https://你的域名/salcara-hub/download/SalcaraBridge-linux-amd64` |

为什么 Mac 推荐 `curl | bash`：浏览器下载的、没有经过苹果公证的 App 会带“隔离”标记，打开时提示“已损坏”或“无法验证开发者”；`curl` 下载的文件没有这个标记，脚本还会再用 `xattr` 清一次，所以不会被拦截。脚本做的事：检查系统版本 → 下载 `SalcaraBridge-macos.zip`（通用版，Apple 芯片和 Intel 都能用）→ 解压到 `~/Applications`（不需要管理员密码）→ 打开程序并自动填好中转站地址。

下载接口的安全限制：只返回下载目录里的普通文件（文件名只能是字母、数字、`.`、`_`、`-`），不能访问子目录、隐藏文件、符号链接或 `..`。`.sh` / `.ps1` 是模板，`{{SALCARA_BASE_URL}}` 和 `{{SALCARA_RELAY_URL}}` 会按请求替换成真实地址（域名、协议、前缀都会校验，防止被注入到脚本里）。

## 冒烟测试

```bash
HUB_URL=https://你的域名/salcara-hub KEY=sk-xxx ./scripts/smoke.sh
```

脚本会依次检查：`/v1/ping`；不带 Key 和带错误 Key 时 `/v1/me` 返回 401；带正确 Key 时 `/v1/me` 和 `/v1/app/devices` 返回 200；`/v1/app/stream` 能收到 SSE；`/download/install-mac.sh` 里的地址是不是公网地址。如果 SSE 这一项失败，通常是 nginx 没有设置 `proxy_buffering off`。

完整的端到端测试（Hub + Bridge + 假的 Codex / Claude Code + 安装脚本）：`remote/scripts/e2e.sh`。

## 协议里没写清楚、这里定下来的细节

- **CommandEnvelope**：Bridge 在 SSE 里收到的是 `{ "commandId", "deviceId", "command": Command, "ts" }`，和 `bridge/internal/protocol` 里的定义一致，`ts` 是额外加的字段。
- **seq**：每个账号的起点是“Hub 启动时的毫秒时间戳 × 1000”，之后逐条加 1。这样 Hub 重启后 seq 仍然比之前的大，不会跟 App 手里的 `after` 冲突，而且小于 2^53，JavaScript 能精确表示。如果 App 传的 `after` 比当前 seq 还大，Hub 会从头补发缓存里的全部事件。
- **App 连上 `/app/stream` 时**：先为每台设备发一条 `device` 事件，再补发 `seq > after` 的缓存事件，然后推实时消息。也支持用 `Last-Event-ID` 请求头代替 `after`。
- **事件**：Hub 会覆盖 Bridge 发来的 `seq` 和 `deviceId`，事件没有 `ts` 时补上当前时间。`type` 必填。没有 `sessionKey` 的事件（比如 `notice`）只进账号级缓存。`/bridge/events` 返回 `{ ok, accepted, lastSeq }`。
- **错误码**：
  - 设备没有登记：`/app/commands` 返回 404“找不到这台电脑”；`/bridge/stream` 和 `/bridge/events` 返回 404，提示先调用 `/bridge/register`。
  - 设备已登记但不在线：409“电脑不在线”。
  - 等回复超时：504“电脑没有响应”。
  - Bridge 回复了 `ok:false` 但没有写 `error`：Hub 填上“电脑执行失败”。
  - 命令已经超时或被别的账号回复：`/bridge/reply` 返回 404。
  - Bridge 的命令队列满了：503。
- **Bridge 断线时正在等待的命令**：继续等到超时，不会马上报错。因为回复走单独的 `/bridge/reply`，Bridge 重新连上后仍然可以回复。
- **sub2api 的返回**：200 算有效，401 或 403 算无效（无效也会缓存）。其他情况都返回 502“暂时无法连接中转站验证 Key”，而且不缓存，也不计入失败次数。这些情况包括网络错误、5xx，以及 sub2api 自己限流返回的 429。
- **同一台电脑重复连接**：同一个 deviceId 同时只保留一个 Bridge SSE，新连接会顶掉旧连接。同一个账号可以同时开多个 App 连接。App 连接接收太慢、队列（512 条）满了时，Hub 会断开它，App 重连时带上 `after` 就能补齐。
