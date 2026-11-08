# 远程侧边栏：轻量文件与网站链接

本轮范围仅是会话侧边栏的小型只读文件查看和远程消息链接处理。不更换桌面或手机的整体布局、动效，不实现文件编辑、下载、Office/PDF/压缩包预览、终端或通用端口代理。未提交、发布或部署。

## 与之前功能的区别

之前的 `RemoteSidebar` 是会话/子智能体目录；会话里的图片附件及代码差异并不是文件浏览器。本次文件查看独立于模型推理、图片附件、发送回执和任务执行，不会为了打开文件创建或恢复 Agent 任务。

## 文件协议与边界

- Bridge 广播 `workspace.files.v1`。旧版电脑不支持时，手机不猜测权限，也不发送新命令。
- `workspace.files.list/read` 必须带精确 `sessionKey`、明确 `controlSurface`、冻结的 `expectedCwd` 和项目内相对 `path`。`expectedCwd` 只用于比较真实会话目录，不能指定读取根目录、也不拿它做 Stat/Eval；会话在请求到达前已经 A→B 换目录时也拒绝旧请求。
- 项目根目录由电脑配置的项目列表和该会话的真实 cwd 共同确定。本版只接受二者精确匹配；不是“会话碰巧提到某个路径”就可以读取。
- 原生 Codex 桌面读取还需要当前宿主的精确会话授权；无法授权时不会改走 CLI。Claude Desktop 的只读聊天没有经过验证的项目根目录，因此默认不开放文件入口。
- 目录按需手动分页，每页最多 50 项，不递归扫描。只读 UTF-8 代码/文本，小文件上限 128 KiB；其他类型默认不提供查看。
- 隐藏目录、已知凭据路径/文件、依赖/构建产物、越界路径及符号链接别名受到限制；实现须检查打开后的实际文件句柄，而不是只做字符串前缀判断。
- 内容只存在本次文件查看的内存中，不加入对话、Hub 事件历史、发送回执或手机持久缓存；关闭、切站、解绑、切会话、失去授权或进入后台时撤销读取。
- 文件内容是数据，不执行 HTML/JavaScript，不用 Markdown 将源文件中的指令或链接自动激活。
- 文件名规则不能识别所有秘密：如果用户在普通代码/文本文件中写了秘密，它仍可能被本人的配对手机读取。配置项目根目录意味着授权读取这个范围内的允许类型文件，不是内容级 DLP。
- Windows/Linux 才广播文件能力，其他平台默认关闭。Windows 拒绝 UNC、设备路径和网络盘；项目/会话还比较真实目录身份，不以 `EqualFold` 代替授权。打开后及返回前复核根目录和文件句柄；链接、硬链接别名不放行。
- 游标绑定会话、执行面、目录、目录版本，完整校验 `v/o/r`；每次目录最多扫描 4096 项。不是全盘目录、搜索或后台文件索引。
- Codex CLI 的旧会话用 `thread/read includeTurns:false` 精确 metadata；Claude Code 精确读取单 transcript 的 64 KiB 头和 256 KiB 尾，只取 cwd/session/entrypoint，不映射完整消息。失败不退回完整历史。旧扩展适配器未实现 optional metadata 接口时，保留其已有有界目录限制。
- 手机代码查看纵向虚拟化、长行可横向滑动；最多显示 4000 行、单行 2000 字符，超过时明确提示，不为显示去读更大文件。刷新保持当前文件/目录，分页手动触发，去重为线性合并。
- 文件位置中的行号可高亮并定位；列号按等宽字符宽度近似横向定位，不承诺不同手机字体下精确到像素。
- 文件读取不带请求 UUID；Hub 对显式 `requestId` 拒绝文件读回执，防止把文本写入持久化命令回执。正常配对鉴权仍保留，不能以文件命令绕过封禁或访问其他电脑。

## 主对话中的链接

- 复用原 Markdown 样式，增加远程专用 action；主回复、表格、粗体里的链接、来源 citation 和保守识别的行内代码路径均可点击。围栏代码块不激活。展开后的工具输出只激活显式 HTTP(S)，不把命令或路径当作可执行操作。
- 支持文件绝对/相对路径、Windows 盘符、`:行[:列]` / `#L行[C列]`，含空格/括号路径用 Markdown `<...>` 包裹。绝对路径只可映射当前会话根目录内的相对路径；Windows 仅盘符忽略大小写，避免大小写敏感项目误指。读取最终仍由电脑物理根授权。
- 主对话有精确会话归属才能定位文件。链接解析那一刻同时冻结 cwd、sessionKey、surface，防点击→查看器建立之间切目录后误读同名文件；嵌入的子智能体摘要没有可靠 cwd 时，不使用主对话 cwd，先进入子会话，再点其文件。文件改动已有 diff 仍走原 diff；无 diff 的文件引用可以进入只读文件页。
- 当前正文文件 action 不做自动目录判断：目录通过侧边栏文件 tab 按需进入；显式目录超链接不保证可打开，不为猜类型递归扫描或重新定位文件。
- `codex://threads/<id>` 只定位同一配对电脑的 Codex 任务到侧边栏，未知任务用中性“关联任务”，点选后才读取；链接不构成宿主授权。原生入口始终保留 desktop 执行面，授权消失不合并 CLI 请求或展示 CLI 缓存。
- 同 UUID 一旦在当前凭据代明确选择原生执行面，本地 `readSurface` 保持隔离；首次读取失败、授权过期也不自动降级。它不是宿主权限证明，切凭据时清除。当前 Hub 增量事件来自 CLI，不能覆盖原生目录或混入原生时间线；原生快照回包再次检查 surface 与 lease，原生内容不进入本地会话缓存。仅本地已成功的桌面审批回执可更新其审批卡片，普通 Hub 事件不能借此绕过隔离。未来原生流需独立可信来源契约。
- `codex://threads/new`、设置/插件安装链接、任意外部任务控制、`file://` / `vscode://` / `javascript:` 等不自动执行。没有拿到真实来源任务字段时，不编造委派来源跳转。
- 裸文件名只指当前根目录，不递归猜测；`a/`、`b/` 不擅自剥离，避免 diff 前缀与真实目录歧义。带任意 Markdown 标题参数、转义括号等不是完整通用 Markdown URL 解析器；不支持时留作普通文本/未开放链接。

对照依据：[Codex 链接命令](https://learn.chatgpt.com/docs/reference/commands)、[Codex 文件引用格式](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)。这些资料决定了任务 scheme 与文件位置语法，不代表本软件具有所有 Codex 宿主能力。

## 网站

公网 HTTP(S) 链接交给手机系统 URL 处理器（通常为浏览器），不引入 WebView。禁止非 HTTP(S)、URL 用户信息及明显的回环/私网本地服务地址；本地地址不假装是电脑可达的公网链接。

这是浏览器路由的字面地址分类，不是 DNS 可达性证明或 SSRF 防线；不会替用户请求网址、下载网站内容、加入 Salcara 凭据。公网域名实际解析为局域网地址仍由手机网络和浏览器处理。

`localhost` 指的是打开链接的那台设备：在手机打开它并不会访问电脑。当前 Hub 没有网页隧道、浏览器会话或安全预览数据面。文件只读能力不等于可以运行网站。

后续本机网站的建议是显式、默认关闭的**临时预览**，而不是通用转发：

1. 用户明确选择一个固定电脑回环端口，绑定精确会话、电脑、手机及站点；不扫描端口。
2. 独立预览 origin 隔离项目脚本与 Hub 管理页/其他项目。
3. 30 秒单次启动票据通过 fragment 引导页面 POST 换取短期 HttpOnly/Secure cookie；API Key、Pair Token 不进入网页或 URL。
4. 固定上游 `127.0.0.1`/`::1`，拒绝 DNS、跨主机跳转、环境代理和 CONNECT；不向上游转发手机 Cookie/Authorization。
5. 有界 GET/HEAD、短 TTL、并发/总流量限制、解绑/切站撤销。即使 GET 也可能触发服务副作用，因此创建共享不属于无需确认的文件只读命令。
6. SPA 根路径资源、HMR WebSocket、POST、上传及长流需要另外的协议支持；当前没有实现，不承诺所有本地网站可用。

依据：[React Native Linking](https://reactnative.dev/docs/linking)、[Go ReverseProxy](https://pkg.go.dev/net/http/httputil)。

## 复核修复与验收边界

独立复核促成的实际窄修：缺字段游标拒绝、返回前再次验证根目录、Windows 大小写敏感目录物理身份、旧会话 exact metadata、请求到达前 cwd 变化、链接点击到 viewer capture 间 cwd/session/surface 变化、原生读取授权消失后的 CLI 降级与混流隔离。文件预览与网站路由均不触发模型推理。

不是完整 Codex 复刻：每个子代理专属头像、真实委派来源 task 字段、@ 引用、Steer、Side Chat、原生归档/重命名、主动压缩等仍按 [能力核对表](REMOTE-CONVERSATION-FEATURE-AUDIT-20261011.md) 区分。这里只补用户本轮要求的轻量文件/链接及必须的隔离，不把未开放宿主能力冒充实现。

## 验证记录

- 最终手机候选：`npm run typecheck` exit 0；`npm test -- --silent` **87 套件、1326 项通过，8 套件/8 项既有测试跳过，1334 项总数**，127.776 秒。包含真实 `MessageContent` 链接渲染、文件查看、读者授权、native/CLI 隔离、普通 CLI 与 Claude Desktop 只读历史、发送回执和退役机制。
- 全量验证前后用 `rg --files src modules` 排序后逐文件 SHA-256 再聚合：316 文件，均为 `0e7d40ecb5df2caf58b8ae54eac441b53427d5d4827a5d41ee2fe9c788c313dd`。源码没有在验证中改变；文档不计入该源码快照。没有沿用旧 1157 项结果作为本轮验收。
- Bridge 最后聚焦 `TestWorkspaceFiles|TestCodexSessionMetadata|TestClaudeSessionMetadata` 的 race 运行 exit 0：hubclient 13.109 秒、agents 2.449 秒。覆盖 19 组文件内核与 11 组精确 metadata 测试；Windows 两项根目录替换子测试因打开句柄阻止 rename 而跳过，不把它们算成已执行场景。
- 此前本轮相关整包 race 已通过：hubclient 27.037 秒、agents 141.262 秒；这两包 vet 通过。随后协调任务完成最终 Bridge 稳定候选：1038 个源码文件前后摘要一致，`a1ac22c0cabe1a0bca60428be250e20991245d2356a7a3b9b8804ce40b06f2b8`；全量 `go test -race -p 1 ./...` exit 0，21 个有测试包通过、6 个无测试包，717 个主测试通过、8 个主测试跳过、0 失败；vet、build、diff check 通过。这是协调任务的执行结果，包含本轮 files/exactmetadata，详见 [反代最终验收记录](../../../salcara-desktop/remote/bridge/docs/PROXY-AGGREGATION-CONTINUATION-20261011.md)。真实账号、原生来源证明及平台跳过不因此视作已验收。
- Hub 本轮文件策略专项通过；整包 `go test ./...` exit 0（hub 8.176 秒、standalone 25.221 秒等）；`internal/hub` race 24.520 秒，`go vet ./...` exit 0。文件命令拒绝持久化回执、未配对拒绝及三种来源策略下的配对读取均有回归。
- 手机、Bridge、Hub 的 tracked diff whitespace 检查通过；本轮新增源文件另检尾随空白与冲突标记，0 问题。两项独立复核覆盖文件内核、物理根、元数据失败关闭及 native/CLI 事件隔离，发现的问题已修并回归。
- Linux 文件路径实现仅完成编译检查，没有 Linux 实机运行验收；Android 真机触摸/字体定位、系统浏览器路由及实际 Codex Desktop 插件授权尚未验收。测试使用合成文件、会话和 RPC，不读取真实密钥/聊天，不调用付费模型，不安装或修改用户实际 Codex。

本轮文件归属：手机新增 `RemoteFiles.tsx`、`workspace-files.ts`、`remote-links.ts` 和五个文件/链接/原生隔离测试，窄接入 `RemoteSidebar`、`ThreadView`、`MessageContent`、`thread-rows`、`thread-extras`、`client.ts` 与 `store.ts`；Bridge 新增 `workspace_files*`、optional `session_metadata*` / Codex / Claude 实现，接入 dispatch 和能力广播；Hub 仅增加文件只读命令策略、禁止文件持久回执与专项测试。保留其他用户/协调任务修改，不提交、发布或部署。
